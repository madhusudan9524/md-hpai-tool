#!/usr/bin/env python3
"""Recent waterfowl sightings (ducks, geese, swans) from eBird for Maryland, Delaware and Virginia's Eastern Shore → data/birds.json.

Runs with the twice-daily update. Needs the repository secret EBIRD_API_KEY (free: https://ebird.org/api/keygen);
without it the script does nothing. Data: eBird, Cornell Lab of Ornithology (eBird API Terms of Use and eBird Data Access Terms apply).
Sightings at the same place are combined (total birds, species list). Standard library only.
"""
import json, os, sys, time, urllib.request, datetime as dt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "birds.json")
API = "https://api.ebird.org/v2"
REGIONS = ["US-MD", "US-DE", "US-VA-001", "US-VA-131"]   # Maryland, Delaware, Accomack, Northampton
DAYS = 7
FAMILY = "Ducks, Geese, and Waterfowl"


def get(path, key):
    req = urllib.request.Request(API + path, headers={"X-eBirdApiToken": key, "User-Agent": "MD-HPAI-map/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def main():
    key = os.environ.get("EBIRD_API_KEY")
    if not key:
        print("birds: EBIRD_API_KEY not set, skipping"); return 0
    tax = get("/ref/taxonomy/ebird?fmt=json&cat=species", key)
    water = {t["speciesCode"]: t["comName"] for t in tax if t.get("familyComName") == FAMILY}
    places, problems = {}, []
    for reg in REGIONS:
        try:
            # which waterfowl species were seen recently in this region, then every recent sighting of each
            seen = [o["speciesCode"] for o in get(f"/data/obs/{reg}/recent?back={DAYS}&cat=species", key) if o.get("speciesCode") in water]
        except Exception as e:
            problems.append(f"{reg}: {e}"); continue
        for sp in sorted(set(seen)):
            try:
                obs = get(f"/data/obs/{reg}/recent/{sp}?back={DAYS}", key)
            except Exception as e:
                problems.append(f"{reg} {sp}: {e}"); continue
            for o in obs:
                if o.get("obsReviewed") is False and o.get("obsValid") is False:
                    continue
                k = o.get("locId") or f'{o["lat"]:.3f},{o["lng"]:.3f}'
                p = places.setdefault(k, {"lat": round(o["lat"], 4), "lon": round(o["lng"], 4), "place": o.get("locName", "")[:80], "birds": 0, "species": {}, "last": ""})
                n = o.get("howMany") or 1
                p["birds"] += n; p["species"][water[sp]] = p["species"].get(water[sp], 0) + n
                p["last"] = max(p["last"], o.get("obsDt", "")[:10])
            time.sleep(0.2)   # be gentle with the API
    out = [dict(p, species=sorted(p["species"].items(), key=lambda x: -x[1])[:6]) for p in places.values()]
    out.sort(key=lambda p: -p["birds"])
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "days": DAYS, "source": "eBird, Cornell Lab of Ornithology",
               "places": out, "problems": problems}, open(OUT, "w"))
    print(f"birds: {len(out)} places, {sum(p['birds'] for p in out)} waterfowl; problems: {problems or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
