/* Maryland HPAI map: risk models (no map library needed; also runs in Node for tests).
 *
 * Both models are SCREENING aids, not predictions. They rank places so people can focus attention.
 * Every factor and weight is tied to a published source; see SOURCES and README "Risk models".
 */
(function (root) {
  const SOURCES = {
    aphis2015: { t: "USDA APHIS (Aug 2015). Highly pathogenic avian influenza: biosecurity factors associated with introduction and spread (case-control study of Midwest layer farms, 2015 H5N2).", u: "https://www.aphis.usda.gov/animal_health/downloads/animal_diseases/ai/hpai-biosecurity-factors-introduction-and-spread.pdf" },
    schreuder2022: { t: "Schreuder et al. (2022). Wild bird densities and landscape variables predict spatial patterns in HPAI outbreak risk across the Netherlands. Pathogens.", u: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9143584" },
    usgs2025: { t: "Gonnerman et al. (2025), University of Maryland, USDA and USGS. Avian influenza spillover into poultry: environmental influences and biosecurity protections. One Health 21:101172.", u: "https://doi.org/10.1016/j.onehlt.2025.101172" },
    aphisWild: { t: "USDA APHIS. Detections of HPAI in wild birds (monthly counts, Atlantic Flyway states).", u: "https://www.aphis.usda.gov/livestock-poultry-disease/avian/avian-influenza/hpai-detections/wild-birds" },
    aphisMammals: { t: "USDA APHIS. Detections of HPAI in mammals.", u: "https://www.aphis.usda.gov/livestock-poultry-disease/avian/avian-influenza/hpai-detections/mammals" },
    aphisPoultry: { t: "USDA APHIS. Confirmations of HPAI in commercial and backyard flocks.", u: "https://www.aphis.usda.gov/livestock-poultry-disease/avian/avian-influenza/hpai-detections/commercial-backyard-flocks" },
    prosser2024: { t: "Prosser et al. (2024), USGS, USDA and University of Maryland. Using an adaptive modeling framework to identify avian influenza spillover risk at the wild-domestic interface. Scientific Reports 14:14199.", u: "https://doi.org/10.1038/s41598-024-64912-w" },
    ebirdst: { t: "Fink et al. eBird Status and Trends, data version 2023. Cornell Lab of Ornithology. Weekly modelled relative abundance.", u: "https://science.ebird.org/en/status-and-trends" },
    ebird: { t: "eBird, Cornell Lab of Ornithology. Waterfowl reports (eBird API).", u: "https://ebird.org" },
    openMeteo: { t: "Open-Meteo historical weather API (ERA5 reanalysis), CC BY 4.0.", u: "https://open-meteo.com" }
  };

  /* Coefficients from Gonnerman et al. 2025 (usgs2025), final spatiotemporal model, per 1 SD of each covariate (log-odds):
   * bi-weekly waterfowl relative abundance +0.422, winter precipitation +0.642, winter mean temperature -1.242. */
  const COEF = { waterfowl: 0.422, precip: 0.642, temp: -1.242 };
  // Assumption (not from a paper): wild-bird HPAI detections stand in for the infection-prevalence factor of Prosser et al. 2024,
  // and at most double the risk. Change here if MDA prefers another weight.
  const WILD_MAX = 1;
  
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

  /* ---- waterfowl abundance from eBird places ----
   * A week's places: [{lat, lon, birds}]. Abundance at a point = birds at each place, fading with distance
   * (3 km scale, matching the 3 km eBird abundance grid in usgs2025), counted up to 10 km away.
   * Places are bucketed on a ~0.12 degree grid so a whole map of hexagons stays fast. */
  const CELL = 0.12;
  function indexPlaces(places) {
    const cells = new Map();
    (places || []).forEach((p) => {
      if (!(p && p.birds > 0)) return;
      const k = Math.floor(p.lat / CELL) + ":" + Math.floor(p.lon / CELL);
      (cells.get(k) || cells.set(k, []).get(k)).push(p);
    });
    return cells;
  }
  function waterfowlAt(pt, idx) {
    const r = Math.floor(pt.lat / CELL), c = Math.floor(pt.lon / CELL);
    let a = 0;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      (idx.get((r + i) + ":" + (c + j)) || []).forEach((p) => { const d = km(pt, p); if (d <= 10) a += p.birds * Math.exp(-d / 3); });
    }
    return a;
  }
  // usgs2025: weekly abundance, log-transformed, averaged over two weeks. weeks: the two latest indexed weeks.
  function abundanceIndex(pt, weeks) {
    const w = (weeks || []).filter(Boolean);
    return w.length ? w.reduce((s, idx) => s + Math.log1p(waterfowlAt(pt, idx)), 0) / w.length : null;
  }
  // Reference for standardizing (z-scores): every point x every consecutive pair of archived weeks.
  // As the eBird archive grows through the year, summer lows and winter highs both enter the reference.
  function abundanceRef(points, weeks) {
    let n = 0, s = 0, s2 = 0;
    for (let k = 1; k < (weeks || []).length; k++) {
      const pair = [weeks[k - 1], weeks[k]];
      (points || []).forEach((pt) => { const x = abundanceIndex(pt, pair); n++; s += x; s2 += x * x; });
    }
    if (n < 2) return null;
    const mu = s / n, sd = Math.sqrt(Math.max(1e-9, s2 / n - mu * mu));
    return { mu, sd, weeks: (weeks || []).length };
  }

  /* Statewide winter weather (tools/update_weather.py writes data/weather.json: zT, zP = this winter so far vs 1991-2020).
   * usgs2025 used Dec-Jan weather as a property of the season; here it applies Dec-Apr (the winter and the spring
   * migration that follows it) and is neutral May-Nov. z is capped at +/-2 because Maryland's year-to-year swings
   * are smaller than the continent-wide differences the coefficients were estimated on. */
  function weatherFactor(weather, month) {
    const applies = [11, 0, 1, 2, 3].includes(month) && weather && weather.status === "ok";
    if (!applies) return { factor: 1, applies: false };
    const cap = (z) => Math.max(-2, Math.min(2, Number(z) || 0));
    const zT = cap(weather.zT), zP = cap(weather.zP);
    return { factor: Math.exp(COEF.temp * zT + COEF.precip * zP), applies: true, zT, zP };
  }

  /* Seasonal risk (map layer, address card, alerts). EXPERIMENTAL: adapted from Gonnerman et al. 2025 (usgs2025), not validated.
   *   relative risk = exp(0.422 x zA)
   * - Waterfowl abundance as in usgs2025: eBird Status & Trends modelled weekly relative abundance (not sightings), summed over
   *   species in the paper's 13 genera (geese, swans, dabbling and diving ducks), averaged over two weeks, natural log, z-score.
   *   Data: data/waterfowl_st.json from tools/build_ebirdst.py (about 3 km grid; a hexagon averages the cells within 3.5 km).
   * - zA is standardized against every grid cell and week of a typical year in Maryland / Delmarva (st.ref), capped at +/-3;
   *   no waterfowl at all -> -3. usgs2025 standardized across its US study locations, which are not published.
   * - Tiers: z at the 75th, 90th and 97.5th percentiles of that same typical year (st.ref.cut), i.e. Moderate = top 25%,
   *   High = top 10%, Very high = top 2.5% of place-weeks. usgs2025 publishes no thresholds.
   * Left out, because they are not in the paper's form or need data we do not have: winter weather (the paper compares places
   * across the US, not this winter with past ones), wild-bird detections (not in the paper; shown as their own layer),
   * the spatial / temporal random effects and the farm-type intercepts.
   */
  // Status & Trends week (0..51) for a date: week 1 is 1-7 January.
  const stWeek = (d) => { const t = new Date(d), y0 = Date.UTC(t.getUTCFullYear(), 0, 1); return Math.min(51, Math.floor((t - y0) / (7 * DAY))); };
  // data/waterfowl_st.json -> { all: [52 x Float32Array of cells], ref, ... }; all = goose + duck, in the file's units
  function prepareST(doc) {
    if (!doc || !doc.data_goose || !doc.ref) return null;
    const n = doc.nx * doc.ny, sc = doc.scale || 1;
    const all = doc.data_goose.map((g, w) => { const d = doc.data_duck && doc.data_duck[w], a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = (g[i] + (d ? d[i] : 0)) / sc; return a; });
    return { nx: doc.nx, ny: doc.ny, bbox: doc.bbox, step: doc.step, ref: doc.ref, year: doc.year, all };
  }
  // Mean abundance of the grid cells whose centres are within r km of pt, in one week
  function stAbundance(st, pt, week, r = 3.5) {
    const [x0, , , y1] = st.bbox, [dx, dy] = st.step, v = st.all[week];
    const ci = Math.floor((pt.lon - x0) / dx), cj = Math.floor((y1 - pt.lat) / dy);
    let s = 0, n = 0;
    for (let j = cj - 2; j <= cj + 2; j++) for (let i = ci - 2; i <= ci + 2; i++) {
      if (i < 0 || j < 0 || i >= st.nx || j >= st.ny) continue;
      if (km(pt, { lon: x0 + (i + 0.5) * dx, lat: y1 - (j + 0.5) * dy }) > r) continue;
      s += v[j * st.nx + i]; n++;
    }
    return n ? s / n : null;
  }
  function seasonalRisk({ pt, st, date }) {
    if (!st) return { value: 1, tier: 0, zA: 0, abundance: null, waterfowl: 1, hasData: false };
    const w = stWeek(date || Date.now());
    const a1 = stAbundance(st, pt, w), a0 = stAbundance(st, pt, (w + 51) % 52);
    if (a1 == null) return { value: 1, tier: 0, zA: 0, abundance: null, waterfowl: 1, hasData: false, week: w + 1 };
    const a = (a1 + a0) / 2, ref = st.ref, cut = ref.cut;
    const zA = a > 0 ? Math.max(-3, Math.min(3, (Math.log(a) - ref.mu) / ref.sd)) : -3;
    const v = Math.exp(COEF.waterfowl * zA);
    const tier = zA >= cut[2] ? 3 : zA >= cut[1] ? 2 : zA >= cut[0] ? 1 : 0;
    return { value: v, tier, zA, abundance: a, waterfowl: v, hasData: true, week: w + 1 };
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
    else if (i.kmToArea != null && i.kmToArea <= 10) add(1, `Control area ${(i.kmToArea * 0.621371).toFixed(i.kmToArea < 16 ? 1 : 0)} mi away`, "aphis2015");
    if (i.zoneVisits > 0) add(3, `${i.zoneVisits} visit${i.zoneVisits > 1 ? "s" : ""} by vehicles from a control area (14 days)`, "aphis2015");
    else if (i.visits >= 5) add(1, `${i.visits} vehicle visits in 14 days`, "aphis2015");
    if (i.outbreaksNear >= 2) add(1, `${i.outbreaksNear} infected premises within 20 mi (30 days)`, "aphisPoultry");
    else if (!i.zone && (i.kmToArea == null || i.kmToArea > 10) && i.countyOutbreak) add(1, "Infected flock in your county or a neighbouring county (30 days)", "aphisPoultry");
    if (i.wildNear > 0) add(2, `${i.wildNear} wild-bird detection${i.wildNear > 1 ? "s" : ""} within about 6 mi (4 weeks; county-level locations)`, "usgs2025");
    else if (i.wildCounty) add(1, "Wild-bird detection in the county (4 weeks)", "usgs2025");
    if (i.mammalsNear > 0) add(1, `${i.mammalsNear} infected mammal${i.mammalsNear > 1 ? "s" : ""} found within 10 mi (8 weeks)`, "aphisMammals");
    if (i.trend && i.trend.sharp) add(2, `Detections in the region rising fast: ${i.trend.recent} in 2 weeks, ${i.trend.ratio === Infinity ? "none" : "about " + Math.round(i.trend.ratio) + "× the rate"} before`, "usgs2025");
    else if (i.trend && i.trend.rising) add(1, `Detections in the region rising: ${i.trend.recent} in 2 weeks, ${i.trend.ratio === Infinity ? "none" : "about " + Math.round(i.trend.ratio) + "× the rate"} before`, "usgs2025");
    if (i.habitatKm != null && i.habitatKm <= 1) add(1, "Waterfowl habitat within 1 km (0.6 mi)", "schreuder2022");
    if (i.season >= 0.5) add(1, "Peak migration season", "aphisWild");
    if (i.audit && i.audit.passed && now - i.audit.date <= 365 * DAY) add(-1, "Passed a biosecurity audit in the last year", "aphis2015");
    else if (i.audit && !i.audit.passed) add(1, "Last biosecurity audit not passed", "aphis2015");
    else if (i.audit !== undefined) add(1, "No biosecurity audit in the last year", "aphis2015");
    const total = Math.max(0, pts.reduce((a, p) => a + p.n, 0));
    const tier = total >= 8 ? 3 : total >= 5 ? 2 : total >= 3 ? 1 : 0;
    return { points: total, tier, label: TIERS[tier], reasons: pts };
  }

  const api = { SOURCES, SEASON_DEFAULT, TIERS, COEF, km, seasonIndex, wildPressure, indexPlaces, waterfowlAt, abundanceIndex, abundanceRef, weatherFactor, stWeek, prepareST, stAbundance, seasonalRisk, regionalTrend, farmRisk };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.HPAIRisk = api;
})(this);
