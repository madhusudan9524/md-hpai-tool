"""Keeps tools/risk_model.py (email alerts) in step with js/risk.js (map). Run: python3 tests/test_risk_model.py
The expected numbers come from js/risk.js on the same inputs; if you change one model, change the other and refresh these."""
import json, math, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import risk_model as RM

CASE = json.loads(r"""{"now": 1795000000000, "weeks": [[{"lat": 38.4, "lon": -75.5, "birds": 800}, {"lat": 38.45, "lon": -75.55, "birds": 120}, {"lat": 39.0, "lon": -76.2, "birds": 3000}], [{"lat": 38.41, "lon": -75.52, "birds": 1500}, {"lat": 38.6, "lon": -75.8, "birds": 40}], [{"lat": 38.39, "lon": -75.49, "birds": 2500}, {"lat": 39.01, "lon": -76.21, "birds": 200}]], "pts": [{"lat": 38.4, "lon": -75.51}, {"lat": 38.5, "lon": -75.7}, {"lat": 39.0, "lon": -76.2}, {"lat": 38.2, "lon": -75.3}], "det_days": [1, 3, 9, 20, 50], "weather": {"status": "ok", "zT": -0.8, "zP": 0.6}}""")
JS = json.loads(r"""{"ref": {"mu": 2.5052544743004588, "sd": 2.839128601537025, "weeks": 3}, "out": [[14.86788329957759, 3], [3.8615577711563356, 2], [3.919232243020281, 2], [3.1536600818080722, 2]], "trend": {"recent": 3, "prior": 2, "ratio": 4.5, "rising": true, "sharp": false}}""")

now = CASE["now"] / 1000
det = [{"lat": 38.40 + 0.02 * i, "lon": -75.5, "t": now - d * RM.DAY} for i, d in enumerate(CASE["det_days"])]
tr = RM.regional_trend([d["t"] for d in det], now)
assert all(tr[k] == JS["trend"][k] for k in ("recent", "prior", "rising", "sharp")) and abs(tr["ratio"] - JS["trend"]["ratio"]) < 1e-9, tr

# seasonal risk on tests/st_fixture.json; ST_OUT is what js/risk.js gives (tests/risk.test.js checks the same numbers)
import datetime as dt
st = RM.prepare_st(json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "st_fixture.json"))))
ST_OUT = json.loads("""[[2.379165484936053,3,true],[0.4556733810111608,0,true],[2.208525055455686,2,true],[2.1951966852384466,2,true],[0.42051866489382483,0,true],[2.037760637544219,2,true],[0.28195719791700274,0,true],[0.28195719791700274,0,true],[0.28195719791700274,0,true],[1,0,false],[1,0,false],[1,0,false]]""")
P = [(38.43, -75.58), (38.37, -75.48), (38.32, -75.37), (39.5, -77)]
D = ["2026-01-10", "2026-07-05", "2026-11-19"]
for i, (la, lo) in enumerate(P):
    for j, d in enumerate(D):
        t = dt.datetime.fromisoformat(d + "T12:00:00+00:00").timestamp()
        r, e = RM.seasonal_risk({"lat": la, "lon": lo}, st, t), ST_OUT[i * 3 + j]
        assert abs(r["value"] - e[0]) < 1e-6 and r["tier"] == e[1] and r["hasData"] == e[2], (la, lo, d, r, e)
print("python risk model matches js/risk.js")
