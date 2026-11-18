#!/usr/bin/env python3
"""Recent waterfowl sightings (ducks, geese, swans) from eBird for Maryland, Delaware and Virginia's Eastern Shore → data/birds.json.

Runs with the twice-daily update. Needs the repository secret EBIRD_API_KEY (free: https://ebird.org/api/keygen);
without it the script does nothing. Data: eBird, Cornell Lab of Ornithology (eBird API Terms of Use and eBird Data Access Terms apply).
Sightings at the same place are combined (total birds, species list). Standard library only.

Also keeps data/birds_weeks.json: the last 26 full weeks (Monday to Sunday), one compact list per week of
[lat, lon, birds, top species] per place, for the map's week slider. "birds" is the highest count at that place on any day
of the week (eBird's historic records, one per species per place per day), so the same flock isn't counted seven times.
Missing weeks are filled a few at a time (MAX_FILL per run) to stay gentle with the eBird API.
"""
import json, os, sys, time, urllib.request, datetime as dt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "birds.json")
WEEKS_OUT = os.path.join(ROOT, "data", "birds_weeks.json")
WEEKS, MAX_FILL = 26, 6
API = "https://api.ebird.org/v2"
REGIONS = ["US-MD", "US-DE", "US-VA-001", "US-VA-131"]   # Maryland, Delaware, Accomack, Northampton
DAYS = 7
FAMILY = "Ducks, Geese, and Waterfowl"


def get(path, key):
    req = urllib.request.Request(API + path, headers={"X-eBirdApiToken": key, "User-Agent": "MD-HPAI-map/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def write(places, problems, status):
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "days": DAYS, "source": "eBird, Cornell Lab of Ornithology",
               "status": status, "places": places, "problems": problems}, open(OUT, "w"))


def main():
    # always writes data/birds.json, so the map can say why the layer is empty
    key = os.environ.get("EBIRD_API_KEY")
    if not key:
        print("birds: EBIRD_API_KEY not set"); write([], ["EBIRD_API_KEY is not set"], "nokey"); return 0
    try:
        tax = get("/ref/taxonomy/ebird?fmt=json&cat=species", key)
    except Exception as e:
        print(f"birds: couldn't reach eBird: {e}"); write([], [f"taxonomy: {e}"], "error"); return 0
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
    write(out, problems, "ok" if out or not problems else "error")
    print(f"birds: {len(out)} places, {sum(p['birds'] for p in out)} waterfowl; problems: {problems or 'none'}")
    try:
        update_weeks(key, water)
    except Exception as e:
        print(f"birds: weekly archive not updated: {e}")
    return 0


def week_of(regs, water, key, monday):
    """Peak waterfowl count per place over one Monday-Sunday week, from eBird historic records."""
    best = {}
    for i in range(7):
        d = monday + dt.timedelta(days=i)
        day = {}
        for reg in regs:
            try:
                obs = get(f"/data/obs/{reg}/historic/{d.year}/{d.month}/{d.day}?cat=species&detail=simple&rank=mrec&maxResults=10000", key)
            except Exception:
                continue
            for o in obs:
                if o.get("speciesCode") not in water or o.get("lat") is None:
                    continue
                k = o.get("locId") or f'{o["lat"]:.3f},{o["lng"]:.3f}'
                p = day.setdefault(k, {"lat": round(o["lat"], 3), "lon": round(o["lng"], 3), "n": 0, "sp": {}})
                n = o.get("howMany") or 1
                p["n"] += n; p["sp"][water[o["speciesCode"]]] = p["sp"].get(water[o["speciesCode"]], 0) + n
            time.sleep(0.15)
        for k, p in day.items():   # keep each place's busiest day of the week
            if k not in best or p["n"] > best[k]["n"]:
                best[k] = p
    return [[p["lat"], p["lon"], p["n"], max(p["sp"], key=p["sp"].get)] for p in sorted(best.values(), key=lambda x: -x["n"])]


def update_weeks(key, water):
    try:
        arch = json.load(open(WEEKS_OUT))
    except Exception:
        arch = {"weeks": []}
    today = dt.date.today()
    last_monday = today - dt.timedelta(days=today.weekday() + 7)   # the most recent full week
    want = [last_monday - dt.timedelta(weeks=i) for i in range(WEEKS)]
    have = {w["start"]: w for w in arch.get("weeks", [])}
    filled = 0
    for m in want:   # newest first, so the slider gains the recent weeks first
        if m.isoformat() in have or filled >= MAX_FILL:
            continue
        have[m.isoformat()] = {"start": m.isoformat(), "places": week_of(REGIONS, water, key, m)}
        filled += 1
    weeks = sorted((have[m.isoformat()] for m in want if m.isoformat() in have), key=lambda w: w["start"])
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "source": "eBird, Cornell Lab of Ornithology",
               "note": "birds = highest count at a place on any day of the week", "weeks": weeks}, open(WEEKS_OUT, "w"), separators=(",", ":"))
    print(f"birds: weekly archive {len(weeks)} of {WEEKS} weeks ({filled} filled this run)")


if __name__ == "__main__":
    sys.exit(main())
