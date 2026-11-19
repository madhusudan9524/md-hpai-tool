#!/usr/bin/env python3
"""Waterfowl (geese, swans, dabbling and diving ducks: the same genera as the seasonal risk) sightings from eBird for Maryland, Delaware and Virginia's Eastern Shore.

Writes data/birds.json (the last 7 days) and data/birds_weeks.json (one list per full Monday-Sunday week, up to 26 weeks,
for the map's week slider). Runs with the twice-daily update; needs the repository secret EBIRD_API_KEY.
Data: eBird, Cornell Lab of Ornithology (eBird API Terms of Use apply).

Source: every reviewed report of each waterfowl species in the last 30 days (/data/obs/{region}/recent/{species},
the only eBird API call that returns all reports, not one per species). Counting: for each place and species, the
highest count reported in the period; a place's total is the sum over species. The same flock reported by several
birders or on several days is counted once. eBird's API reaches back 30 days, so past weeks are filled 4 weeks back
and every new week is kept from then on.

These are sightings where people went birding, not a census: busy birding spots (refuges, parks) stand out.
Standard library only.
"""
import json, os, sys, time, urllib.request, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "birds.json")
WEEKS_OUT = os.path.join(ROOT, "data", "birds_weeks.json")
WEEKS, METHOD, BACK = 26, 4, 30   # method 4: only the GENERA species (older archives are rebuilt)
API = "https://api.ebird.org/v2"
REGIONS = ["US-MD", "US-DE", "US-VA-001", "US-VA-131"]   # Maryland, Delaware, Accomack, Northampton
DAYS = 7
FAMILY = "Ducks, Geese, and Waterfowl"
# Same waterfowl as the seasonal risk (tools/build_ebirdst.py): species in the 13 genera used by Gonnerman et al. 2025, plus
# Mareca and Spatula (Gadwall, wigeon, shoveler, Blue-winged Teal), which older taxonomies placed in Anas.
# Sea ducks, mergansers, Bufflehead, goldeneyes, Wood Duck and Ruddy Duck are left out.
GENERA = {"Alopochen", "Anas", "Anser", "Aythya", "Branta", "Chloephaga", "Coscoroba", "Cyanochen", "Cygnus", "Dendrocygna",
          "Lophonetta", "Neochen", "Tadorna", "Mareca", "Spatula"}


def get(path, key):
    req = urllib.request.Request(API + path, headers={"X-eBirdApiToken": key, "User-Agent": "MD-HPAI-map/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def write(places, problems, status):
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "days": DAYS, "source": "eBird, Cornell Lab of Ornithology",
               "method": "highest count of each species at each place in the last 7 days, summed over species",
               "status": status, "places": places, "problems": problems}, open(OUT, "w"))


def reports(key, water):
    """Every reviewed waterfowl report in the last BACK days: (date, place key, lat, lon, place name, species, count)."""
    out, problems = [], []
    for reg in REGIONS:
        try:
            seen = sorted({o["speciesCode"] for o in get(f"/data/obs/{reg}/recent?back={BACK}&cat=species", key) if o.get("speciesCode") in water})
        except Exception as e:
            problems.append(f"{reg}: {e}"); continue
        for sp in seen:
            try:
                obs = get(f"/data/obs/{reg}/recent/{sp}?back={BACK}", key)
            except Exception as e:
                problems.append(f"{reg} {sp}: {e}"); continue
            for o in obs:
                if o.get("obsReviewed") is False and o.get("obsValid") is False or o.get("lat") is None:
                    continue
                try:
                    d = dt.date.fromisoformat((o.get("obsDt") or "")[:10])
                except ValueError:
                    continue
                out.append((d, o.get("locId") or f'{o["lat"]:.3f},{o["lng"]:.3f}', o["lat"], o["lng"], (o.get("locName") or "")[:80], water[sp], o.get("howMany") or 1))
            time.sleep(0.2)   # be gentle with the API
    return out, problems


def places_in(rows, start, end):
    """Places with waterfowl between start and end (inclusive): highest count per species, summed over species."""
    by = {}
    for d, k, lat, lon, name, sp, n in rows:
        if not (start <= d <= end):
            continue
        p = by.setdefault(k, {"lat": round(lat, 4), "lon": round(lon, 4), "place": name, "sp": {}, "last": ""})
        p["sp"][sp] = max(p["sp"].get(sp, 0), n)
        p["last"] = max(p["last"], d.isoformat())
    out = [dict(p, birds=sum(p["sp"].values())) for p in by.values()]
    return sorted(out, key=lambda p: -p["birds"])


def update_weeks(rows):
    try:
        arch = json.load(open(WEEKS_OUT))
        if arch.get("method") != METHOD:
            arch = {"weeks": []}   # counted another way before: start again
    except Exception:
        arch = {"weeks": []}
    today = dt.date.today()
    have = {w["start"]: w for w in arch.get("weeks", [])}
    first = today - dt.timedelta(days=BACK - 1)
    monday = first + dt.timedelta(days=(7 - first.weekday()) % 7)   # first full week inside the reach of the API
    while monday + dt.timedelta(days=6) < today:   # every full week we can see is (re)built from the reports
        ps = places_in(rows, monday, monday + dt.timedelta(days=6))
        have[monday.isoformat()] = {"start": monday.isoformat(), "places": [[round(p["lat"], 3), round(p["lon"], 3), p["birds"], max(p["sp"], key=p["sp"].get)] for p in ps]}
        monday += dt.timedelta(days=7)
    weeks = sorted(have.values(), key=lambda w: w["start"])[-WEEKS:]
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "source": "eBird, Cornell Lab of Ornithology",
               "note": "highest count of each species at each place in the week, summed over species", "method": METHOD, "species": "genera used by Gonnerman et al. 2025 (as the seasonal risk)", "weeks": weeks}, open(WEEKS_OUT, "w"), separators=(",", ":"))
    print(f"birds: weekly archive {len(weeks)} weeks ({weeks[0]['start'] if weeks else '-'} to {weeks[-1]['start'] if weeks else '-'})")


def main():
    # always writes data/birds.json, so the map can say why the layer is empty
    key = os.environ.get("EBIRD_API_KEY")
    if not key:
        print("birds: EBIRD_API_KEY not set"); write([], ["EBIRD_API_KEY is not set"], "nokey"); return 0
    try:
        tax = get("/ref/taxonomy/ebird?fmt=json&cat=species", key)
    except Exception as e:
        print(f"birds: couldn't reach eBird: {e}"); write([], [f"taxonomy: {e}"], "error"); return 0
    water = {t["speciesCode"]: t["comName"] for t in tax
             if t.get("familyComName") == FAMILY and (t.get("sciName") or "").split(" ")[0] in GENERA}
    rows, problems = reports(key, water)
    today = dt.date.today()
    found = places_in(rows, today - dt.timedelta(days=DAYS - 1), today)
    out = [{"lat": p["lat"], "lon": p["lon"], "place": p["place"], "birds": p["birds"], "last": p["last"], "species": sorted(p["sp"].items(), key=lambda x: -x[1])[:6]} for p in found]
    write(out, problems, "ok" if out or not problems else "error")
    print(f"birds: {len(out)} places, {sum(p['birds'] for p in out)} waterfowl in the last {DAYS} days; problems: {problems or 'none'}")
    try:
        update_weeks(rows)
    except Exception as e:
        print(f"birds: weekly archive not updated: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
