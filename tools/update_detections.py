#!/usr/bin/env python3
"""Update data/detections.json from OFFICIAL sources only. Run twice a day (see .github/workflows/update-detections.yml).

Sources (all government):
  * USDA APHIS  - wild-bird detections table (CSV), county level
  * Maryland Dept. of Agriculture (MDA) - press releases
  * Delaware Dept. of Agriculture (DDA) - news feed
  * Virginia Dept. of Agriculture and Consumer Services (VDACS) - news releases (best effort)
  * data/curated_detections.json - detections entered/approved by MDA staff (always wins over automatic ones)

Standard library only. Every source is optional: if one is unreachable the previous values are kept and the
source is listed under "problems" so a stale feed is visible instead of silently empty.
"""
import csv, hashlib, io, json, os, re, sys, urllib.request, urllib.error, datetime as dt
from html import unescape
from xml.etree import ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "detections.json")
CURATED = os.path.join(ROOT, "data", "curated_detections.json")
POINTS = json.load(open(os.path.join(ROOT, "tools", "county_points.json")))

WILD_CSV = "https://www.aphis.usda.gov/sites/default/files/hpai-wild-birds.csv"
MAMMAL_CSV = "https://www.aphis.usda.gov/sites/default/files/hpai-mammals.csv"
MDA_LIST = "https://mda.maryland.gov/news/press-releases"
# extra MDA pages to look at, because the release list can lag days behind new releases
MDA_EXTRA = [MDA_LIST + "?page=1", "https://mda.maryland.gov/Pages/AvianFlu.aspx", "https://mda.maryland.gov/news"]
DDA_FEEDS = ["https://news.delaware.gov/tag/avian-influenza/feed/", "https://news.delaware.gov/category/agriculture/feed/"]
VDACS_LISTS = ["https://www.vdacs.virginia.gov/news.shtml", "https://www.vdacs.virginia.gov/press-releases.shtml"]
WILD_DAYS, WILD_YEAR, NOTICE_DAYS, KEEP_NOTICES = 28, 365, 120, 12
FLYWAY = {"Maine", "New Hampshire", "Vermont", "Massachusetts", "Rhode Island", "Connecticut", "New York", "New Jersey", "Pennsylvania", "Delaware",
          "Maryland", "Virginia", "West Virginia", "North Carolina", "South Carolina", "Georgia", "Florida"}   # Atlantic Flyway states

MD = ["Allegany", "Anne Arundel", "Baltimore", "Calvert", "Caroline", "Carroll", "Cecil", "Charles", "Dorchester", "Frederick", "Garrett", "Harford", "Howard", "Kent",
      "Montgomery", "Prince George's", "Queen Anne's", "St. Mary's", "Somerset", "Talbot", "Washington", "Wicomico", "Worcester"]
DE = ["Kent", "New Castle", "Sussex"]
VA = ["Accomack", "Northampton"]
STATE_OF = {"Maryland Department of Agriculture": ("Maryland", MD), "Delaware Department of Agriculture": ("Delaware", DE),
            "Virginia Department of Agriculture and Consumer Services": ("Virginia", VA)}
KW = re.compile(r"avian influenza|\bHPAI\b|\bH5N1\b|bird flu", re.I)
UA = {"User-Agent": "Mozilla/5.0 (compatible; MD-HPAI-map/1.0; +https://github.com/madhusudan9524/md-hpai-tool)"}
problems = []


def get(url, binary=False, timeout=40):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return raw if binary else raw.decode("utf-8-sig", "replace")


def clean(s):
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


MONTHS = "January February March April May June July August September October November December".split()
DATE_RE = re.compile(r"(" + "|".join(MONTHS) + r")\s+(\d{1,2}),\s+(\d{4})")


def find_date(text):
    m = DATE_RE.search(text or "")
    return dt.date(int(m.group(3)), MONTHS.index(m.group(1)) + 1, int(m.group(2))) if m else None


# ---------- classification of a notice (pure functions, unit-tested) ----------
def classify(title, body, source):
    """Return dict(kind, status, county, state) or None when the item is not about a detection."""
    text = f"{title}. {body}"
    state, counties = STATE_OF.get(source, (None, MD + DE + VA))
    hit = [c for c in counties if re.search(rf"\b{re.escape(c)}\b(?:\s+County)?", text)]
    # the first county named in the headline wins, otherwise the first in the body
    county = next((c for c in hit if re.search(rf"\b{re.escape(c)}\b", title)), hit[0] if hit else None)
    t = text.lower()
    detect = bool(re.search(r"detect|confirm|positive|tested|test results|identified", t))
    kind = "commercial" if re.search(r"commercial|broiler|layer|turkey|breeder|poultry farm|poultry operation", t) else \
           "backyard" if re.search(r"backyard|non-commercial|hobby", t) else \
           "wild" if re.search(r"wild bird|snow geese|waterfowl|goose|geese|duck|swan|eagle|vulture|wildlife", t) else "general"
    status = "confirmed" if re.search(r"\bconfirm(ed|s|ing)? (the )?(presence|case|detection)|\busda\b.*\bconfirm", t) else \
             "preliminary" if re.search(r"preliminar|presumptive", t) else None
    return {"kind": kind if detect and county else "general", "status": status, "county": county, "state": state}



# ---------- AI reading of a release (Claude API); falls back to the keyword rules ----------
AI_MODEL = os.environ.get("HPAI_AI_MODEL", "claude-haiku-5-5")
AI_PROMPT = """You read official state agriculture press releases about avian influenza on the Delmarva Peninsula.
Return ONLY a JSON object with these keys:
  is_detection: true if the release announces a new HPAI / avian influenza detection (not just advice or a reminder)
  kind: "commercial", "backyard", "wild" or "general"
  status: "confirmed" (USDA/NVSL confirmed), "preliminary" (state lab, presumptive or preliminary positive) or null
  state: "Maryland", "Delaware" or "Virginia"
  county: county name without the word County, or null
  flock_type: e.g. "Commercial broiler", "Commercial layer", "Backyard", or null
  birds: number of birds affected as an integer, or null
  detection_date: YYYY-MM-DD of the detection or announcement, or null
  summary: one plain sentence, under 25 words, in your own words
Use only facts stated in the release. If something is not stated, use null."""


def ai_extract(title, body, source):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", method="POST", headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        data=json.dumps({"model": AI_MODEL, "max_tokens": 1200, "system": AI_PROMPT,
                         "messages": [{"role": "user", "content": f"Source: {source}\nTitle: {title}\n\nRelease text:\n{body[:6000]}\n\nAnswer with the JSON object only."}]}).encode())
    text = ""
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read().decode())
            text = "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text") or json.dumps(resp)[:200]
        return validate_ai(json.loads(text[text.find("{"): text.rfind("}") + 1]), source)
    except urllib.error.HTTPError as e:
        problems.append(f"AI reading failed ({e.code}: {e.read().decode()[:200]}); used keyword rules")
    except Exception as e:
        problems.append(f"AI reading failed for '{title[:50]}': {e}; reply began {text[:80]!r}; used keyword rules")
    return None


def validate_ai(j, source):
    """Keep only values we can check: known state/county, allowed words, real dates."""
    lists = {"Maryland": MD, "Delaware": DE, "Virginia": VA}
    state = j.get("state") if j.get("state") in lists else STATE_OF.get(source, (None,))[0]
    county = (j.get("county") or "").replace(" County", "").strip() or None
    if county and state and county not in lists[state]:
        county = None
    kind = j.get("kind") if j.get("kind") in ("commercial", "backyard", "wild", "general") else "general"
    status = j.get("status") if j.get("status") in ("confirmed", "preliminary") else None
    try:
        date = dt.date.fromisoformat(j.get("detection_date")).isoformat() if j.get("detection_date") else None
    except Exception:
        date = None
    birds = j.get("birds") if isinstance(j.get("birds"), int) and j.get("birds") >= 0 else None
    if not j.get("is_detection"):
        kind = "general"
    return {"kind": kind if county or kind == "general" else "general", "status": status, "county": county, "state": state,
            "flock_type": (j.get("flock_type") or None), "birds": birds, "ai_date": date, "summary": (j.get("summary") or "")[:200], "method": "ai"}

# ---------- sources ----------
def parse_us_date(v):
    return dt.datetime.strptime((v or "").split(" ")[0], "%m/%d/%Y").date()


def wild_birds(today, raw=None):
    """Delmarva wild-bird detections from the last 12 months, plus the Atlantic Flyway monthly pattern (Jan..Dec)."""
    raw = raw if raw is not None else get(WILD_CSV)
    rows = list(csv.DictReader(io.StringIO(raw)))
    out, season = [], [0] * 12
    for r in rows:
        st, co = r.get("State", ""), (r.get("County", "") or "").replace(" County", "")
        try:
            coll = parse_us_date(r.get("Collection Date") or r.get("Date Detected"))
            if st in FLYWAY:
                season[coll.month - 1] += 1
        except Exception:
            pass
        if st not in ("Maryland", "Delaware", "Virginia") or (st == "Virginia" and co not in VA):
            continue
        try:
            d = parse_us_date(r.get("Date Detected") or r.get("Collection Date"))
        except Exception:
            continue
        if f"{st}|{co}" not in POINTS:
            continue
        lon, lat = POINTS[f"{st}|{co}"]
        h = int(hashlib.md5(f"{st}{co}{r.get('Bird Species')}{d}{len(out)}".encode()).hexdigest()[:6], 16)   # small stable offset so dots in one county do not stack
        out.append({"state": st, "county": co, "species": r.get("Bird Species", ""), "date": d.isoformat(), "strain": r.get("HPAI Strain", ""),
                    "lon": round(lon + ((h % 1000) / 1000 - .5) * 0.12, 5), "lat": round(lat + (((h // 1000) % 1000) / 1000 - .5) * 0.09, 5),
                    "source": "USDA APHIS"})
    out.sort(key=lambda x: x["date"], reverse=True)
    return out, season


def mammals():
    """All Delmarva HPAI detections in wild (and captive) mammals, USDA APHIS."""
    rows = list(csv.DictReader(io.StringIO(get(MAMMAL_CSV))))
    out = []
    for r in rows:
        st, co = r.get("State", ""), (r.get("County", "") or "").replace(" County", "").rstrip("0123456789")
        if st not in ("Maryland", "Delaware", "Virginia") or (st == "Virginia" and co not in VA) or f"{st}|{co}" not in POINTS:
            continue
        try:
            d = parse_us_date(r.get("Date Detected") or r.get("Date Collected"))
        except Exception:
            continue
        lon, lat = POINTS[f"{st}|{co}"]
        h = int(hashlib.md5(f"m{st}{co}{r.get('Species')}{d}{len(out)}".encode()).hexdigest()[:6], 16)
        out.append({"group": "mammal", "state": st, "county": co, "species": r.get("Species", ""), "date": d.isoformat(), "strain": r.get("HPAI Strain", ""),
                    "lon": round(lon + ((h % 1000) / 1000 - .5) * 0.12, 5), "lat": round(lat + (((h // 1000) % 1000) / 1000 - .5) * 0.09, 5), "source": "USDA APHIS"})
    return sorted(out, key=lambda x: x["date"], reverse=True)


def mda_notices():
    html = get(MDA_LIST)
    for u in MDA_EXTRA:
        try:
            html += get(u)
        except Exception:
            pass
    links = re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S)
    seen, out = set(), []
    for href, label in links:
        title = clean(label)
        slug = href.rsplit("/", 1)[-1].replace("-", " ")
        # match the headline, or the address of the release (/news/press-releases/<slug>) when the link text is short
        full = href if href.startswith("http") else "https://mda.maryland.gov" + href
        # only MDA's own news and press-release pages (not links out to CDC, USDA, or PDFs)
        if not full.startswith("https://mda.maryland.gov/") or "/news/" not in full or full.lower().endswith(".pdf"):
            continue
        if not (KW.search(title) or KW.search(slug)) or href in seen:
            continue
        title = title if KW.search(title) else slug.capitalize()
        seen.add(href)
        url = href if href.startswith("http") else "https://mda.maryland.gov" + href
        try:
            page = get(url)
        except Exception as e:
            problems.append(f"MDA article {url}: {e}"); continue
        body = clean(re.sub(r"(?is)<(script|style|nav|header|footer).*?</\1>", " ", page))[:6000]
        out.append({"title": title, "url": url, "date": (find_date(body) or dt.date.today()).isoformat(), "body": body[:1500], "source": "Maryland Department of Agriculture"})
        if len(out) >= 8:
            break
    return out


def rss_items(url, source):
    root = ET.fromstring(get(url, binary=True))
    out = []
    for it in root.iter("item"):
        title, link, desc = clean(it.findtext("title")), (it.findtext("link") or "").strip(), clean(it.findtext("description"))
        pub = it.findtext("pubDate") or ""
        try:
            d = dt.datetime.strptime(pub[:25].strip(), "%a, %d %b %Y %H:%M:%S").date()
        except Exception:
            d = dt.date.today()
        if KW.search(title + " " + desc):
            out.append({"title": title, "url": link, "date": d.isoformat(), "body": desc, "source": source})
    return out


def vdacs_notices():
    for u in VDACS_LISTS:
        try:
            html = get(u)
        except Exception:
            continue
        out = []
        for href, label in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S):
            t = clean(label)
            if KW.search(t):
                url = href if href.startswith("http") else "https://www.vdacs.virginia.gov/" + href.lstrip("/")
                out.append({"title": t, "url": url, "date": (find_date(clean(label)) or dt.date.today()).isoformat(), "body": "", "source": "Virginia Department of Agriculture and Consumer Services"})
        if out:
            return out[:6]
    raise RuntimeError("no VDACS list page reachable")


def load(path, default):
    try:
        return json.load(open(path))
    except Exception:
        return default


def main():
    today = dt.date.today()
    prev = load(OUT, {})
    curated = load(CURATED, {"commercial": [], "notices": []})
    result = {"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "wild": prev.get("wild", []), "notices": [], "commercial": [], "problems": problems}

    result["wild_year"], result["season"], result["wild_all"], result["mammals"] = prev.get("wild_year", []), prev.get("season"), prev.get("wild_all", []), prev.get("mammals", [])
    try:
        result["mammals"] = mammals()
    except Exception as e:
        problems.append(f"USDA APHIS mammals: {e} (kept previous values)")
    try:
        allw, season = wild_birds(today)
        result["wild_all"], result["season"] = allw, season
        year = [w for w in allw if (today - dt.date.fromisoformat(w["date"])).days <= WILD_YEAR]
        result["wild_year"] = year
        result["wild"] = [w for w in year if (today - dt.date.fromisoformat(w["date"])).days <= WILD_DAYS]
    except Exception as e:
        problems.append(f"USDA APHIS wild birds: {e} (kept previous values)")

    found = []
    # official release addresses pasted by staff into data/curated_detections.json "read_urls": read by the AI on the next run
    for url in curated.get("read_urls", []):
        try:
            page = get(url)
            body = clean(re.sub(r"(?is)<(script|style|nav|header|footer).*?</\1>", " ", page))[:6000]
            m = re.search(r"<h1[^>]*>(.*?)</h1>", page, re.S) or re.search(r"<title>(.*?)</title>", page, re.S)
            host = url.split("/")[2]
            src = "Maryland Department of Agriculture" if "maryland.gov" in host else "Delaware Department of Agriculture" if "delaware.gov" in host else "Virginia Department of Agriculture and Consumer Services" if "virginia.gov" in host else None
            if not src:
                problems.append(f"read_urls: {url} is not a Maryland, Delaware or Virginia government page; skipped"); continue
            found.append({"title": clean(m.group(1)) if m else url, "url": url, "date": (find_date(body) or today).isoformat(), "body": body, "source": src})
        except Exception as e:
            problems.append(f"read_urls {url}: {e}")
    for label, fn in (("MDA", mda_notices), ("DDA", lambda: sum((rss_items(u, "Delaware Department of Agriculture") for u in DDA_FEEDS), [])), ("VDACS", vdacs_notices)):
        try:
            found += fn()
        except Exception as e:
            problems.append(f"{label}: {e}")

    notices, commercial = [], {}
    for n in found:
        c = ai_extract(n["title"], n["body"], n["source"]) or dict(classify(n["title"], n["body"], n["source"]), method="rules")
        if c.get("ai_date"):
            n["date"] = c["ai_date"]
        n.update(c); n.pop("body", None); n.pop("ai_date", None)
        if (today - dt.date.fromisoformat(n["date"])).days <= NOTICE_DAYS:
            notices.append(n)
        if c["kind"] == "commercial" and c["county"] and c["status"]:   # headline must say preliminary/presumptive/confirmed
            key = f'{c["state"]}|{c["county"]}|{n["date"]}'
            commercial[key] = {"id": "auto-" + hashlib.md5(key.encode()).hexdigest()[:8], "state": c["state"], "county": c["county"], "date": n["date"],
                               "flock": c.get("flock_type") or "Commercial flock", "birds": c.get("birds"), "status": c["status"] or "reported", "status_text": c.get("summary", ""),
                               "source": n["source"], "url": n["url"], "auto": True, "method": c.get("method", "rules")}
    # curated entries (entered by MDA) replace automatic ones for the same state/county
    for c in curated.get("commercial", []):
        commercial = {k: v for k, v in commercial.items() if not (v["state"] == c["state"] and v["county"] == c["county"] and abs((dt.date.fromisoformat(v["date"]) - dt.date.fromisoformat(c["date"])).days) <= 7)}
        commercial[c["id"]] = dict(c, auto=False)
    notices += curated.get("notices", [])
    seen, uniq = set(), []
    for n in sorted(notices, key=lambda x: x["date"], reverse=True):
        if n["url"] in seen:
            continue
        seen.add(n["url"]); uniq.append(n)
    result["notices"] = uniq[:KEEP_NOTICES]
    # full history (for the time slider) keeps every commercial detection ever found; "commercial" keeps the recent ones
    hist = {f'{h["state"]}|{h["county"]}|{h["date"]}': h for h in prev.get("history", [])}
    for c in commercial.values():
        hist[f'{c["state"]}|{c["county"]}|{c["date"]}'] = c
    result["history"] = sorted(hist.values(), key=lambda x: x["date"], reverse=True)
    result["commercial"] = sorted((c for c in commercial.values() if (today - dt.date.fromisoformat(c["date"])).days <= 60), key=lambda x: x["date"], reverse=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(result, open(OUT, "w"), indent=1)
    print(f"AI model {AI_MODEL if os.environ.get('ANTHROPIC_API_KEY') else 'off'}; wild 4wk {len(result['wild'])}, 12mo {len(result.get('wild_year', []))}, all {len(result.get('wild_all', []))}, mammals {len(result.get('mammals', []))}, notices {len(result['notices'])}, commercial {len(result['commercial'])}; problems: {problems or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
