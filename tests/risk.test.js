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

// seasonal risk (Gonnerman et al. 2025 coefficients): waterfowl abundance x winter weather x wild-bird detections
const hexes = [];
for (let la = 38.2; la < 38.7; la += 0.05) for (let lo = -75.9; lo < -75.3; lo += 0.05) hexes.push({ lat: la, lon: lo });
const flock = (n) => R.indexPlaces([{ lat: 38.4, lon: -75.5, birds: n }, { lat: 38.6, lon: -75.8, birds: 20 }]);
const ref = R.abundanceRef(hexes, [flock(200), flock(300), flock(100)]);
assert.ok(ref && ref.sd > 0 && ref.weeks === 3);
const busyWeeks = [flock(5000), flock(6000)], quietWeeks = [flock(10), flock(5)];
const base = { pt, ref, weather: null, month: 10, detections: [], now };
const hot = R.seasonalRisk({ ...base, birdWeeks: busyWeeks });
const cool = R.seasonalRisk({ ...base, birdWeeks: quietWeeks });
const away = R.seasonalRisk({ ...base, pt: { lat: 38.25, lon: -75.35 }, birdWeeks: busyWeeks });
assert.ok(hot.value > away.value && hot.value > cool.value && hot.tier >= 2, JSON.stringify(hot));
assert.ok(away.tier === 0 && cool.tier < hot.tier);
assert.ok(Math.abs(Math.log(hot.waterfowl) / hot.zA - 0.422) < 1e-9);   // abundance enters with the paper's coefficient
// no eBird data: the abundance term is neutral and only wild-bird detections can raise it
const none = R.seasonalRisk({ ...base, birdWeeks: null, ref: null });
assert.strictEqual(none.value, 1);
const infected = R.seasonalRisk({ ...base, birdWeeks: null, ref: null, detections: [{ lat: 38.401, lon: -75.5, t: now - DAY }] });
assert.ok(infected.value > 1 && infected.value <= 2);
// winter weather: colder and wetter raises risk, only Dec-Apr, capped at z = +/-2
const cold = { status: "ok", zT: -1, zP: 1 };
assert.ok(Math.abs(R.weatherFactor(cold, 0).factor - Math.exp(1.242 + 0.642)) < 1e-9);
assert.strictEqual(R.weatherFactor(cold, 6).factor, 1);
assert.strictEqual(R.weatherFactor({ status: "offseason" }, 0).factor, 1);
assert.strictEqual(R.weatherFactor({ status: "ok", zT: -9, zP: 0 }, 0).factor, Math.exp(1.242 * 2));
const jan = R.seasonalRisk({ ...base, month: 0, weather: cold, birdWeeks: quietWeeks });
assert.ok(jan.value > cool.value);
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
console.log("risk tests passed", { low: low.points, high: high.points, hot: hot.value.toFixed(2) });

// poultry-house shape test (registry auto-outline)
const G = require("../js/registry.js");
assert.ok(G.isPoultryHouse(2 * (152 + 15), 152 * 15));     // 500 ft x 50 ft house
assert.ok(!G.isPoultryHouse(2 * (20 + 15), 20 * 15));      // a house-sized building
assert.ok(!G.isPoultryHouse(2 * (40 + 40), 1600));         // big square barn / warehouse
console.log("registry shape tests passed", G.houseShape(2 * (152 + 15), 152 * 15).ratio.toFixed(1));
