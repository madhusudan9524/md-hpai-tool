// node tests/risk.test.js
const R = require("../js/risk.js"), assert = require("assert");
const now = Date.parse("2026-11-18T12:00:00Z"), DAY = 864e5;

assert.strictEqual(R.seasonIndex(0), 1);                       // January is the Atlantic Flyway peak
assert.ok(R.seasonIndex(7) < 0.1);                             // August is low
assert.ok(Math.abs(R.km({ lat: 38.98, lon: -76.49 }, { lat: 38.37, lon: -75.6 }) - 100) < 10);  // Annapolis to Salisbury ~ 100 km

const pt = { lat: 38.4, lon: -75.5 };
assert.strictEqual(R.wildPressure(pt, [], now), 0);
const near = R.wildPressure(pt, [{ lat: 38.41, lon: -75.5, t: now - 2 * DAY }], now);
const far = R.wildPressure(pt, [{ lat: 38.6, lon: -75.5, t: now - 2 * DAY }], now);
const old = R.wildPressure(pt, [{ lat: 38.41, lon: -75.5, t: now - 90 * DAY }], now);
assert.ok(near > far && near > old && near < 1);

// seasonal risk (experimental; Gonnerman et al. 2025 coefficient on eBird Status & Trends waterfowl), on a small made-up grid
const st = R.prepareST(require("./st_fixture.json"));
const at = (lat, lon, d) => R.seasonalRisk({ pt: { lat, lon }, st, date: Date.parse(d + "T12:00:00Z") });
const jan = at(38.43, -75.58, "2026-01-10"), jul = at(38.43, -75.58, "2026-07-05");
assert.ok(jan.value > jul.value && jan.tier === 3 && jul.tier === 0, JSON.stringify([jan, jul]));   // migration season vs summer
assert.ok(Math.abs(Math.log(jan.value) / jan.zA - 0.422) < 1e-9);   // the paper's coefficient
assert.strictEqual(at(38.32, -75.37, "2026-01-10").zA, -3);           // no waterfowl at all -> lowest z
assert.ok(!at(39.5, -77, "2026-01-10").hasData);                      // outside the grid: not available, neutral
assert.ok(!R.seasonalRisk({ pt: { lat: 38.4, lon: -75.5 }, st: null }).hasData);
assert.strictEqual(R.stWeek(Date.UTC(2026, 0, 1)), 0); assert.strictEqual(R.stWeek(Date.UTC(2026, 11, 31)), 51);
// winter weather is no longer part of the score; the function stays for reference
assert.strictEqual(R.weatherFactor({ status: "offseason" }, 0).factor, 1);
// expected values shared with tests/test_risk_model.py
const ST_OUT = [[2.379165484936053,3,true],[0.4556733810111608,0,true],[2.208525055455686,2,true],[2.1951966852384466,2,true],[0.42051866489382483,0,true],[2.037760637544219,2,true],[0.28195719791700274,0,true],[0.28195719791700274,0,true],[0.28195719791700274,0,true],[1,0,false],[1,0,false],[1,0,false]];
const P = [[38.43, -75.58], [38.37, -75.48], [38.32, -75.37], [39.5, -77]], D = ["2026-01-10", "2026-07-05", "2026-11-19"];
P.forEach((p, i) => D.forEach((d, j) => { const r = at(p[0], p[1], d), e = ST_OUT[i * 3 + j]; assert.ok(Math.abs(r.value - e[0]) < 1e-9 && r.tier === e[1] && r.hasData === e[2]); }));
const low = R.farmRisk({ zone: null, kmToArea: 50, wildNear: 0, wildCounty: false, habitatKm: 5, season: 0.2, zoneVisits: 0, visits: 1, audit: { date: now - 30 * DAY, passed: true } }, now);
assert.strictEqual(low.label, "Low");
const high = R.farmRisk({ zone: "control", wildNear: 2, habitatKm: 0.5, season: 1, zoneVisits: 1, visits: 3, audit: null }, now);
assert.strictEqual(high.label, "Very high");
assert.ok(high.reasons.every((r) => R.SOURCES[r.src]));
// regional trend: quiet then a burst
const ev = (days) => days.map((d) => ({ t: now - d * DAY }));
const flat = R.regionalTrend(ev([1, 5, 9, 16, 25, 33, 40, 48, 55]), now);
assert.ok(!flat.rising);
const burst = R.regionalTrend(ev([1, 2, 3, 4, 6, 8, 11, 20, 45]), now);
assert.ok(burst.rising && burst.sharp, JSON.stringify(burst));
const quiet = R.regionalTrend(ev([2, 20]), now);
assert.ok(!quiet.rising);
const busy = R.farmRisk({ zone: null, kmToArea: 30, wildNear: 0, wildCounty: false, habitatKm: 5, season: 0.2, zoneVisits: 0, visits: 0, audit: undefined, outbreaksNear: 2, mammalsNear: 1, trend: burst }, now);
assert.deepStrictEqual(busy.reasons.map((r) => r.src).sort(), ["aphisMammals", "aphisPoultry", "usgs2025"].sort());
assert.strictEqual(busy.points, 4);
assert.ok(busy.reasons.every((r) => R.SOURCES[r.src]));
const cty = R.farmRisk({ zone: null, kmToArea: 30, countyOutbreak: true, audit: undefined }, now);
assert.ok(cty.reasons.some((r) => /county/.test(r.why)));
console.log("risk tests passed", { low: low.points, high: high.points, jan: jan.value.toFixed(2) });

// poultry-house shape test (registry auto-outline)
const G = require("../js/registry.js");
assert.ok(G.isPoultryHouse(2 * (152 + 15), 152 * 15));     // 500 ft x 50 ft house
assert.ok(!G.isPoultryHouse(2 * (20 + 15), 20 * 15));      // a house-sized building
assert.ok(!G.isPoultryHouse(2 * (40 + 40), 1600));         // big square barn / warehouse
console.log("registry shape tests passed", G.houseShape(2 * (152 + 15), 152 * 15).ratio.toFixed(1));
