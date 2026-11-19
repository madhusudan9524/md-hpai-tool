#!/usr/bin/env python3
"""Statewide winter weather for the seasonal risk model: this winter so far compared with 1991-2020.

Gonnerman et al. 2025 (One Health 21:101172) found colder and wetter winters raised HPAI spillover risk into poultry
(winter mean temperature and precipitation, Dec-Jan). The map applies that as ONE factor for all of Maryland, not
per place, because differences inside Maryland are much smaller than the continent-wide ones the effect was measured on.

Writes data/weather.json:
  status   "ok" (a factor applies), "offseason" (May-Nov) or "early" (fewer than 7 days of this winter), or "error"
  zT, zP   this winter's mean daily temperature / precipitation so far, as z-scores against the same days of the
           winters 1991-92 .. 2020-21 (year-to-year mean and SD of the Maryland average)
The coefficients and the cap are applied in js/risk.js (weatherFactor).

Data: Open-Meteo historical weather API (ERA5 reanalysis), CC BY 4.0, https://open-meteo.com. Free for non-commercial
use; check their terms before a production launch. The 1991-2020 daily values are fetched once and kept in
data/weather_normals.json. Standard library only.
"""
import json, os, sys, statistics, urllib.parse, urllib.request, datetime as dt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "weather.json")
NORMALS = os.path.join(ROOT, "data", "weather_normals.json")
API = "https://archive-api.open-meteo.com/v1/archive"
# Maryland, weighted toward the poultry areas: Frederick, Baltimore, Upper Marlboro, Easton, Denton, Salisbury
POINTS = [(39.41, -77.41), (39.29, -76.61), (38.82, -76.75), (38.77, -76.08), (38.88, -75.83), (38.36, -75.60)]
FIRST, LAST = 1991, 2020          # winters starting Dec 1991 .. Dec 2020
LAG = 6                           # the archive is about 5 days behind
MIN_DAYS = 7


def fetch(start, end):
    """Daily Maryland average (over POINTS) of mean temperature (C) and precipitation (mm): {date: (t, p)}."""
    q = urllib.parse.urlencode({
        "latitude": ",".join(str(p[0]) for p in POINTS), "longitude": ",".join(str(p[1]) for p in POINTS),
        "start_date": start.isoformat(), "end_date": end.isoformat(),
        "daily": "temperature_2m_mean,precipitation_sum", "timezone": "America/New_York"})
    req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": "MD-HPAI-map/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.loads(r.read().decode())
    data = data if isinstance(data, list) else [data]
    out = {}
    for loc in data:
        d = loc["daily"]
        for day, t, p in zip(d["time"], d["temperature_2m_mean"], d["precipitation_sum"]):
            if t is None or p is None:
                continue
            out.setdefault(day, []).append((t, p))
    return {day: (statistics.mean(v[0] for v in vs), statistics.mean(v[1] for v in vs)) for day, vs in out.items() if len(vs) == len(POINTS)}


def winter_days(year, daily, n):
    """The first n days from Dec 1 of `year` (Feb 29 skipped so years line up), as lists of t and p."""
    t, p, d, end = [], [], dt.date(year, 12, 1), dt.date(year + 1, 2, 28)
    while len(t) < n and d <= end:
        if d.isoformat() in daily:
            t.append(daily[d.isoformat()][0]); p.append(daily[d.isoformat()][1])
        d += dt.timedelta(days=1)
    return t, p


def normals():
    try:
        n = json.load(open(NORMALS))
        if n.get("first") == FIRST and n.get("last") == LAST and n.get("points") == POINTS:
            return n["daily"]
    except Exception:
        pass
    daily = {}
    for y0 in range(FIRST, LAST + 1, 10):   # a decade per request keeps responses small
        y1 = min(LAST, y0 + 9)
        daily.update(fetch(dt.date(y0, 12, 1), dt.date(y1 + 1, 2, 28)))
    daily = {k: [round(v[0], 2), round(v[1], 2)] for k, v in daily.items() if k[5:7] in ("12", "01", "02")}
    json.dump({"first": FIRST, "last": LAST, "points": POINTS, "source": "Open-Meteo (ERA5), CC BY 4.0", "daily": daily}, open(NORMALS, "w"), separators=(",", ":"))
    return daily


def season_now(today):
    """(winter start year, days of Dec-Feb data available) or (None, 0) outside Dec-Apr."""
    if today.month in (12,):
        y = today.year
    elif today.month in (1, 2, 3, 4):
        y = today.year - 1
    else:
        return None, 0
    end = min(today - dt.timedelta(days=LAG), dt.date(y + 1, 2, 28))
    return y, max(0, (end - dt.date(y, 12, 1)).days + 1)


def write(**k):
    k.update(updated=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), source="Open-Meteo historical weather (ERA5), CC BY 4.0",
             method="Maryland average of 6 points; this winter so far vs the same days of the 1991-2020 winters")
    json.dump(k, open(OUT, "w"), indent=1)


def main():
    today = dt.date.today()
    y, n = season_now(today)
    if y is None:
        write(status="offseason", note="The winter weather factor applies December to April."); print("weather: off season"); return 0
    if n < MIN_DAYS:
        write(status="early", season=f"{y}-{(y + 1) % 100:02d}", days=n, note="Not enough of this winter yet."); print("weather: too early in the winter"); return 0
    try:
        norm = normals()
        cur = fetch(dt.date(y, 12, 1), dt.date(y, 12, 1) + dt.timedelta(days=n + 1))
    except Exception as e:
        print(f"weather: couldn't reach Open-Meteo: {e}")
        try:
            old = json.load(open(OUT))
            if old.get("status") == "ok" and old.get("season") == f"{y}-{(y + 1) % 100:02d}":
                return 0   # keep the last good values for this winter
        except Exception:
            pass
        write(status="error", note=str(e)[:200]); return 0
    ct, cp = winter_days(y, cur, n)
    if len(ct) < MIN_DAYS:
        write(status="early", season=f"{y}-{(y + 1) % 100:02d}", days=len(ct), note="Not enough of this winter yet."); return 0
    n = len(ct)
    nt, np_ = [], []
    for yr in range(FIRST, LAST + 1):
        t, p = winter_days(yr, norm, n)
        if len(t) == n:
            nt.append(statistics.mean(t)); np_.append(statistics.mean(p))
    t_now, p_now = statistics.mean(ct), statistics.mean(cp)
    zT = (t_now - statistics.mean(nt)) / statistics.stdev(nt)
    zP = (p_now - statistics.mean(np_)) / statistics.stdev(np_)
    write(status="ok", season=f"{y}-{(y + 1) % 100:02d}", days=n, tempC=round(t_now, 2), precipMmDay=round(p_now, 2),
          normalTempC=round(statistics.mean(nt), 2), normalPrecipMmDay=round(statistics.mean(np_), 2), years=len(nt), zT=round(zT, 3), zP=round(zP, 3))
    print(f"weather: winter {y}-{y + 1}, {n} days: {t_now:.1f} C (z {zT:+.2f}), {p_now:.2f} mm/day (z {zP:+.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
