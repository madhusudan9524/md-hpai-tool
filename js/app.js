/* Maryland HPAI map: core (map, layers, roles, layers panel, click card, time slider, seasonal risk).
 * Feature modules (public.js, hauler.js, mda.js) plug in through ctx: see HPAI.modules.
 */
require([
  "esri/config", "esri/Map", "esri/views/MapView", "esri/layers/FeatureLayer", "esri/layers/GraphicsLayer", "esri/layers/MapImageLayer",
  "esri/layers/WMSLayer", "esri/Graphic", "esri/geometry/geometryEngine", "esri/geometry/support/webMercatorUtils", "esri/geometry/Point",
  "esri/geometry/Polygon", "esri/geometry/Extent", "esri/widgets/Search", "esri/widgets/Home", "esri/widgets/TimeSlider",
  "esri/identity/OAuthInfo", "esri/identity/IdentityManager", "esri/portal/Portal", "esri/core/reactiveUtils", "esri/widgets/Sketch/SketchViewModel"
], (esriConfig, EsriMap, MapView, FeatureLayer, GraphicsLayer, MapImageLayer, WMSLayer, Graphic, geometryEngine, wmu, Point, Polygon, Extent,
    Search, Home, TimeSlider, OAuthInfo, esriId, Portal, reactiveUtils, SketchViewModel) => {
  const H = window.HPAI, C = window.HPAI_CONFIG, R = window.HPAIRisk;
  const { $, esc, DAY, fmtDate, fmtShort, toast, store } = H;
  const has = (u) => typeof u === "string" && u.length > 8;
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (dark) $("esriTheme").href = "https://js.arcgis.com/4.31/esri/themes/dark/main.css";

  // ---------------- sign-in ----------------
  const oauth = new OAuthInfo({ appId: C.appId, portalUrl: C.portalUrl, popup: false });
  esriId.registerOAuthInfos([oauth]);
  const sharing = C.portalUrl + "/sharing";

  // ---------------- small event bus for modules ----------------
  const handlers = {};
  const on = (ev, fn) => ((handlers[ev] = handlers[ev] || []).push(fn));
  const emit = (ev, d) => (handlers[ev] || []).map((fn) => { try { return fn(d); } catch (e) { console.error(ev, e); } });

  // ---------------- layers ----------------
  const COUNTY_URL = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Counties_Generalized_Boundaries/FeatureServer/0";
  const DELMARVA = "STATE_NAME IN ('Maryland','Delaware') OR (STATE_NAME = 'Virginia' AND NAME IN ('Accomack County','Northampton County'))";
  const RED = [200, 40, 30], AMBER = [217, 138, 0], TEAL = [19, 128, 143], DRED = [122, 15, 15];
  const fill = (c, a, oc, ow, st) => ({ type: "simple-fill", color: c.concat(a), outline: { color: (oc || c).concat(oc ? [] : [0.95]).slice(0, 4), width: ow || 1.2, style: st || "solid" } });

  const maskLyr = new GraphicsLayer({ listMode: "hide" });
  const tintLyr = new GraphicsLayer({ title: "Affected counties" });
  const countyLyr = new FeatureLayer({
    url: COUNTY_URL, definitionExpression: DELMARVA, outFields: ["NAME", "STATE_NAME"], popupEnabled: false,
    renderer: { type: "simple", symbol: { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: dark ? [180, 190, 205, 0.7] : [70, 85, 105, 0.6], width: 1 } } },
    labelingInfo: [{ labelExpressionInfo: { expression: "Replace($feature.NAME, ' County', '')" }, symbol: { type: "text", color: dark ? [225, 232, 240, 1] : [45, 58, 75, 1], haloColor: dark ? [13, 17, 23, 0.9] : [255, 255, 255, 0.9], haloSize: 1.5, font: { size: 11, weight: "bold", family: "Avenir Next LT Pro" } } }]
  });

  // environmental reference layers (official public services)
  const env = {
    wetlands: new MapImageLayer({ url: C.env.wetlands, title: "Wetlands (USFWS NWI)", visible: false, opacity: 0.7 }),
    land: new WMSLayer({ url: C.env.forestWms.url, sublayers: [{ name: C.env.forestWms.layer }], title: "Forests & land cover (NLCD 2021)", visible: false, opacity: 0.55 }),
    water: new MapImageLayer({ url: C.env.nhd, title: "Lakes and ponds (USGS NHD)", visible: false, sublayers: C.env.nhdWater.map((id) => ({ id, visible: true })) }),
    rivers: new MapImageLayer({ url: C.env.nhd, title: "Rivers and streams (USGS NHD)", visible: false, sublayers: C.env.nhdRivers.map((id) => ({ id, visible: true })) }),
    sheds: new MapImageLayer({ url: C.env.wbd, title: "Watersheds HUC-12 (USGS WBD)", visible: false, sublayers: [{ id: C.env.wbdLayer, visible: true }] }),
    wma: new FeatureLayer({ url: C.env.wma, definitionExpression: "DESIG = 'WMA'", title: "Wildlife management areas (MD DNR)", visible: false, outFields: ["DNRName"],
      renderer: { type: "simple", symbol: fill([132, 160, 60], 0.35, [106, 138, 42, 1], 1) }, popupTemplate: { title: "{DNRName}", content: "Wildlife Management Area · Maryland DNR" } }),
    waterfowl: new FeatureLayer({ url: C.env.waterfowl, title: "Waterfowl concentration areas (MD DNR)", visible: false,
      renderer: { type: "simple", symbol: { type: "simple-fill", style: "forward-diagonal", color: TEAL.concat(0.6), outline: { color: TEAL.concat(1), width: 1 } } }, popupTemplate: { title: "Waterfowl concentration / staging area", content: "Atlantic Flyway waterfowl area mapped by Maryland DNR." } }),
    refuges: new FeatureLayer({ url: C.env.refuges, title: "National wildlife refuges (USFWS)", visible: false, outFields: ["*"],
      renderer: { type: "simple", symbol: fill([70, 130, 90], 0.28, [70, 130, 90, 1], 1) }, popupTemplate: { title: "{ORGNAME}", content: "U.S. Fish and Wildlife Service" } })
  };

  // outbreak layers: public read-only view when configured, otherwise the prototype layers (sign-in needed)
  const L = {};   // filled in buildOutbreakLayers()
  const riskLyr = new GraphicsLayer({ title: "Seasonal risk", visible: false, opacity: 0.75 });
  const histLyr = new GraphicsLayer({ title: "Past outbreak areas", visible: false });
  const closuresLyr = new GraphicsLayer({ title: "Road closures (MDOT CHART)", visible: false });
  const wild = new FeatureLayer({
    title: "Wild birds with HPAI", source: [], objectIdField: "OID", geometryType: "point", spatialReference: { wkid: 4326 }, outFields: ["*"],
    fields: [{ name: "OID", type: "oid" }, { name: "state", type: "string" }, { name: "county", type: "string" }, { name: "species", type: "string" }, { name: "strain", type: "string" }, { name: "detected", type: "date" }, { name: "age", type: "integer" }],
    renderer: { type: "simple", symbol: { type: "simple-marker", size: 9, color: TEAL.concat(0.95), outline: { color: [255, 255, 255, 1], width: 1.5 } },
      visualVariables: [{ type: "opacity", field: "age", stops: [{ value: 0, opacity: 1 }, { value: 28, opacity: 0.9 }, { value: 365, opacity: 0.35 }] }] },
    popupEnabled: false
  });
  const routeLyr = new GraphicsLayer({ listMode: "hide" }), marks = new GraphicsLayer({ listMode: "hide" });

  const map = new EsriMap({ basemap: dark ? "dark-gray-vector" : "topo-vector",
    layers: [maskLyr, env.land, env.wetlands, env.water, env.rivers, env.sheds, env.wma, env.waterfowl, env.refuges, riskLyr, tintLyr, countyLyr, histLyr] });
  const view = new MapView({ container: "viewDiv", map, center: C.center, zoom: C.zoom, constraints: { minZoom: 7, snapToZoom: false },
    popup: { dockEnabled: false, dockOptions: { buttonEnabled: false }, collapseEnabled: false, visibleElements: { closeButton: true, featureNavigation: false, actionBar: false, heading: false, collapseButton: false, spinner: false }, highlightEnabled: false, actions: [] }, ui: { components: ["zoom", "attribution"] } });
  view.ui.move("zoom", "bottom-right");
  view.ui.add(new Home({ view }), "bottom-right");

  // ---------------- state ----------------
  const S = { ws: "public", user: null, groups: [], roles: [], live: null, mdGeom: null, clearGeom: null, counties: [], areas: [], season: null };
  const ctx = { H, C, R, S, view, map, on, emit, has, esriId, sharing, dark,
    esri: { FeatureLayer, GraphicsLayer, Graphic, geometryEngine, wmu, Point, Polygon, Extent, Search, reactiveUtils, SketchViewModel },
    layers: { L, env, wild, riskLyr, histLyr, closuresLyr, routeLyr, marks, tintLyr, countyLyr }, actions: {} };
  ctx.isStaff = () => S.ws === "regulator";
  ctx.signedIn = () => !!S.user;
  ctx.token = () => { const c = esriId.findCredential(sharing); return c && c.token; };

  // ArcGIS REST helper (POST form, token added when signed in)
  ctx.rest = async (url, params, opts) => {
    const body = new URLSearchParams(Object.assign({ f: "json" }, params || {}));
    const t = ctx.token(); if (t && !(opts && opts.anon)) body.set("token", t);
    const r = await fetch(url, { method: "POST", body }); const j = await r.json();
    if (j.error) throw new Error(j.error.message + (j.error.details && j.error.details.length ? ": " + j.error.details.join("; ") : ""));
    return j;
  };
  // audit log (MDA actions): best effort; never blocks the action
  ctx.audit = (action, target, details) => {
    if (!has(C.core.audit) || !S.user) return Promise.resolve();
    return ctx.rest(C.core.audit + "/applyEdits", { adds: JSON.stringify([{ attributes: { at: Date.now(), who: S.user.username, action, target: String(target || "").slice(0, 250), details: String(details || "").slice(0, 1000) } }]) }).catch(() => {});
  };

  // ---------------- Maryland only (Delmarva clear; everything else faded) ----------------
  const ready = countyLyr.queryFeatures({ where: DELMARVA, outFields: ["NAME", "STATE_NAME"], returnGeometry: true, outSpatialReference: { wkid: 102100 } }).then((r) => {
    S.counties = r.features.map((f) => ({ name: f.attributes.NAME.replace(" County", ""), state: f.attributes.STATE_NAME, geom: f.geometry }));
    const md = S.counties.filter((c) => c.state === "Maryland");
    S.mdGeom = geometryEngine.union(md.map((c) => c.geom));
    S.clearGeom = geometryEngine.union(S.counties.map((c) => c.geom));
    const ext = S.mdGeom.extent.clone();
    view.constraints.geometry = S.clearGeom.extent.clone().expand(1.25);
    const w = 20037508, world = new Polygon({ rings: [[[-w, -w], [-w, w], [w, w], [w, -w], [-w, -w]]], spatialReference: { wkid: 102100 } });
    maskLyr.add(new Graphic({ geometry: geometryEngine.difference(world, S.clearGeom), symbol: { type: "simple-fill", color: dark ? [13, 17, 23, 0.72] : [244, 246, 249, 0.8], outline: { color: [0, 0, 0, 0] } } }));
    if (!location.hash) view.goTo(ext.expand(1.05), { animate: false }).catch(() => {});
    return S;
  });
  ctx.ready = ready;
  ctx.inArea = (pt) => !S.clearGeom || geometryEngine.contains(S.clearGeom, pt);
  ctx.countyAt = (pt) => S.counties.find((c) => geometryEngine.contains(c.geom, pt)) || null;

  // county names fade out as you zoom in; surveillance zones fade in (public)
  function fadeByZoom() {
    const z = view.zoom, k = (a, b) => Math.max(0, Math.min(1, (z - a) / (b - a)));
    countyLyr.opacity = 1 - k(9, 11.5);
    tintLyr.opacity = 1 - 0.7 * k(9, 11.5);
    if (L.sz) L.sz.opacity = ctx.isStaff() ? 1 : k(8.6, 10);
  }
  reactiveUtils.watch(() => view.zoom, fadeByZoom);

  // ---------------- outbreak layers ----------------
  function zoneLayer(url, type, extra) {
    return new FeatureLayer(Object.assign({ url, outFields: ["*"], popupEnabled: false,
      definitionExpression: `zone_type = '${type}' AND status = 'Active'`,
      renderer: { type: "simple", symbol: type === "Control Area" ? fill(RED, 0.3, RED.concat(0.95), 1.6) : fill(AMBER, 0.14, AMBER.concat(0.95), 1.4, "dash") } }, extra || {}));
  }
  function buildOutbreakLayers() {
    ["ca", "sz", "markers", "decl", "prem", "perim", "zonesAll"].forEach((k) => { if (L[k]) { map.remove(L[k]); delete L[k]; } });
    const pub = has(C.pub.areas), signed = !!S.user;
    const areasUrl = pub ? C.pub.areas : signed ? C.legacy.zones : null;
    if (areasUrl) {
      L.sz = zoneLayer(areasUrl, "Surveillance Zone", { title: "Surveillance zone" });
      L.ca = zoneLayer(areasUrl, "Control Area", { title: "Control area" });
      map.addMany([L.sz, L.ca], map.layers.indexOf(histLyr) + 1);
    }
    if (has(C.pub.markers)) {
      L.markers = new FeatureLayer({ url: C.pub.markers, title: "Infected premises (approximate)", outFields: ["*"], popupEnabled: false, definitionExpression: "status = 'Active'",
        renderer: { type: "simple", symbol: { type: "simple-marker", size: 16, color: DRED.concat(0.85), outline: { color: [255, 255, 255, 0.95], width: 2 } } } });
      map.add(L.markers);
    }
    if (has(C.pub.declarations)) {
      L.decl = new FeatureLayer({ url: C.pub.declarations, outFields: ["*"], popupEnabled: false, definitionExpression: "status <> 'Withdrawn'", visible: false });   // read only; drawn into tintLyr
      L.decl.load().catch(() => {});
    }
    if (ctx.isStaff()) {
      const premUrl = has(C.core.premises) ? C.core.premises : C.legacy.premises, perimUrl = has(C.core.perimeters) ? C.core.perimeters : C.legacy.perimeters;
      L.perim = new FeatureLayer({ url: perimUrl, title: "Premises boundary", outFields: ["*"], popupEnabled: false, renderer: { type: "simple", symbol: fill(DRED, 0.45, DRED.concat(1), 1.5) }, minScale: 300000 });
      L.prem = new FeatureLayer({ url: premUrl, title: "Infected premises (exact)", outFields: ["*"], popupEnabled: false,
        renderer: { type: "unique-value", field: "status", defaultSymbol: { type: "simple-marker", style: "diamond", size: 15, color: DRED.concat(1), outline: { color: [255, 255, 255, 1], width: 1.5 } },
          uniqueValueInfos: [{ value: "Released", symbol: { type: "simple-marker", style: "diamond", size: 11, color: [140, 140, 150, 0.9], outline: { color: [255, 255, 255, 1], width: 1 } } }] } });
      map.addMany([L.perim, L.prem]);
    }
    [wild, closuresLyr, routeLyr, marks].forEach((l) => { map.remove(l); map.add(l); });
    fadeByZoom(); refreshAreas(); renderKey(); emit("layers", L);
  }
  ctx.buildOutbreakLayers = buildOutbreakLayers;

  // active areas (for counts, county tint, click card, alerts)
  async function refreshAreas() {
    S.areas = [];
    if (L.ca) {
      try {
        const r = await L.ca.queryFeatures({ where: L.ca.definitionExpression, outFields: ["*"], returnGeometry: true, outSpatialReference: { wkid: 102100 } });
        S.areas = r.features;
      } catch (e) { /* not signed in / layer missing */ }
    }
    S.sample = S.areas.some((f) => f.attributes.sample === 1);
    $("sampleBadge").hidden = !S.sample;
    paintCounties(); emit("areas", S.areas);
  }
  ctx.refreshAreas = refreshAreas;

  // ---- affected counties: commercial detections + MDA declarations (+ counties containing an active control area) ----
  S.affected = [];
  async function paintCounties() {
    await ready; tintLyr.removeAll();
    const cutoff = Date.now() - (C.tintDays || 30) * DAY, aff = new globalThis.Map();
    const mark = (st, name, info) => { const c = S.counties.find((x) => x.state === st && x.name === name); if (!c) return; const k = st + name; const o = aff.get(k) || { c, items: [] }; o.items.push(info); aff.set(k, o); };
    ((S.live && S.live.commercial) || []).forEach((d) => { const t = Date.parse(d.date + "T12:00:00Z"); if (t >= cutoff) mark(d.state, d.county, { kind: "detection", t, status: d.status, text: d.status_text || "", flock: d.flock, source: d.source, url: d.url }); });
    if (L.decl) {
      try { (await L.decl.queryFeatures({ where: L.decl.definitionExpression, outFields: ["*"], returnGeometry: false })).features.forEach((f) => { const a = f.attributes; mark(a.state || "Maryland", a.county, { kind: "declaration", t: a.declared, status: a.status, text: a.status_text, url: a.source_url }); }); } catch (e) {}
    }
    S.areas.forEach((f) => { const c = S.counties.find((x) => geometryEngine.contains(x.geom, f.geometry.extent.center)); if (c) mark(c.state, c.name, { kind: "zone", sample: f.attributes.sample === 1, t: f.attributes.since || f.attributes.confirmed_date || f.attributes.created_date }); });
    S.affected = [...aff.values()].map((o) => ({ county: o.c.name, state: o.c.state, geom: o.c.geom, items: o.items, since: Math.min(...o.items.map((i) => i.t || Date.now())) })).sort((a, b) => b.since - a.since);
    S.affected.forEach((a) => tintLyr.add(new Graphic({ geometry: a.geom, attributes: { county: a.county }, symbol: fill(RED, 0.12, RED.concat(0.45), 1) })));
    emit("affected", S.affected); kpis();
  }
  ctx.paintCounties = paintCounties;

  // ---------------- live data (official sources, refreshed twice a day) ----------------
  const live = fetch((C.dataUrl || "data/detections.json") + "?t=" + Date.now()).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  ctx.live = live;
  S.wildRange = store.get("wildRange", 28);
  async function loadWild() {
    const Ld = await live; if (!Ld) return;
    const old = await wild.queryFeatures({ where: "1=1", returnGeometry: false, outFields: ["OID"] }).catch(() => ({ features: [] }));
    const rows = (Ld.wild_year || Ld.wild || []).map((w) => ({ w, t: Date.parse(w.date + "T12:00:00Z") })).filter((o) => Date.now() - o.t <= S.wildRange * DAY);
    await wild.applyEdits({ deleteFeatures: old.features, addFeatures: rows.map(({ w, t }) => new Graphic({ geometry: { type: "point", x: w.lon, y: w.lat, spatialReference: { wkid: 4326 } }, attributes: { state: w.state, county: w.county, species: w.species, strain: w.strain, detected: t, age: Math.round((Date.now() - t) / DAY) } })) }).catch(() => {});
    S.wildPts = (Ld.wild_year || Ld.wild || []).map((w) => ({ lat: w.lat, lon: w.lon, t: Date.parse(w.date + "T12:00:00Z"), county: w.county, state: w.state, species: w.species }));
    kpis(); emit("wild", S.wildPts);
  }
  ctx.loadWild = loadWild;
  live.then((Ld) => {
    S.live = Ld;
    if (!Ld) { $("newsList").innerHTML = `<p class="hint">Notices are unavailable right now.</p>`; return; }
    S.season = Ld.season || null;
    $("liveBadge").hidden = false;
    $("updated").textContent = "updated " + new Date(Ld.updated).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    renderNews(Ld); loadWild(); paintCounties(); emit("live", Ld);
  });

  const KIND = { commercial: ["Commercial flock", "red"], backyard: ["Backyard flock", "amber"], wild: ["Wild birds", "teal"], general: ["Notice", ""] };
  const short = (s) => (s || "").replace("Maryland Department of Agriculture", "MDA").replace("Delaware Department of Agriculture", "DDA").replace("Virginia Department of Agriculture and Consumer Services", "VDACS");
  function renderNews(Ld) {
    const seen = new Set(), items = (Ld.notices || []).filter((n) => { const k = n.title.toLowerCase().replace(/[^a-z]/g, "").slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
    $("newsList").innerHTML = items.length ? items.map((n) => {
      const k = KIND[n.kind] || KIND.general, st = n.status === "confirmed" ? " · Confirmed" : n.status === "preliminary" ? " · Preliminary" : "";
      return `<a class="nw" href="${esc(n.url)}" target="_blank" rel="noopener"><div class="nt">${esc(n.title)}</div><div class="nm"><span class="pill ${k[1]}">${k[0]}${st}</span><span>${esc(short(n.source))} · ${fmtShort(Date.parse(n.date + "T12:00:00Z"))}</span></div></a>`;
    }).join("") : `<p class="hint">No recent notices.</p>`;
  }

  function kpis() {
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v == null ? "–" : v; };
    set("kCA", S.areas.length); set("kCty", S.affected.length);
    set("kWild", (S.wildPts || []).filter((w) => Date.now() - w.t <= 28 * DAY).length);
  }
  ctx.kpis = kpis;

  // ---------------- search (address autocomplete, Maryland + Delmarva only) ----------------
  const delmarvaExt = new Extent({ xmin: -79.6, ymin: 37.0, xmax: -74.9, ymax: 39.85, spatialReference: { wkid: 4326 } });
  ctx.makeSearch = (container, placeholder, onPick) => {
    const s = new Search({ view: onPick ? null : view, container, includeDefaultSources: false, popupEnabled: false, resultGraphicEnabled: false, locationEnabled: false, minSuggestCharacters: 2,
      sources: [{ url: "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer", name: "Address", placeholder, singleLineFieldName: "SingleLine", filter: { geometry: delmarvaExt }, maxSuggestions: 6, suggestionsEnabled: true, withinViewEnabled: false, countryCode: "USA", zoomScale: 24000 }] });
    s.on("select-result", (e) => { if (e.result && onPick) onPick(e.result.feature.geometry, e.result.name); });
    return s;
  };
  const search = ctx.makeSearch("search", "Search an address or place");
  search.view = view;
  search.on("select-result", (e) => { if (e.result) setTimeout(() => locationCard(e.result.feature.geometry, e.result.name), 400); });
  $("locBtn").onclick = () => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => { const pt = new Point({ longitude: p.coords.longitude, latitude: p.coords.latitude }); view.goTo({ target: pt, zoom: 12 }); locationCard(pt, "Your location"); }, () => toast("Location not available")) : toast("Location not available");

  // ---------------- status of a place ----------------
  // Which public zone a point is in, using the zone layers the viewer is allowed to see
  ctx.zoneAt = async (pt) => {
    const q = async (lyr) => (lyr ? (await lyr.queryFeatures({ geometry: pt, spatialRelationship: "intersects", where: lyr.definitionExpression, outFields: ["*"], returnGeometry: false }).catch(() => ({ features: [] }))).features : []);
    const [ca, sz] = await Promise.all([q(L.ca), q(L.sz)]);
    return ca.length ? { zone: "control", f: ca[0] } : sz.length ? { zone: "surveillance", f: sz[0] } : { zone: null };
  };
  ctx.distToArea = (pt) => {
    if (!S.areas.length) return null;
    const p = pt.spatialReference.isWebMercator ? pt : wmu.geographicToWebMercator(pt);
    return Math.min(...S.areas.map((f) => geometryEngine.distance(f.geometry, p, "kilometers")));
  };
  ctx.wildNear = (pt, kmR, days) => { const g = pt.spatialReference.isWGS84 ? pt : wmu.webMercatorToGeographic(pt), p = { lat: g.latitude, lon: g.longitude }; return (S.wildPts || []).filter((w) => Date.now() - w.t <= days * DAY && R.km(p, w) <= kmR); };
  ctx.seasonNow = () => R.seasonIndex(new Date().getMonth(), S.season);

  const DO = {
    control: ["Moving poultry, eggs, feed, litter or equipment in or out needs an MDA permit.", "Keep birds indoors and away from wild birds.", "Report sick or dead birds right away."],
    surveillance: ["Watch your birds closely and report illness.", "Movements may need testing. Check with MDA before moving birds.", "Clean and disinfect vehicles and boots."],
    none: ["No movement restrictions here today.", "Keep birds away from wild waterfowl.", "Report sick or dead birds."]
  };
  async function fitCard(pt) {
    const sp = view.toScreen(pt); if (!sp) return;
    const need = Math.min(430, view.height * 0.62);
    if (sp.y < need || sp.x < 200 || sp.x > view.width - 200) {
      const dy = Math.max(0, need - sp.y), dx = sp.x < 200 ? 200 - sp.x : sp.x > view.width - 200 ? view.width - 200 - sp.x : 0;
      const c = view.toScreen(view.center); await view.goTo(view.toMap({ x: c.x - dx, y: c.y - dy }), { duration: 250 }).catch(() => {});
    }
  }
  ctx.fitCard = fitCard;
  async function locationCard(pt, title) {
    if (!ctx.inArea(pt)) return;
    marks.removeAll(); marks.add(new Graphic({ geometry: pt, symbol: { type: "simple-marker", size: 14, color: [10, 108, 255, 1], outline: { color: [255, 255, 255, 1], width: 3 } } }));
    const z = await ctx.zoneAt(pt), cty = ctx.countyAt(wmu.geographicToWebMercator(pt.spatialReference.isWGS84 ? pt : wmu.webMercatorToGeographic(pt)));
    const aff = cty && S.affected.find((a) => a.county === cty.name && a.state === cty.state);
    const wildN = ctx.wildNear(pt, 10, 28).length, wildY = ctx.wildNear(pt, 10, 365).length;
    const g = pt.spatialReference.isWGS84 ? pt : wmu.webMercatorToGeographic(pt);
    const sr = R.seasonalRisk({ pt: { lat: g.latitude, lon: g.longitude }, month: new Date().getMonth(), seasonCounts: S.season, detections: S.wildPts, habitat: await habitatAt(g), now: Date.now() });
    const hist = await pastAt(pt);
    const smp = z.f && z.f.attributes.sample === 1 ? " · SAMPLE (exercise data)" : "";
    const band = z.zone === "control" ? ["ca", "Inside a control area"] : z.zone === "surveillance" ? ["sz", "Inside a surveillance zone"] : ["free", aff ? "Not in a zone" : "No restrictions"];
    const since = z.f && (z.f.attributes.since || z.f.attributes.confirmed_date || z.f.attributes.created_date);
    let rows = `<div class="r"><span>County</span><b>${cty ? esc(cty.name) + (cty.state !== "Maryland" ? ", " + esc(cty.state) : "") : "–"}</b></div>`;
    if (since) rows += `<div class="r"><span>Zone since</span><b>${fmtDate(since)} · day ${Math.max(1, Math.floor((Date.now() - since) / DAY) + 1)}</b></div>`;
    if (aff) rows += `<div class="r"><span>County status</span><b>${aff.items.every((i) => i.sample) ? "Sample zone (exercise)" : aff.items.some((i) => i.kind === "detection" && i.status === "preliminary") ? "Preliminary detection" : "HPAI reported"} · ${fmtShort(aff.since)}</b></div>`;
    rows += `<div class="r"><span>Wild birds, 10 km</span><b>${wildN} in 4 wk · ${wildY} in 12 mo</b></div>`;
    rows += `<div class="r"><span>Seasonal risk</span><b>${R.TIERS[sr.tier]}</b></div>`;
    rows += `<div class="r"><span>Past outbreaks here</span><b>${hist.n ? hist.n + " · last " + fmtShort(hist.last) : "None on record"}</b></div>`;
    const extra = emit("card", { pt, zone: z, county: cty }).filter(Boolean).join("");
    const el = document.createElement("div"); el.className = "pop";
    el.innerHTML = `<div class="band ${band[0]}"><small>${esc(title || "This location")}${smp}</small><b>${band[1]}</b></div><div class="bd">${rows}<div class="do"><b>What to do</b><ul>${DO[z.zone || "none"].map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>${extra}</div>`;
    await fitCard(pt); view.openPopup({ location: pt, content: el });
    el.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => { view.closePopup(); (ctx.actions[b.dataset.act] || (() => {}))(pt, title); }));
  }
  ctx.locationCard = locationCard;

  // past outbreak areas at a point (released zones + real county history)
  async function pastAt(pt) {
    let n = 0, last = 0;
    histLyr.graphics.forEach((g) => { if (geometryEngine.intersects(g.geometry, pt.spatialReference.isWebMercator ? pt : wmu.geographicToWebMercator(pt))) { n++; last = Math.max(last, g.attributes.start || 0); } });
    return { n, last };
  }

  // ---------------- waterfowl habitat (for seasonal risk) ----------------
  let habitatGeom = null;
  async function loadHabitat() {
    if (habitatGeom) return habitatGeom;
    const q = (l, where) => l.queryFeatures({ where: where || "1=1", geometry: S.clearGeom ? S.clearGeom.extent : null, returnGeometry: true, maxAllowableOffset: 150, outSpatialReference: { wkid: 102100 } }).then((r) => r.features.map((f) => f.geometry)).catch(() => []);
    await ready;
    const parts = (await Promise.all([q(env.waterfowl), q(env.wma, "DESIG = 'WMA'"), q(env.refuges)])).flat().filter(Boolean);
    habitatGeom = parts.length ? geometryEngine.union(parts) : null;
    return habitatGeom;
  }
  // 1 inside habitat, falling to 0 at 5 km
  async function habitatAt(g) {
    const hg = await loadHabitat(); if (!hg) return 0;
    const d = geometryEngine.distance(hg, wmu.geographicToWebMercator(new Point({ longitude: g.longitude, latitude: g.latitude })), "kilometers");
    return Math.max(0, 1 - d / 5);
  }
  ctx.habitatAt = habitatAt;
  ctx.habitatKm = async (g) => { const hg = await loadHabitat(); return hg ? geometryEngine.distance(hg, wmu.geographicToWebMercator(new Point({ longitude: g.longitude, latitude: g.latitude })), "kilometers") : null; };

  // ---------------- seasonal risk layer (hexagons, ~6 km) ----------------
  async function buildRisk() {
    await ready; riskLyr.removeAll();
    const hg = await loadHabitat(), ext = S.clearGeom.extent, r = 3500, w = Math.sqrt(3) * r, month = new Date().getMonth(), now = Date.now();
    const cols = { 0: [255, 242, 198, 0.0], 1: [252, 214, 120, 0.55], 2: [244, 140, 60, 0.62], 3: [200, 40, 30, 0.6] };
    for (let y = ext.ymin, row = 0; y < ext.ymax; y += 1.5 * r, row++) {
      for (let x = ext.xmin + (row % 2 ? w / 2 : 0); x < ext.xmax; x += w) {
        const c = new Point({ x, y, spatialReference: { wkid: 102100 } });
        if (!geometryEngine.contains(S.clearGeom, c)) continue;
        const g = wmu.webMercatorToGeographic(c), hab = hg ? Math.max(0, 1 - geometryEngine.distance(hg, c, "kilometers") / 5) : 0;
        const v = R.seasonalRisk({ pt: { lat: g.latitude, lon: g.longitude }, month, seasonCounts: S.season, detections: S.wildPts, habitat: hab, now });
        if (!v.tier) continue;
        const ring = []; for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 30); ring.push([x + r * Math.cos(a), y + r * Math.sin(a)]); } ring.push(ring[0]);
        riskLyr.add(new Graphic({ geometry: new Polygon({ rings: [ring], spatialReference: { wkid: 102100 } }), attributes: { tier: v.tier, value: v.value }, symbol: { type: "simple-fill", color: cols[v.tier], outline: { color: [255, 255, 255, 0.25], width: 0.4 } } }));
      }
    }
  }
  let riskBuilt = false;
  reactiveUtils.watch(() => riskLyr.visible, (v) => { if (v && !riskBuilt) { riskBuilt = true; toast("Building seasonal risk…"); buildRisk().then(() => toast("Seasonal risk: " + new Date().toLocaleString("en-US", { month: "long" }))); } });
  on("wild", () => { if (riskBuilt) buildRisk(); });

  // ---------------- history (time slider): real county history + SAMPLE zone shapes ----------------
  const pubHist = () => has(C.pub.history) ? new FeatureLayer({ url: C.pub.history }).queryFeatures({ where: "1=1", outFields: ["*"], returnGeometry: true, outSpatialReference: { wkid: 102100 } }).then((r) => r.features).catch(() => []) : Promise.resolve([]);
  const histReady = Promise.all([live, fetch(C.sampleHistoryUrl).then((r) => (r.ok ? r.json() : [])).catch(() => []), ready, pubHist()]).then(([Ld, sample, _s, ph]) => {
    const items = ph.map((f) => ({ geom: f.geometry, start: f.attributes.start_date, end: f.attributes.end_date, kind: f.attributes.sample ? "sample" : "zone", label: `${f.attributes.county || ""} County · past control area` }));
    ((Ld && (Ld.history || Ld.commercial)) || []).forEach((d) => { const c = S.counties.find((x) => x.state === d.state && x.name === d.county); if (c) items.push({ geom: c.geom, start: Date.parse(d.date + "T12:00:00Z"), end: Date.parse(d.date + "T12:00:00Z") + 90 * DAY, kind: "county", label: `${d.county} County · ${d.flock || "commercial flock"}`, src: d.source }); });
    (sample || []).forEach((s) => { const p = new Polygon({ rings: s.rings, spatialReference: { wkid: 4326 } }); items.push({ geom: wmu.geographicToWebMercator(p), start: Date.parse(s.start), end: Date.parse(s.end), kind: "sample", label: s.label }); });
    items.forEach((i) => histLyr.add(new Graphic({ geometry: i.geom, attributes: { start: i.start, end: i.end, kind: i.kind, label: i.label },
      symbol: i.kind === "county" ? fill(RED, 0.1, RED.concat(0.6), 1, "dash") : i.kind === "zone" ? fill(RED, 0.18, RED.concat(0.7), 1.2) : fill([120, 120, 140], 0.25, [110, 110, 135, 0.9], 1.2) })));
    return items;
  });
  let slider = null;
  function openTime() {
    $("timebar").hidden = false; histLyr.visible = true;
    if (slider) return;
    histReady.then((items) => {
      const start = Math.min(Date.parse("2022-01-01"), ...items.map((i) => i.start)), end = Date.now();
      slider = new TimeSlider({ container: "timeSlider", mode: "time-window", fullTimeExtent: { start: new Date(start), end: new Date(end) },
        timeExtent: { start: new Date(end - 365 * DAY), end: new Date(end) }, stops: { interval: { value: 1, unit: "months" } }, playRate: 900 });
      const apply = (te) => { const a = +te.start, b = +te.end; histLyr.graphics.forEach((g) => (g.visible = g.attributes.end >= a && g.attributes.start <= b)); };
      reactiveUtils.watch(() => slider.timeExtent, (te) => te && apply(te), { initial: true });
    });
  }
  $("timeClose").onclick = () => { $("timebar").hidden = true; histLyr.visible = false; renderKey(); };

  // ---------------- floating layers & key (minimizable) ----------------
  const keyEl = document.createElement("div"); keyEl.className = "lk glass" + (window.innerWidth < 760 || store.get("keyShut", false) ? " shut" : "");
  view.ui.add(keyEl, "top-right");
  const ROWS = () => [
    { sec: "Outbreak" },
    { id: "ca", t: "Control area", n: `0–${C.zones.controlKm} km from the premises edge`, sw: "ca", ls: () => [L.ca] },
    { id: "sz", t: "Surveillance zone", n: "appears as you zoom in", sw: "sz", ls: () => [L.sz] },
    { id: "pm", t: "Infected premises", n: ctx.isStaff() ? "approximate (public view)" : "approximate area", sw: "pm", ls: () => [L.markers] },
    { id: "ex", staff: 1, t: "Infected premises (exact)", sw: "exact", ls: () => [L.prem, L.perim] },
    { id: "cty", t: "Affected county", n: "detection or MDA notice", sw: "cty", ls: () => [tintLyr] },
    { sec: "Wildlife" },
    { id: "wb", t: "Wild birds with HPAI", n: "USDA APHIS · county level", sw: "wb", ls: () => [wild], seg: true },
    { id: "risk", t: "Seasonal risk", n: "migration + detections + habitat", sw: "risk", ls: () => [riskLyr], off: true },
    { id: "wf", t: "Waterfowl areas", n: "MD DNR", sw: "wf", ls: () => [env.waterfowl], off: true },
    { id: "nwr", t: "Wildlife refuges", n: "USFWS", sw: "nwr", ls: () => [env.refuges], off: true },
    { id: "wma", t: "Wildlife management areas", n: "MD DNR", sw: "wma", ls: () => [env.wma], off: true },
    { sec: "Land and water" },
    { id: "wet", t: "Wetlands and marshes", n: "USFWS NWI · zoom in", sw: "wet", ls: () => [env.wetlands], off: true },
    { id: "for", t: "Forests and land cover", n: "NLCD 2021", sw: "for", ls: () => [env.land], off: true },
    { id: "lake", t: "Lakes and ponds", n: "USGS NHD · zoom in", sw: "lake", ls: () => [env.water], off: true },
    { id: "riv", t: "Rivers and streams", n: "USGS NHD · zoom in", sw: "riv", ls: () => [env.rivers], off: true },
    { id: "wsh", t: "Watersheds (drainage)", n: "USGS WBD HUC-12", sw: "wsh", ls: () => [env.sheds], off: true },
    { sec: "Farms and roads", roles: ["regulator", "hauler"] },
    { id: "farm", staff: 1, t: "Poultry farms", n: "estimated, USGS study", sw: "farm", ls: () => [ctx.layers.farms], off: true },
    { id: "road", roles: ["regulator", "hauler"], t: "Road closures", n: "MDOT CHART", sw: "road", ls: () => [closuresLyr], off: true },
    { sec: "Map" },
    { id: "names", t: "County names", sw: "cty", ls: () => [countyLyr] }
  ];
  const vis = store.get("vis", {});
  function renderKey() {
    const rows = ROWS().filter((r) => (!r.staff || ctx.isStaff()) && (!r.roles || r.roles.includes(S.ws)));
    let html = `<header id="keyHead"><span>Layers &amp; key</span><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></header><div class="body">`;
    rows.forEach((r, i) => {
      if (r.sec) { if (rows[i + 1] && !rows[i + 1].sec) html += `<h4>${esc(r.sec)}</h4>`; return; }
      const ls = r.ls().filter(Boolean); if (!ls.length) return;
      const on = vis[r.id] != null ? vis[r.id] : !r.off;
      ls.forEach((l) => (l.visible = on));
      html += `<label class="lrow"><span class="sw ${r.sw}"></span><span class="nm">${esc(r.t)}${r.n ? `<small>${esc(r.n)}</small>` : ""}</span><input type="checkbox" class="tg" data-id="${r.id}" ${on ? "checked" : ""}></label>`;
      if (r.seg) html += `<div class="seg" id="wildSeg"><button data-d="28" class="${S.wildRange === 28 ? "on" : ""}">4 weeks</button><button data-d="365" class="${S.wildRange === 365 ? "on" : ""}">12 months</button></div>`;
    });
    html += `<button class="tbtn" id="timeBtn"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Look back in time</button></div>`;
    keyEl.innerHTML = html;
    $("keyHead").onclick = () => { keyEl.classList.toggle("shut"); store.set("keyShut", keyEl.classList.contains("shut")); };
    keyEl.querySelectorAll(".tg").forEach((t) => (t.onchange = () => { const r = ROWS().find((x) => x.id === t.dataset.id); vis[r.id] = t.checked; store.set("vis", vis); r.ls().filter(Boolean).forEach((l) => (l.visible = t.checked)); }));
    const seg = $("wildSeg"); if (seg) seg.querySelectorAll("button").forEach((b) => (b.onclick = () => { S.wildRange = +b.dataset.d; store.set("wildRange", S.wildRange); seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); loadWild(); }));
    $("timeBtn").onclick = openTime;
  }
  ctx.renderKey = renderKey;

  // ---------------- click on the map ----------------
  view.on("click", async (e) => {
    if (emit("pick", e.mapPoint).some(Boolean)) return;            // a module is waiting for a map pick
    if (!ctx.inArea(e.mapPoint)) return;                           // outside Maryland / Delmarva: do nothing
    const include = [wild, L.markers, L.prem, closuresLyr, histLyr.visible ? histLyr : null].concat(emit("hitLayers").flat()).filter(Boolean);
    const hit = await view.hitTest(e, { include }).catch(() => null);
    const g = hit && hit.results.find((r) => r.graphic && r.graphic.layer);
    if (g) {
      if (g.graphic.layer === wild) return wildCard(g.graphic);
      if (g.graphic.layer === L.markers) return markerCard(g.graphic, e.mapPoint);
      if (g.graphic.layer === closuresLyr) return simpleCard(e.mapPoint, "info", "Road closure", g.graphic.attributes.incident, [["Lanes", g.graphic.attributes.lanes], ["Updated", g.graphic.attributes.updated]]);
      if (g.graphic.layer === histLyr) return simpleCard(e.mapPoint, "info", g.graphic.attributes.kind === "sample" ? "Past area · SAMPLE" : "Past outbreak", g.graphic.attributes.label, [["From", fmtDate(g.graphic.attributes.start)]]);
      if (emit("hit", { g: g.graphic, pt: e.mapPoint }).some(Boolean)) return;
    }
    locationCard(e.mapPoint, "This location");
  });
  function simpleCard(pt, band, small, big, rows, extra) {
    const el = document.createElement("div"); el.className = "pop";
    el.innerHTML = `<div class="band ${band}"><small>${esc(small)}</small><b>${esc(big || "")}</b></div><div class="bd">${(rows || []).map(([k, v]) => `<div class="r"><span>${esc(k)}</span><b>${esc(v == null ? "–" : v)}</b></div>`).join("")}${extra || ""}</div>`;
    fitCard(pt).then(() => view.openPopup({ location: pt, content: el })); return el;
  }
  ctx.simpleCard = simpleCard;
  function wildCard(g) {
    const a = g.attributes;
    simpleCard(g.geometry, "bird", "HPAI in a wild bird", a.species || "Species not listed", [["Detected", fmtDate(a.detected) + " · " + H.ago(a.detected)], ["County", `${a.county}, ${a.state}`], ["Strain", a.strain]],
      `<div class="do">Shown at county level, not the exact site. Source: USDA APHIS.</div><button class="cta" data-act="wildReport">Report a dead wild bird</button>`)
      .querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => { view.closePopup(); ctx.actions.wildReport(); }));
  }
  function markerCard(g, pt) {
    const a = g.attributes, since = a.since;
    simpleCard(pt, "prem", "Infected premises" + (a.sample === 1 ? " · SAMPLE" : ""), "Approximate location", [["County", a.county], ["Confirmed", fmtDate(since)], ["Status", a.status]],
      `<div class="do">To protect the farm's privacy, this marker is moved up to ${C.privacy.markerShiftKm[1]} km from the real site. Use the zone shading for movement rules.</div>`);
  }

  // ---------------- roles and sign-in ----------------
  const WS = { public: "Public", regulator: "MDA staff", hauler: "Hauler", industry: "Poultry industry" };
  function setWorkspace(w) {
    S.ws = w; document.body.dataset.ws = w;
    document.querySelectorAll("[data-for]").forEach((el) => (el.hidden = !el.dataset.for.split(" ").includes(w)));
    try { sessionStorage.setItem("hpaiWs", w); } catch (e) {}
    renderAcct(); buildOutbreakLayers(); emit("ws", w);
  }
  ctx.setWorkspace = setWorkspace;
  function renderAcct() {
    const a = $("acct");
    if (!S.user) { a.innerHTML = `<button class="signin" id="signinBtn">Sign in</button>`; $("signinBtn").onclick = () => ($("modal").hidden = false); return; }
    const ini = (S.user.fullName || S.user.username).split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase();
    a.innerHTML = `<button class="who" id="whoBtn"><span class="av">${esc(ini)}</span><span class="rl">${esc(WS[S.ws])}<small>${esc(S.user.fullName || S.user.username)}</small></span></button>`;
    $("whoBtn").onclick = (ev) => {
      ev.stopPropagation(); let m = document.querySelector(".menu"); if (m) return m.remove();
      m = document.createElement("div"); m.className = "menu";
      const choices = S.roles.concat(S.roles.includes("regulator") ? ["hauler", "industry", "public"] : ["public"]).filter((v, i, x) => x.indexOf(v) === i && v !== S.ws);
      m.innerHTML = (choices.length ? `<div class="va">View as</div>` + choices.map((c) => `<button data-w="${c}">${esc(WS[c])}</button>`).join("") : "") + `<button id="soBtn">Sign out</button>`;
      document.body.appendChild(m);
      m.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => { m.remove(); setWorkspace(b.dataset.w); }));
      $("soBtn").onclick = () => { esriId.destroyCredentials(); try { sessionStorage.removeItem("hpaiWs"); } catch (e) {} location.reload(); };
      setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }));
    };
  }
  async function initUser() {
    const portal = new Portal({ url: C.portalUrl, authMode: "immediate" });
    await portal.load(); S.user = portal.user;
    const groups = await portal.user.fetchGroups().catch(() => []);
    S.groups = groups.map((g) => g.title);
    S.roles = [];
    if (S.groups.includes(C.regulatorGroup)) S.roles.push("regulator");
    if (S.groups.includes(C.haulerGroup)) S.roles.push("hauler");
    if (S.groups.includes(C.industryGroup)) S.roles.push("industry");
    if (!S.roles.length) S.roles.push("industry");   // signed in but in no group yet: industry tools, own data only
    let want = null; try { want = sessionStorage.getItem("hpaiWs"); } catch (e) {}
    const isReg = S.roles.includes("regulator");
    setWorkspace(want && (S.roles.includes(want) || isReg) ? want : S.roles[0]);
    emit("signin", S.user);
  }
  document.querySelectorAll(".role").forEach((b) => (b.onclick = () => {
    try { sessionStorage.setItem("hpaiWs", b.dataset.ws === "partner" ? "hauler" : "regulator"); } catch (e) {}
    $("modal").hidden = true; esriId.getCredential(sharing).then(initUser).catch(() => {});
  }));
  $("mclose").onclick = () => ($("modal").hidden = true);
  $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("modal").hidden = true; });
  $("signupLink").onclick = (e) => { e.preventDefault(); $("modal").hidden = true; (ctx.actions.signup || (() => {}))(); };

  // panel action buttons
  document.addEventListener("click", (e) => { const b = e.target.closest(".act[data-t]"); if (b && ctx.actions[b.dataset.t]) ctx.actions[b.dataset.t](); });

  // ---------------- phones: bottom sheet ----------------
  (function sheetGrip() {
    const p = $("panel"), g = $("grip"), states = ["", "half", "full"]; let i = 0, y0 = null;
    const set = (k) => { i = Math.max(0, Math.min(2, k)); p.classList.remove("half", "full"); if (states[i]) p.classList.add(states[i]); };
    g.onclick = () => set(i === 2 ? 0 : i + 1);
    g.addEventListener("pointerdown", (e) => { y0 = e.clientY; g.setPointerCapture(e.pointerId); });
    g.addEventListener("pointerup", (e) => { if (y0 == null) return; const dy = e.clientY - y0; y0 = null; if (Math.abs(dy) > 30) set(i + (dy < 0 ? 1 : -1)); });
    ctx.sheetPeek = () => window.innerWidth <= 760 && set(0);
    ctx.sheetHalf = () => window.innerWidth <= 760 && set(1);
  })();

  // ---------------- start ----------------
  (H.modules || []).forEach((m) => { try { m(ctx); } catch (e) { console.error("module", e); } });
  setWorkspace("public");
  esriId.checkSignInStatus(sharing).then(initUser).catch(() => {
    let want = null; try { want = sessionStorage.getItem("hpaiWs"); } catch (e) {}
    if (want && want !== "public") esriId.getCredential(sharing).then(initUser).catch(() => {});
  });
  if (location.hash.startsWith("#verify=")) on("signin", () => (ctx.actions.verify || (() => {}))(decodeURIComponent(location.hash.slice(8))));
});
