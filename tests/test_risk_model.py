"""Keeps tools/risk_model.py (email alerts) in step with js/risk.js (map). Run: python3 tests/test_risk_model.py
The expected numbers come from js/risk.js on the same inputs; if you change one model, change the other and refresh these."""
import json, math, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import risk_model as RM

CASE = json.loads(r"""{"now": 1795000000000, "weeks": [[{"lat": 38.4, "lon": -75.5, "birds": 800}, {"lat": 38.45, "lon": -75.55, "birds": 120}, {"lat": 39.0, "lon": -76.2, "birds": 3000}], [{"lat": 38.41, "lon": -75.52, "birds": 1500}, {"lat": 38.6, "lon": -75.8, "birds": 40}], [{"lat": 38.39, "lon": -75.49, "birds": 2500}, {"lat": 39.01, "lon": -76.21, "birds": 200}]], "pts": [{"lat": 38.4, "lon": -75.51}, {"lat": 38.5, "lon": -75.7}, {"lat": 39.0, "lon": -76.2}, {"lat": 38.2, "lon": -75.3}], "det_days": [1, 3, 9, 20, 50], "weather": {"status": "ok", "zT": -0.8, "zP": 0.6}}""")
JS = json.loads(r"""{"ref": {"mu": 2.5052544743004588, "sd": 2.839128601537025, "weeks": 3}, "out": [[14.86788329957759, 3], [3.8615577711563356, 2], [3.919232243020281, 2], [3.1536600818080722, 2]], "trend": {"recent": 3, "prior": 2, "ratio": 4.5, "rising": true, "sharp": false}}""")

now = CASE["now"] / 1000
idx = [RM.index_places(w) for w in CASE["weeks"]]
ref = RM.abundance_ref(CASE["pts"], idx)
assert abs(ref["mu"] - JS["ref"]["mu"]) < 1e-9 and abs(ref["sd"] - JS["ref"]["sd"]) < 1e-9, ref
det = [{"lat": 38.40 + 0.02 * i, "lon": -75.5, "t": now - d * RM.DAY} for i, d in enumerate(CASE["det_days"])]
for p, (v, tier) in zip(CASE["pts"], JS["out"]):
    r = RM.seasonal_risk(p, idx[-2:], ref, CASE["weather"], 0, det, now)
    assert abs(r["value"] - v) < 1e-9 and r["tier"] == tier, (p, r, v, tier)
tr = RM.regional_trend([d["t"] for d in det], now)
assert all(tr[k] == JS["trend"][k] for k in ("recent", "prior", "rising", "sharp")) and abs(tr["ratio"] - JS["trend"]["ratio"]) < 1e-9, tr
assert RM.weather_factor(CASE["weather"], 6) == 1.0
print("python risk model matches js/risk.js")
