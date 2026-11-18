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

const jan = R.seasonalRisk({ pt, month: 0, detections: [], habitat: 1, now });
const aug = R.seasonalRisk({ pt, month: 7, detections: [], habitat: 1, now });
assert.ok(jan.value > aug.value && jan.tier >= 1 && aug.tier === 0);

const low = R.farmRisk({ zone: null, kmToArea: 50, wildNear: 0, wildCounty: false, habitatKm: 5, season: 0.2, zoneVisits: 0, visits: 1, audit: { date: now - 30 * DAY, passed: true } }, now);
assert.strictEqual(low.label, "Low");
const high = R.farmRisk({ zone: "control", wildNear: 2, habitatKm: 0.5, season: 1, zoneVisits: 1, visits: 3, audit: null }, now);
assert.strictEqual(high.label, "Very high");
assert.ok(high.reasons.every((r) => R.SOURCES[r.src]));
console.log("risk tests passed", { low: low.points, high: high.points, jan: jan.value.toFixed(2) });
