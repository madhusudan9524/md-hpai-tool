/* Maryland HPAI map: risk models (no map library needed; also runs in Node for tests).
 *
 * Both models are SCREENING aids, not predictions. They rank places so people can focus attention.
 * Every factor and weight is tied to a published source; see SOURCES and README "Risk models".
 */
(function (root) {
  const SOURCES = {
    aphis2015: { t: "USDA APHIS (2015). Biosecurity factors and the introduction and spread of HPAI: findings from epidemiological studies.", u: "https://www.aphis.usda.gov/animal_health/downloads/animal_diseases/ai/hpai-biosecurity-factors-introduction-and-spread.pdf" },
    schreuder2022: { t: "Schreuder et al. (2022). Wild bird densities and landscape variables predict spatial patterns in HPAI outbreak risk across the Netherlands. Pathogens.", u: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9143584" },
    usgs2025: { t: "USGS (2025). Avian influenza spillover into poultry: environmental influences and biosecurity protections. One Health 21:101172.", u: "https://doi.org/10.1016/j.onehlt.2025.101172" },
    aphisWild: { t: "USDA APHIS. Detections of HPAI in wild birds (monthly counts, Atlantic Flyway states).", u: "https://www.aphis.usda.gov/livestock-poultry-disease/avian/avian-influenza/hpai-detections/wild-birds" },
    aphisMammals: { t: "USDA APHIS. Detections of HPAI in mammals.", u: "https://www.aphis.usda.gov/livestock-poultry-disease/avian/avian-influenza/hpai-detections/mammals" },
    aphisPoultry: { t: "USDA APHIS. Confirmations of HPAI in commercial and backyard flocks.", u: "https://www.aphis.usda.gov/livestock-poultry-disease/avian/avian-influenza/hpai-detections/commercial-backyard-flocks" }
  };

  // Monthly share of APHIS wild-bird HPAI detections in Atlantic Flyway states, Jan..Dec (2022 to Nov 2026, normalized to the peak month).
  // Replaced at run time by data/detections.json "season" when the twice-daily job recomputes it.
  const SEASON_DEFAULT = [1418, 1334, 557, 273, 140, 176, 142, 111, 384, 311, 663, 847];

  const DAY = 864e5;
  const km = (a, b) => {   // great-circle distance, {lat, lon}
    const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  function seasonIndex(month, counts) {   // month 0..11
    const c = counts && counts.length === 12 ? counts : SEASON_DEFAULT, m = Math.max(...c);
    return m ? c[month] / m : 0;
  }

  // Wild-bird pressure at a place: detections fade with distance (10 km scale) and age (28-day half-life), 0..1
  function wildPressure(pt, detections, now) {
    let x = 0;
    (detections || []).forEach((d) => {
      const dist = km(pt, d); if (dist > 40) return;
      const age = Math.max(0, (now - d.t) / DAY); if (age > 120) return;
      x += Math.exp(-dist / 10) * Math.pow(0.5, age / 28);
    });
    return 1 - Math.exp(-x);
  }

  /* Seasonal risk (map layer).
   * risk = season x (0.55 wild-bird pressure + 0.45 waterfowl habitat)
   * - season: APHIS monthly detection pattern for the Atlantic Flyway (aphisWild)
   * - wild-bird pressure: recent nearby detections (usgs2025: spillover tracks proximity to infected wild birds)
   * - habitat: waterfowl concentration areas, refuges, WMAs, open water nearby (schreuder2022)
   */
  function seasonalRisk({ pt, month, seasonCounts, detections, habitat, now }) {
    const s = seasonIndex(month, seasonCounts), w = wildPressure(pt, detections, now), h = Math.max(0, Math.min(1, habitat || 0));
    const v = s * (0.55 * w + 0.45 * h);
    return { value: v, tier: v >= 0.45 ? 3 : v >= 0.25 ? 2 : v >= 0.1 ? 1 : 0, season: s, wild: w, habitat: h };
  }
  const TIERS = ["Low", "Moderate", "High", "Very high"];

  /* Is HPAI activity in the region rising? Detections (wild birds, mammals, flocks) in the last 14 days
   * compared with the 42 days before, as a daily rate. events: [{t (ms)}]
   */
  function regionalTrend(events, now) {
    let recent = 0, prior = 0;
    (events || []).forEach((e) => { const age = (now - e.t) / DAY; if (age < 0) return; if (age <= 14) recent++; else if (age <= 56) prior++; });
    const rRate = recent / 14, pRate = prior / 42, ratio = pRate ? rRate / pRate : recent ? Infinity : 0;
    return { recent, prior, ratio, rising: recent >= 3 && ratio >= 2, sharp: recent >= 5 && ratio >= 3 };
  }

  /* Farm risk score for growers (semi-qualitative, points).
   * inputs: zone ('control' | 'surveillance' | null), kmToArea (distance to nearest control area edge, km),
   *         wildNear (wild detections within 10 km in 28 days), wildCounty (any in the same county in 28 days),
   *         habitatKm (distance to nearest waterfowl area / open water), season (0..1),
   *         zoneVisits (visits in 14 days by vehicles that had been in a control area), visits (all logged visits in 14 days),
   *         audit: { date (ms), passed (bool) } or null,
 *         outbreaksNear (infected premises within 20 mi, last 30 days), countyOutbreak (a flock confirmed in this or a
 *         neighbouring county, 30 days), mammalsNear (mammal detections within 10 mi, 8 weeks), trend (regionalTrend)
   */
  function farmRisk(i, now) {
    const pts = [], add = (n, why, src) => pts.push({ n, why, src });
    if (i.zone === "control") add(4, "Inside a control area", "aphis2015");
    else if (i.zone === "surveillance") add(2, "Inside a surveillance zone", "aphis2015");
    else if (i.kmToArea != null && i.kmToArea <= 10) add(1, `Control area ${(i.kmToArea * 0.621371).toFixed(0)} mi away`, "aphis2015");
    if (i.zoneVisits > 0) add(3, `${i.zoneVisits} visit${i.zoneVisits > 1 ? "s" : ""} by vehicles from a control area (14 days)`, "aphis2015");
    else if (i.visits >= 5) add(1, `${i.visits} vehicle visits in 14 days`, "aphis2015");
    if (i.outbreaksNear >= 2) add(1, `${i.outbreaksNear} infected premises within 20 mi (30 days)`, "aphisPoultry");
    else if (!i.zone && (i.kmToArea == null || i.kmToArea > 10) && i.countyOutbreak) add(1, "Infected flock in your county or a neighbouring county (30 days)", "aphisPoultry");
    if (i.wildNear > 0) add(2, `${i.wildNear} wild-bird detection${i.wildNear > 1 ? "s" : ""} within 6 mi (4 weeks)`, "usgs2025");
    else if (i.wildCounty) add(1, "Wild-bird detection in the county (4 weeks)", "usgs2025");
    if (i.mammalsNear > 0) add(1, `${i.mammalsNear} infected mammal${i.mammalsNear > 1 ? "s" : ""} found within 10 mi (8 weeks)`, "aphisMammals");
    if (i.trend && i.trend.sharp) add(2, `Detections in the region rising fast: ${i.trend.recent} in 2 weeks, ${i.trend.ratio === Infinity ? "none" : "about " + Math.round(i.trend.ratio) + "× the rate"} before`, "usgs2025");
    else if (i.trend && i.trend.rising) add(1, `Detections in the region rising: ${i.trend.recent} in 2 weeks, ${i.trend.ratio === Infinity ? "none" : "about " + Math.round(i.trend.ratio) + "× the rate"} before`, "usgs2025");
    if (i.habitatKm != null && i.habitatKm <= 1) add(1, "Waterfowl habitat or open water within ½ mile", "schreuder2022");
    if (i.season >= 0.5) add(1, "Peak migration season", "aphisWild");
    if (i.audit && i.audit.passed && now - i.audit.date <= 365 * DAY) add(-1, "Passed a biosecurity audit in the last year", "aphis2015");
    else if (i.audit && !i.audit.passed) add(1, "Last biosecurity audit not passed", "aphis2015");
    else if (i.audit !== undefined) add(1, "No biosecurity audit in the last year", "aphis2015");
    const total = Math.max(0, pts.reduce((a, p) => a + p.n, 0));
    const tier = total >= 8 ? 3 : total >= 5 ? 2 : total >= 3 ? 1 : 0;
    return { points: total, tier, label: TIERS[tier], reasons: pts };
  }

  const api = { SOURCES, SEASON_DEFAULT, TIERS, km, seasonIndex, wildPressure, seasonalRisk, regionalTrend, farmRisk };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.HPAIRisk = api;
})(this);
