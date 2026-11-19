"""Seasonal risk model (experimental), Python copy of js/risk.js (seasonalRisk and its parts), for the email alerts.

Keep the two in step: tests/test_risk_model.py checks this file against fixed values that tests/risk.test.js also uses.
The abundance reference (z-score mean and SD) is computed here, once, and written into data/birds_weeks.json as "ref",
so the map, the address card and the emails all compare against the same "typical place".
Standard library only.
"""
import json, math, os

COEF = {"waterfowl": 0.422, "precip": 0.642, "temp": -1.242}   # Gonnerman et al. 2025, per SD (log-odds)
WILD_MAX = 1                                                    # assumption: wild-bird detections at most double the risk
TIERS = ["Low", "Moderate", "High", "Very high"]
CELL = 0.12
DAY = 86400.0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def km(a, b):   # {lat, lon} dicts or (lat, lon) tuples
    la1, lo1 = (a["lat"], a["lon"]) if isinstance(a, dict) else a
    la2, lo2 = (b["lat"], b["lon"]) if isinstance(b, dict) else b
    r = math.pi / 180
    h = math.sin((la2 - la1) * r / 2) ** 2 + math.cos(la1 * r) * math.cos(la2 * r) * math.sin((lo2 - lo1) * r / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def as_places(lst):
    """eBird places from birds.json ({lat, lon, birds}) or birds_weeks.json ([lat, lon, birds, species])."""
    out = []
    for p in lst or []:
        if isinstance(p, (list, tuple)):
            out.append({"lat": p[0], "lon": p[1], "birds": p[2]})
        else:
            out.append({"lat": p["lat"], "lon": p["lon"], "birds": p.get("birds", 0)})
    return out


def index_places(places):
    cells = {}
    for p in places or []:
        if p and p.get("birds", 0) > 0:
            cells.setdefault((math.floor(p["lat"] / CELL), math.floor(p["lon"] / CELL)), []).append(p)
    return cells


def waterfowl_at(pt, idx):
    r, c, a = math.floor(pt["lat"] / CELL), math.floor(pt["lon"] / CELL), 0.0
    for i in (-1, 0, 1):
        for j in (-1, 0, 1):
            for p in idx.get((r + i, c + j), []):
                d = km(pt, p)
                if d <= 10:
                    a += p["birds"] * math.exp(-d / 3)
    return a


def abundance_index(pt, weeks):
    w = [x for x in (weeks or []) if x is not None]
    return sum(math.log1p(waterfowl_at(pt, idx)) for idx in w) / len(w) if w else None


def abundance_ref(points, weeks):
    n = s = s2 = 0.0
    for k in range(1, len(weeks or [])):
        pair = [weeks[k - 1], weeks[k]]
        for pt in points:
            x = abundance_index(pt, pair); n += 1; s += x; s2 += x * x
    if n < 2:
        return None
    mu = s / n
    return {"mu": mu, "sd": math.sqrt(max(1e-9, s2 / n - mu * mu)), "weeks": len(weeks)}


def ref_points():
    """Points standing in for the map's hexagons: a 0.05-degree grid within 30 km of a Maryland, Delaware or
    Eastern Shore county centre (37.05-39.75 N) (tools/county_points.json)."""
    centres = [(v[1], v[0]) for v in json.load(open(os.path.join(ROOT, "tools", "county_points.json"))).values()]
    pts, la = [], 37.05
    while la < 39.75:
        lo = -79.5
        while lo < -75.0:
            if any(km((la, lo), c) <= 30 for c in centres):
                pts.append({"lat": round(la, 3), "lon": round(lo, 3)})
            lo += 0.05
        la += 0.05
    return pts


def weather_factor(weather, month):   # month 0..11
    if not (month in (11, 0, 1, 2, 3) and weather and weather.get("status") == "ok"):
        return 1.0
    cap = lambda z: max(-2.0, min(2.0, float(z or 0)))
    return math.exp(COEF["temp"] * cap(weather.get("zT")) + COEF["precip"] * cap(weather.get("zP")))


def wild_pressure(pt, detections, now):   # detections: {lat, lon, t (seconds)}
    x = 0.0
    for d in detections or []:
        dist = km(pt, d)
        if dist > 40:
            continue
        age = max(0.0, (now - d["t"]) / DAY)
        if age > 120:
            continue
        x += math.exp(-dist / 10) * 0.5 ** (age / 28)
    return 1 - math.exp(-x)


DAY_MS = 86400000.0


def st_week(t):
    """Status & Trends week 0..51 for a time in seconds (week 1 = 1-7 January, UTC)."""
    import datetime as dt
    d = dt.datetime.fromtimestamp(t, dt.timezone.utc)
    return min(51, (d - dt.datetime(d.year, 1, 1, tzinfo=dt.timezone.utc)).days // 7)


def prepare_st(doc):
    """data/waterfowl_st.json -> dict with 'all' = 52 lists of cell values (goose + duck), as js/risk.js prepareST."""
    if not doc or not doc.get("data_goose") or not doc.get("ref"):
        return None
    sc = doc.get("scale") or 1
    duck = doc.get("data_duck")
    allw = [[(g + (duck[w][i] if duck else 0)) / sc for i, g in enumerate(gw)] for w, gw in enumerate(doc["data_goose"])]
    return {"nx": doc["nx"], "ny": doc["ny"], "bbox": doc["bbox"], "step": doc["step"], "ref": doc["ref"], "all": allw}


def st_abundance(st, pt, week, r=3.5):
    x0, _, _, y1 = st["bbox"]; dx, dy = st["step"]; v = st["all"][week]
    ci, cj = math.floor((pt["lon"] - x0) / dx), math.floor((y1 - pt["lat"]) / dy)
    s = n = 0
    for j in range(cj - 2, cj + 3):
        for i in range(ci - 2, ci + 3):
            if i < 0 or j < 0 or i >= st["nx"] or j >= st["ny"]:
                continue
            if km(pt, {"lon": x0 + (i + 0.5) * dx, "lat": y1 - (j + 0.5) * dy}) > r:
                continue
            s += v[j * st["nx"] + i]; n += 1
    return s / n if n else None


def seasonal_risk(pt, st, t):
    """Same as js/risk.js seasonalRisk. t: time in seconds. Experimental; adapted from Gonnerman et al. 2025."""
    if not st:
        return {"value": 1.0, "tier": 0, "zA": 0.0, "abundance": None, "hasData": False}
    w = st_week(t)
    a1, a0 = st_abundance(st, pt, w), st_abundance(st, pt, (w + 51) % 52)
    if a1 is None:
        return {"value": 1.0, "tier": 0, "zA": 0.0, "abundance": None, "hasData": False, "week": w + 1}
    a, ref = (a1 + a0) / 2, st["ref"]
    za = max(-3.0, min(3.0, (math.log(a) - ref["mu"]) / ref["sd"])) if a > 0 else -3.0
    cut = ref["cut"]
    tier = 3 if za >= cut[2] else 2 if za >= cut[1] else 1 if za >= cut[0] else 0
    v = math.exp(COEF["waterfowl"] * za)
    return {"value": v, "tier": tier, "zA": za, "abundance": a, "hasData": True, "week": w + 1}


def regional_trend(times, now):
    """Same as js/risk.js regionalTrend: events in the last 14 days vs the 42 days before, as daily rates."""
    recent = prior = 0
    for t in times:
        age = (now - t) / DAY
        if age < 0:
            continue
        if age <= 14:
            recent += 1
        elif age <= 56:
            prior += 1
    r_rate, p_rate = recent / 14, prior / 42
    ratio = r_rate / p_rate if p_rate else (math.inf if recent else 0)
    return {"recent": recent, "prior": prior, "ratio": ratio, "rising": recent >= 3 and ratio >= 2, "sharp": recent >= 5 and ratio >= 3}
