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
import csv, hashlib, io, json, os, re, sys, urllib.request, datetime as dt
from html import unescape
from xml.etree import ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "detections.json")
CURATED = os.path.join(ROOT, "data", "curated_detections.json")
POINTS = json.load(open(os.path.join(ROOT, "tools", "county_points.json")))

WILD_CSV = "https://www.aphis.usda.gov/sites/default/files/hpai-wild-birds.csv"
MDA_LIST = "https://mda.maryland.gov/news/press-releases"
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
        if (today - d).days > WILD_YEAR or f"{st}|{co}" not in POINTS:
            continue
        lon, lat = POINTS[f"{st}|{co}"]
        h = int(hashlib.md5(f"{st}{co}{r.get('Bird Species')}{d}{len(out)}".encode()).hexdigest()[:6], 16)   # small stable offset so dots in one county do not stack
        out.append({"state": st, "county": co, "species": r.get("Bird Species", ""), "date": d.isoformat(), "strain": r.get("HPAI Strain", ""),
                    "lon": round(lon + ((h % 1000) / 1000 - .5) * 0.12, 5), "lat": round(lat + (((h // 1000) % 1000) / 1000 - .5) * 0.09, 5),
                    "source": "USDA APHIS"})
    out.sort(key=lambda x: x["date"], reverse=True)
    return out, season


def mda_notices():
    html = get(MDA_LIST)
    links = re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S)
    seen, out = set(), []
    for href, label in links:
        title = clean(label)
        if not KW.search(title) or href in seen:
            continue
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

    result["wild_year"], result["season"] = prev.get("wild_year", []), prev.get("season")
    try:
        year, season = wild_birds(today)
        result["wild_year"], result["season"] = year, season
        result["wild"] = [w for w in year if (today - dt.date.fromisoformat(w["date"])).days <= WILD_DAYS]
    except Exception as e:
        problems.append(f"USDA APHIS wild birds: {e} (kept previous values)")

    found = []
    for label, fn in (("MDA", mda_notices), ("DDA", lambda: sum((rss_items(u, "Delaware Department of Agriculture") for u in DDA_FEEDS), [])), ("VDACS", vdacs_notices)):
        try:
            found += fn()
        except Exception as e:
            problems.append(f"{label}: {e}")

    notices, commercial = [], {}
    for n in found:
        c = classify(n["title"], n["body"], n["source"])
        n.update(c); n.pop("body", None)
        if (today - dt.date.fromisoformat(n["date"])).days <= NOTICE_DAYS:
            notices.append(n)
        if c["kind"] == "commercial" and c["county"] and c["status"]:   # headline must say preliminary/presumptive/confirmed
            key = f'{c["state"]}|{c["county"]}|{n["date"]}'
            commercial[key] = {"id": "auto-" + hashlib.md5(key.encode()).hexdigest()[:8], "state": c["state"], "county": c["county"], "date": n["date"],
                               "flock": "Commercial flock", "status": c["status"] or "reported", "source": n["source"], "url": n["url"], "auto": True}
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
    print(f"wild {len(result['wild'])}, notices {len(result['notices'])}, commercial {len(result['commercial'])}; problems: {problems or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
