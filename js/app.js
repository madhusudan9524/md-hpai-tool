/* Maryland HPAI map: core (map, layers, roles, layers panel, click card, time slider, seasonal risk).
 * Feature modules (public.js, hauler.js, mda.js) plug in through ctx: see HPAI.modules.
 */
require([
  "esri/config", "esri/Map", "esri/views/MapView", "esri/layers/FeatureLayer", "esri/layers/GraphicsLayer", "esri/layers/MapImageLayer",
  "esri/layers/WMSLayer", "esri/Graphic", "esri/geometry/geometryEngine", "esri/geometry/support/webMercatorUtils", "esri/geometry/Point",
  "esri/geometry/Polygon", "esri/geometry/Extent", "esri/widgets/Search", "esri/widgets/Home",
  "esri/identity/OAuthInfo", "esri/identity/IdentityManager", "esri/portal/Portal", "esri/core/reactiveUtils", "esri/widgets/Sketch/SketchViewModel"
], (esriConfig, EsriMap, MapView, FeatureLayer, GraphicsLayer, MapImageLayer, WMSLayer, Graphic, geometryEngine, wmu, Point, Polygon, Extent,
    Search, Home, OAuthInfo, esriId, Portal, reactiveUtils, SketchViewModel) => {
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
  const TIGER_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1";   // US Census Bureau, legal county boundaries
  const DELMARVA = "STATE_NAME IN ('Maryland','Delaware') OR (STATE_NAME = 'Virginia' AND NAME IN ('Accomack County','Northampton County'))";
  const RED = [215, 38, 61], AMBER = [201, 115, 26], APRICOT = [244, 162, 89], TEAL = [14, 154, 167], DRED = [74, 13, 13], ROSE = [232, 120, 130], SLATE = [138, 148, 166];
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
    land: new WMSLayer({ url: C.env.forestWms.url, sublayers: [{ name: C.env.forestWms.layer }], title: "Forests & land cover (NLCD 2021)", visible: false, opacity: 0.55 }),
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
  // solid wildlife icons (bird / mammal) with a white halo so they read on any background
  const svgIcon = (path, color) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="${color}" stroke="#fff" stroke-width="1.6" paint-order="stroke" stroke-linejoin="round">${path}</g></svg>`);
  const BIRD = '<path d="M2.5 14.2c2.6.5 4.6-.5 6-2.5C10 9.4 12 7.8 14.7 7.8c1.5 0 2.7.5 3.5 1.4l3.3-.9-2 2.6c.2 4-2.8 7.5-7.8 7.5-3.6 0-6.4-1.4-9.2-4.2z"/><path d="M9.5 12.2c1.6-.2 3.4.3 4.8 1.6-2 .2-3.7-.3-4.8-1.6z"/>';
  const PAW = '<ellipse cx="12" cy="16" rx="4.6" ry="3.9"/><circle cx="5.8" cy="10.6" r="2.1"/><circle cx="9.6" cy="6.9" r="2.1"/><circle cx="14.4" cy="6.9" r="2.1"/><circle cx="18.2" cy="10.6" r="2.1"/>';
  // barn (gambrel roof) with a door cut-out
  const BARN = '<path d="M2.5 21.5V11l3.2-4.3L12 2.8l6.3 3.9 3.2 4.3v10.5z"/><path fill="#fff" stroke="none" d="M9 21.5v-5.2h6v5.2h-1.4v-3.8h-3.2v3.8zM10.4 10.4h3.2v2.4h-3.2z"/>';
  const ICONS = { bird: svgIcon(BIRD, "#0e9aa7"), mammal: svgIcon(PAW, "#8a5a2b"), barn: svgIcon(BARN, "#4a0d0d") };
  const wild = new FeatureLayer({
    title: "Wildlife with HPAI", source: [], objectIdField: "OID", geometryType: "point", spatialReference: { wkid: 4326 }, outFields: ["*"],
    fields: [{ name: "OID", type: "oid" }, { name: "group", type: "string" }, { name: "state", type: "string" }, { name: "county", type: "string" }, { name: "species", type: "string" }, { name: "strain", type: "string" }, { name: "detected", type: "date" }, { name: "age", type: "integer" }],
    renderer: { type: "unique-value", field: "group", defaultSymbol: { type: "picture-marker", url: ICONS.bird, width: "20px", height: "20px" },
      uniqueValueInfos: [{ value: "bird", symbol: { type: "picture-marker", url: ICONS.bird, width: "20px", height: "20px" } }, { value: "mammal", symbol: { type: "picture-marker", url: ICONS.mammal, width: "20px", height: "20px" } }],
      visualVariables: [{ type: "opacity", field: "age", stops: [{ value: 0, opacity: 1 }, { value: 28, opacity: 0.95 }, { value: 365, opacity: 0.55 }, { value: 1500, opacity: 0.35 }] }] },
    popupEnabled: false
  });
  // waterfowl sightings (eBird; healthy birds, not HPAI cases): a heat map of where and how many, weighted by the square root of
  // the birds at each place so one huge flock doesn't drown out everything else; zoomed in close, the exact places as dots sized by birds
  const BIRD_HEAT = { type: "heatmap", field: "w", radius: 16, maxDensity: 0.02, minDensity: 0, referenceScale: 1155581,
    colorStops: [{ ratio: 0, color: "rgba(64,120,200,0)" }, { ratio: 0.15, color: "rgba(64,120,200,0.3)" }, { ratio: 0.45, color: "rgba(40,90,190,0.55)" }, { ratio: 0.75, color: "rgba(30,60,160,0.78)" }, { ratio: 1, color: "rgba(20,30,120,0.9)" }] };
  const BIRD_DOTS = { type: "simple", symbol: { type: "simple-marker", color: [44, 90, 160, 0.85], outline: { color: [255, 255, 255, 0.95], width: 1.2 } },
    visualVariables: [{ type: "size", field: "birds", stops: [{ value: 1, size: 6 }, { value: 50, size: 10 }, { value: 500, size: 16 }, { value: 3000, size: 24 }] }] };
  const BIRD_DOTS_ZOOM = 12;
  const birdsLyr = new FeatureLayer({ title: "Waterfowl sightings (eBird)", source: [], objectIdField: "OID", geometryType: "point", spatialReference: { wkid: 4326 }, outFields: ["*"], visible: false, popupEnabled: false,
    fields: [{ name: "OID", type: "oid" }, { name: "birds", type: "integer" }, { name: "w", type: "double" }, { name: "place", type: "string" }, { name: "species", type: "string" }, { name: "last", type: "string" }],
    renderer: BIRD_HEAT });
  const routeLyr = new GraphicsLayer({ listMode: "hide" }), marks = new GraphicsLayer({ listMode: "hide" });

  const map = new EsriMap({ basemap: dark ? "dark-gray-vector" : "topo-vector",
    layers: [maskLyr, env.land, env.wma, env.waterfowl, env.refuges, riskLyr, birdsLyr, tintLyr, countyLyr, histLyr] });
  const view = new MapView({ container: "viewDiv", map, center: C.center, zoom: C.zoom, constraints: { minZoom: 7, snapToZoom: false },
    popup: { dockEnabled: false, dockOptions: { buttonEnabled: false }, collapseEnabled: false, visibleElements: { closeButton: true, featureNavigation: false, actionBar: false, heading: false, collapseButton: false, spinner: false }, highlightEnabled: false, actions: [], alignment: "bottom-center" }, popupEnabled: false, ui: { components: ["zoom", "attribution"] } });
  view.ui.move("zoom", "top-left");
  view.ui.add(new Home({ view }), "top-left");
  // on phones the bottom sheet covers the lower ~150 px: centre the map (and fit Maryland) in the part people can see
  const padForSheet = () => { view.padding = { top: 0, right: 0, left: 0, bottom: window.innerWidth <= 760 ? 150 : 0 }; };
  padForSheet(); window.addEventListener("resize", padForSheet);

  // ---------------- state ----------------
  const S = { ws: "public", user: null, groups: [], roles: [], live: null, mdGeom: null, clearGeom: null, counties: [], areas: [], season: null };
  const ctx = { H, C, R, S, view, map, on, emit, has, esriId, sharing, dark,
    esri: { FeatureLayer, GraphicsLayer, Graphic, geometryEngine, wmu, Point, Polygon, Extent, Search, reactiveUtils, SketchViewModel },
    icons: ICONS, layers: { L, env, wild, riskLyr, histLyr, closuresLyr, routeLyr, marks, tintLyr, countyLyr }, actions: {} };
  ctx.isStaff = () => S.ws === "regulator";
  ctx.signedIn = () => !!S.user;
  ctx.token = () => { const c = esriId.findCredential(sharing); return c && c.token; };

  // ---------------- industry partners: sign-in service (worker/) ----------------
  // they sign in with an email or text code; their map requests go through the service, which only shows them their own records
  const IND_KEY = "hpai.session";
  ctx.ind = {
    token: () => { try { return localStorage.getItem(IND_KEY); } catch (e) { return null; } },
    async api(path, body) {
      if (H.previewApi && (ctx.ind.token() || "").startsWith(H.PREVIEW_PREFIX)) return H.previewApi(path, body, ctx);   // MDA staff using View as (js/preview.js)
      if (!C.auth || !C.auth.url) throw new Error(`Industry sign-in is being set up. Call MDA at ${C.mdaPhone}.`);
      const h = {}, t = ctx.ind.token(), form = body instanceof FormData;
      if (t) h.authorization = "Bearer " + t;
      if (body !== undefined && !form) h["content-type"] = "application/json";
      let r; try { r = await fetch(C.auth.url.replace(/\/$/, "") + path, { method: body === undefined ? "GET" : "POST", headers: h, body: body === undefined ? undefined : form ? body : JSON.stringify(body) }); }
      catch (e) { throw new Error("Can't reach the sign-in service. Check your connection."); }
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 && t && path !== "/verify") { ctx.ind.end(); }
      if (!r.ok || j.error) throw new Error(j.error || "Something went wrong. Please try again.");
      return j;
    },
    start(token, u) {
      try { localStorage.setItem(IND_KEY, token); } catch (e) {}
      ctx.ind.begin(u);
    },
    begin(u) {
      S.session = u; S.user = { username: "industry:" + u.id, fullName: u.name, company: u.company, companyAdmin: u.companyAdmin, expires: u.expires, email: u.email, phone: u.phone };
      S.role = "industry"; S.roles = ["industry"]; S.groups = [];
      $("pendingNote").hidden = true;
      setWorkspace("industry"); emit("signin", S.user);
    },
    end() { try { localStorage.removeItem(IND_KEY); } catch (e) {} if (S.session) { S.session = null; S.user = null; S.role = null; S.roles = []; setWorkspace("public"); emit("acct"); toast("Please sign in again.", 4000); } }
  };
  // which industry requests go through the service, and as what
  const indTarget = (url) => {
    const m = [[C.movement.trips, "trips"], [C.movement.visits, "visits"], [C.movement.permits, "permits"], [C.movementMda.trips, "trips"], [C.movementMda.visits, "visits"], [C.movementMda.permits, "permits"],
      [C.farmsUrl, "farms"], [C.industryVisits, "industryVisits"], [C.routeUrl, "route"]].find(([u]) => u && (url === u || url.startsWith(u + "/")));
    return m && { target: m[1], op: url.slice(m[0].length).replace(/^\//, "") };
  };

  // ArcGIS REST helper (POST form, token added when signed in)
  ctx.rest = async (url, params, opts) => {
    if (S.session && !(opts && opts.anon)) {
      const t = indTarget(url);
      if (t) return ctx.ind.api("/arcgis", { target: t.target, op: t.op, params: Object.fromEntries(Object.entries(params || {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) });
    }
    return ctx.restRaw(url, params, opts);
  };
  ctx.restRaw = async (url, params, opts) => {
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
    // these two pull from nationwide services (USFWS refuges, NLCD land cover) with no state/region
    // filter of their own, so without a clip they render across the whole country, not just Delmarva
    env.refuges.clippingArea = S.clearGeom;
    env.land.clippingArea = S.clearGeom;
    const ext = S.mdGeom.extent.clone();
    view.constraints.geometry = S.clearGeom.extent.clone().expand(1.25);
    if (!location.hash) view.goTo(ext.expand(1.05), { animate: false }).catch(() => {});
    // the faded area outside the region is cut from the Census Bureau's detailed (legal) county lines,
    // which run through the Chesapeake Bay and out to sea, so the Bay and the shoreline stay clear and crisp;
    // the simplified county shapes above are the fallback
    const paintMask = (clear) => {
      const w = 20037508, world = new Polygon({ rings: [[[-w, -w], [-w, w], [w, w], [w, -w], [-w, -w]]], spatialReference: { wkid: 102100 } });
      maskLyr.removeAll();
      maskLyr.add(new Graphic({ geometry: geometryEngine.difference(world, clear), symbol: { type: "simple-fill", color: dark ? [13, 17, 23, 0.72] : [244, 246, 249, 0.8], outline: { color: [0, 0, 0, 0] } } }));
    };
    fetch(TIGER_URL + "/query?" + new URLSearchParams({ f: "json", where: "STATE IN ('24','10') OR (STATE = '51' AND COUNTY IN ('001','131'))", outFields: "GEOID", returnGeometry: "true", outSR: "102100", maxAllowableOffset: "40", geometryPrecision: "0" }))
      .then((r) => r.json()).then((j) => {
        if (!j.features || !j.features.length) throw new Error("no counties");
        const legal = geometryEngine.union(j.features.map((f) => new Polygon({ rings: f.geometry.rings, spatialReference: { wkid: 102100 } })));
        S.clearGeom = legal; paintMask(legal);
      }).catch(() => paintMask(S.clearGeom));
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
    if (L.sz) L.sz.opacity = S.lookBack ? 0 : ctx.isStaff() ? 1 : k(8.6, 10);
  }
  reactiveUtils.watch(() => view.zoom, fadeByZoom);

  // ---------------- outbreak layers ----------------
  function zoneLayer(url, type, extra) {
    return new FeatureLayer(Object.assign({ url, outFields: ["*"], popupEnabled: false,
      // only established zones: a preliminary (unconfirmed) premises keeps its zones at status 'Pending' until MDA confirms it
      definitionExpression: `zone_type = '${type}' AND status = 'Active'`,
      renderer: { type: "simple", symbol: type === "Control Area" ? fill(RED, 0.24, RED.concat(1), 2) : fill(APRICOT, 0.18, AMBER.concat(1), 1.6, "dash") } }, extra || {}));
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
    if (S.ws !== "public" && !ctx.isStaff() && has(C.pub.markers)) {   // approximate markers aren't needed for the public tier or for MDA staff, who already get the exact premises boundary (L.prem/L.perim)
      L.markers = new FeatureLayer({ url: C.pub.markers, title: "Infected premises (approximate)", outFields: ["*"], popupEnabled: false, definitionExpression: "status = 'Active'",
        renderer: { type: "simple", symbol: { type: "picture-marker", url: ICONS.barn, width: "28px", height: "28px" } } });
      map.add(L.markers);
    }
    if (has(C.pub.declarations)) {
      L.decl = new FeatureLayer({ url: C.pub.declarations, outFields: ["*"], popupEnabled: false, definitionExpression: "status <> 'Withdrawn'", visible: false });   // read only; drawn into tintLyr
      L.decl.load().catch(() => {});
    }
    if (ctx.isStaff()) {
      const premUrl = has(C.core.premises) ? C.core.premises : C.legacy.premises, perimUrl = has(C.core.perimeters) ? C.core.perimeters : C.legacy.perimeters;
      L.perim = new FeatureLayer({ url: perimUrl, title: "Premises boundary", outFields: ["*"], popupEnabled: false,
        renderer: { type: "simple", symbol: { type: "simple-fill", color: DRED.concat(0.35), outline: { color: DRED.concat(1), width: 2.5 } } } });
      L.prem = new FeatureLayer({ url: premUrl, title: "Infected premises (exact)", outFields: ["*"], popupEnabled: false,
        maxScale: 300000,   // only a locator when zoomed far out (the boundary is too small to see there); zoomed in, the exact boundary shows
        renderer: { type: "unique-value", field: "status", defaultSymbol: { type: "simple-marker", style: "square", size: 9, color: DRED.concat(1), outline: { color: [255, 255, 255, 1], width: 1.5 } },
          uniqueValueInfos: [{ value: "Released", symbol: { type: "simple-marker", style: "square", size: 7, color: [138, 148, 166, 1], outline: { color: [255, 255, 255, 1], width: 1 } } }] } });
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
    renderKey();
    paintCounties(); emit("areas", S.areas);
  }
  ctx.refreshAreas = refreshAreas;

  // ---- affected counties: commercial (chicken/poultry) detections only, from the live feed or an MDA declaration ----
  // deliberately NOT based on control/surveillance zone geometry: a zone's buffer radius can extend into a
  // neighboring county that has no detection of its own, which was shading counties (e.g. Anne Arundel) that
  // merely sit near an infected premises in another county
  S.affected = [];
  S.released = [];   // real control areas MDA has released: [{ county, end }] (filled from the public history layer)
  async function paintCounties() {
    await ready;
    const cutoff = Date.now() - (C.tintDays || 30) * DAY, aff = new globalThis.Map();
    // MDA declarations: "Cleared" ones mark a county whose preliminary detection MDA released (no outbreak followed)
    let decl = [];
    if (L.decl) { try { decl = (await L.decl.queryFeatures({ where: L.decl.definitionExpression, outFields: ["*"], returnGeometry: false })).features.map((f) => f.attributes); } catch (e) {} }
    const ended = S.released.concat(decl.filter((a) => a.status === "Cleared").map((a) => ({ county: a.county, end: a.declared })));
    // a county's tint ends when MDA releases its control area (or clears a preliminary detection): anything dated before that no longer counts
    const releasedAfter = (name, t) => ended.some((r) => r.county === name && r.end >= (t || 0));
    const mark = (st, name, info) => { const c = S.counties.find((x) => x.state === st && x.name === name); if (!c || releasedAfter(name, info.t)) return; const k = st + name; const o = aff.get(k) || { c, items: [] }; o.items.push(info); aff.set(k, o); };
    ((S.live && S.live.commercial) || []).forEach((d) => { const t = Date.parse(d.date + "T12:00:00Z"); if (t >= cutoff) mark(d.state, d.county, { kind: "detection", t, status: d.status, text: d.status_text || "", flock: d.flock, source: d.source, url: d.url }); });
    decl.filter((a) => a.status !== "Cleared").forEach((a) => mark(a.state || "Maryland", a.county, { kind: "declaration", t: a.declared, status: a.status, text: a.status_text, url: a.source_url }));
    tintLyr.removeAll();
    S.affected = [...aff.values()].map((o) => ({ county: o.c.name, state: o.c.state, geom: o.c.geom, items: o.items, since: Math.min(...o.items.map((i) => i.t || Date.now())) })).sort((a, b) => b.since - a.since);
    S.affected.forEach((a) => tintLyr.add(new Graphic({ geometry: a.geom, attributes: { county: a.county }, symbol: fill(ROSE, 0.16, ROSE.concat(0.7), 1) })));
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
    const all = (Ld.wild_all && Ld.wild_all.length ? Ld.wild_all : Ld.wild_year || Ld.wild || []).map((w) => Object.assign({ group: "bird" }, w)).concat(Ld.mammals || []);
    const rows = all.map((w) => ({ w, t: Date.parse(w.date + "T12:00:00Z") })).filter((o) => Date.now() - o.t <= S.wildRange * DAY);
    await wild.applyEdits({ deleteFeatures: old.features, addFeatures: rows.map(({ w, t }) => new Graphic({ geometry: { type: "point", x: w.lon, y: w.lat, spatialReference: { wkid: 4326 } }, attributes: { group: w.group, state: w.state, county: w.county, species: w.species, strain: w.strain, detected: t, age: Math.round((Date.now() - t) / DAY) } })) }).catch(() => {});
    S.wildPts = all.map((w) => ({ lat: w.lat, lon: w.lon, t: Date.parse(w.date + "T12:00:00Z"), county: w.county, state: w.state, species: w.species, group: w.group }));
    kpis(); emit("wild", S.wildPts);
  }
  ctx.loadWild = loadWild;
  live.then((Ld) => {
    S.live = Ld;
    if (!Ld) { $("newsList").innerHTML = `<p class="hint">Notices are unavailable right now.</p>`; return; }
    S.season = Ld.season || null;
    $("updated").textContent = "updated " + new Date(Ld.updated).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    renderNews(Ld); loadWild(); paintCounties(); emit("live", Ld);
  });

  // always listed in the layers panel; the note says why it is empty (no sightings yet, key not set, eBird unreachable)
  S.birdsNote = "eBird, last 7 days";
  const birdsNote = (B) => !B ? "eBird · not loaded yet" : B.status === "nokey" ? "eBird · not connected yet" : B.status === "error" && !(B.places || []).length ? "eBird · unavailable right now"
    : !(B.places || []).length ? "eBird · none this week" : "eBird, last 7 days";
  const birdsP = fetch((C.birdsUrl || "data/birds.json") + "?t=" + Date.now()).then((r) => (r.ok ? r.json() : null)).catch(() => null).then(async (B) => {
    S.birdsNote = birdsNote(B); renderKey();
    if (!B || !B.places || !B.places.length) return;
    S.birdsOk = true; S.birds = B; S.birdWeek = null;
    if (birdsLyr.visible) loadBirdWeeks().then(() => renderKey());   // layer already on from last visit: bring its slider
    await birdsLyr.applyEdits({ addFeatures: B.places.map((p) => new Graphic({ geometry: { type: "point", x: p.lon, y: p.lat, spatialReference: { wkid: 4326 } }, attributes: { birds: p.birds, w: Math.sqrt(p.birds), place: p.place, last: p.last, species: (p.species || []).map((s) => s[0] + " " + s[1]).join(", ") } })) }).catch(() => {});
    renderKey();
  }).catch(() => {});
  reactiveUtils.watch(() => view.zoom >= BIRD_DOTS_ZOOM, (close) => { birdsLyr.renderer = close ? BIRD_DOTS : BIRD_HEAT; }, { initial: true });
  // ---- waterfowl week slider: one position per full week (eBird archive), the last position = the last 7 days ----
  S.birdWeeks = null; let birdPlay = null;
  const loadBirdWeeks = () => S.birdWeeks ? Promise.resolve(S.birdWeeks) : fetch("data/birds_weeks.json?t=" + Date.now()).then((r) => (r.ok ? r.json() : null)).then((j) => { S.birdRef = (j && j.ref) || null; return (S.birdWeeks = (j && j.weeks) || []); }).catch(() => (S.birdWeeks = []));
  async function showBirdWeek(i) {   // i = index into S.birdWeeks, or null for the last 7 days
    S.birdWeek = i;
    const old = await birdsLyr.queryFeatures({ where: "1=1", returnGeometry: false, outFields: ["OID"] }).catch(() => ({ features: [] }));
    const g = (lon, lat, a) => new Graphic({ geometry: { type: "point", x: lon, y: lat, spatialReference: { wkid: 4326 } }, attributes: a });
    const adds = i == null ? ((S.birds && S.birds.places) || []).map((p) => g(p.lon, p.lat, { birds: p.birds, w: Math.sqrt(p.birds), place: p.place, last: p.last, species: (p.species || []).map((x) => x[0] + " " + x[1]).join(", ") }))
      : S.birdWeeks[i].places.map(([lat, lon, n, sp]) => g(lon, lat, { birds: n, w: Math.sqrt(n), place: "", last: "", species: sp }));
    await birdsLyr.applyEdits({ deleteFeatures: old.features, addFeatures: adds }).catch(() => {});
    const lab = $("bwLab"); if (lab) lab.textContent = birdWeekLabel(i);
  }
  const birdWeekLabel = (i) => i == null ? "Last 7 days" : "Week of " + new Date(S.birdWeeks[i].start + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const KIND = { commercial: ["Commercial flock", "red"], backyard: ["Backyard flock", "amber"], wild: ["Wild birds", "teal"], general: ["Notice", ""] };
  const short = (s) => (s || "").replace("Maryland Department of Agriculture", "MDA").replace("Delaware Department of Agriculture", "DDA").replace("Virginia Department of Agriculture and Consumer Services", "VDACS");
  function renderNews(Ld) {
    const seen = new Set(), items = (Ld.notices || []).filter((n) => { const k = n.title.toLowerCase().replace(/[^a-z]/g, "").slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
    $("newsList").innerHTML = items.length ? items.map((n) => {
      const k = KIND[n.kind] || KIND.general, st = n.status === "confirmed" ? " · Confirmed" : n.status === "preliminary" ? " · Preliminary" : "";
      return `<a class="nw" href="${esc(n.url)}" target="_blank" rel="noopener"><div class="nt">${esc(n.title)}</div><div class="nm"><span class="pill ${k[1]}">${k[0]}${st}</span><span>${esc(short(n.source))} · ${fmtShort(Date.parse(n.date + "T12:00:00Z"))}</span></div></a>`;
    }).join("") : `<p class="hint">No recent notices.</p>`;
  }

  function kpis() {
    const set = (id, v, one, many) => { const e = $(id); if (e) e.textContent = v == null ? "–" : v; const l = $(id + "l"); if (l && one) l.textContent = v === 1 ? one : many; };
    set("kCA", S.areas.length, "control area", "control areas"); set("kCty", S.affected.length, "affected county", "affected counties");
    set("kWild", (S.wildPts || []).filter((w) => Date.now() - w.t <= 28 * DAY).length, "wildlife case · 4 wk", "wildlife cases · 4 wk");
  }
  ctx.kpis = kpis;

  // ---------------- search (address autocomplete, Maryland + Delmarva only) ----------------
  // Plain address box with suggestions as you type (tolerates small typos) and "Did you mean…?" when nothing matches.
  // Uses Esri's public World Geocoding Service (no sign-in needed), limited to Maryland and Delmarva.
  const GEO = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer";
  const geoExt = JSON.stringify({ xmin: -79.6, ymin: 37.0, xmax: -74.9, ymax: 39.85, spatialReference: { wkid: 4326 } });
  const geo = (op, p) => fetch(`${GEO}/${op}?` + new URLSearchParams(Object.assign({ f: "json", searchExtent: geoExt, countryCode: "USA" }, p))).then((r) => r.json());
  const addrShort = (t) => (t || "").replace(/, USA$/, "").replace(/, (Maryland|MD), (\d{5})/, ", MD $2");
  const PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
  const coordsLabel = (g) => `${Math.abs(g.latitude).toFixed(5)}° ${g.latitude >= 0 ? "N" : "S"}, ${Math.abs(g.longitude).toFixed(5)}° ${g.longitude >= 0 ? "E" : "W"}`;
  ctx.makeSearch = (container, placeholder, onPick) => {
    const host = typeof container === "string" ? $(container) : container;
    host.classList.add("addr");
    host.innerHTML = `<input type="text" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" role="combobox" aria-expanded="false"><button class="addrx" type="button" aria-label="Clear" hidden>×</button><button class="addrpin" type="button" title="Pick on the map" aria-label="Pick this place on the map">${PIN_SVG}</button><ul class="sugg" role="listbox" hidden></ul>`;
    const inp = host.querySelector("input"), ul = host.querySelector("ul"), clr = host.querySelector(".addrx"), pinB = host.querySelector(".addrpin");
    // fill this box from a map tap: coordinates straight away, the nearest address as a hint underneath
    const inSheet = !!host.closest("#sheet");
    host._fill = async (mp) => {
      const g = mp.spatialReference && !mp.spatialReference.isWGS84 ? wmu.webMercatorToGeographic(mp) : mp;
      if (inSheet) $("sheet").hidden = false;
      if (!ctx.inArea(wmu.geographicToWebMercator(g))) return toast("That place is outside Maryland and Delmarva");
      const label = coordsLabel(g); inp.value = label; clr.hidden = false; close();
      const pt = new Point({ longitude: g.longitude, latitude: g.latitude });
      // filling a box is all the user asked for: no info card, just a dot where the box now points
      if (onPick) onPick(pt, label, { fromMap: true }); else { marks.removeAll(); marks.add(new Graphic({ geometry: pt, symbol: { type: "simple-marker", size: 14, color: [10, 108, 255, 1], outline: { color: [255, 255, 255, 1], width: 3 } } })); }
      const r = await geo("reverseGeocode", { location: `${g.longitude},${g.latitude}` }).catch(() => null), near = r && r.address && (r.address.Match_addr || r.address.LongLabel);
      let hint = host.querySelector(".addrnear"); if (!hint) { hint = document.createElement("small"); hint.className = "addrnear"; host.appendChild(hint); }
      hint.textContent = near ? "Near " + addrShort(near) : ""; hint.hidden = !near || inp.value !== label;
    };
    pinB.onclick = () => {
      host.classList.add("arming"); ctx.armAddr(host);
      if (inSheet) $("sheet").hidden = true; else ctx.sheetPeek();
      toast("Tap the map to fill in this place", 4000);
    };
    let items = [], act = -1, tmo = null, seq = 0;
    const close = () => { ul.hidden = true; inp.setAttribute("aria-expanded", "false"); act = -1; };
    const show = (list, head) => {
      items = list; act = -1;
      ul.innerHTML = (head ? `<li class="sh">${esc(head)}</li>` : "") + list.map((x, k) => `<li role="option" data-k="${k}"><svg viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg><span>${esc(addrShort(x.text))}</span></li>`).join("");
      ul.hidden = !list.length && !head; inp.setAttribute("aria-expanded", String(!ul.hidden));
      ul.querySelectorAll("li[data-k]").forEach((li) => li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(items[+li.dataset.k]); }));
    };
    const hi = () => ul.querySelectorAll("li[data-k]").forEach((li, k) => li.classList.toggle("on", k === act));
    async function choose(x) {
      close(); inp.value = addrShort(x.text); clr.hidden = false;
      let loc = x.location;
      if (!loc) { const r = await geo("findAddressCandidates", { SingleLine: x.text, magicKey: x.magicKey || "", maxLocations: 1, outFields: "Match_addr" }).catch(() => null); const c = r && r.candidates && r.candidates[0]; if (!c) return toast("Couldn't find that place"); loc = c.location; inp.value = addrShort(c.address); }
      const pt = new Point({ longitude: loc.x, latitude: loc.y }), mp = wmu.geographicToWebMercator(pt);
      if (!ctx.inArea(mp)) return toast("That place is outside Maryland and Delmarva");
      if (onPick) onPick(pt, inp.value); else { await view.goTo({ target: mp, zoom: 13 }).catch(() => {}); locationCard(mp, inp.value); ctx.sheetPeek(); }
    }
    // nothing typed matches → closest addresses ("Did you mean…?")
    async function fuzzy(text, auto) {
      const r = await geo("findAddressCandidates", { SingleLine: text, maxLocations: 4, outFields: "Match_addr,Score" }).catch(() => null);
      const c = ((r && r.candidates) || []).filter((x) => x.score >= 70).map((x) => ({ text: x.address, location: x.location, score: x.score }));
      if (auto && c[0] && c[0].score >= 92) return choose(c[0]);
      show(c, c.length ? "Did you mean" : "No matching place in Maryland or Delmarva");
    }
    inp.addEventListener("input", () => {
      clr.hidden = !inp.value; clearTimeout(tmo); const nh = host.querySelector(".addrnear"); if (nh) nh.hidden = true;
      const t = inp.value.trim(); if (t.length < 3) return close();
      tmo = setTimeout(async () => {
        const my = ++seq, r = await geo("suggest", { text: t, location: "-76.2,38.7", maxSuggestions: 6 }).catch(() => null);
        if (my !== seq) return;
        const s = ((r && r.suggestions) || []).filter((x) => !x.isCollection).map((x) => ({ text: x.text, magicKey: x.magicKey }));
        if (s.length) show(s); else fuzzy(t);
      }, 220);
    });
    inp.addEventListener("keydown", (e) => {
      const n = items.length;
      if (e.key === "ArrowDown" && n) { act = (act + 1) % n; hi(); e.preventDefault(); }
      else if (e.key === "ArrowUp" && n) { act = (act - 1 + n) % n; hi(); e.preventDefault(); }
      else if (e.key === "Enter") { e.preventDefault(); if (act >= 0 && items[act]) choose(items[act]); else if (inp.value.trim().length >= 3) fuzzy(inp.value.trim(), true); }
      else if (e.key === "Escape") close();
    });
    inp.addEventListener("blur", () => setTimeout(close, 150));
    clr.onclick = () => { inp.value = ""; clr.hidden = true; close(); const nh = host.querySelector(".addrnear"); if (nh) nh.hidden = true; inp.focus(); };
    return { clear: () => { inp.value = ""; clr.hidden = true; close(); }, set searchTerm(v) { inp.value = v || ""; clr.hidden = !v; }, get searchTerm() { return inp.value; } };
  };
  ctx.makeSearch("search", "Search an address or place");
  $("locBtn").onclick = () => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => { const pt = wmu.geographicToWebMercator(new Point({ longitude: p.coords.longitude, latitude: p.coords.latitude })); view.goTo({ target: pt, zoom: 12 }); locationCard(pt, "Your location"); }, () => toast("Location not available")) : toast("Location not available");

  // ---------------- status of a place ----------------
  // Which public zone a point is in, using the zone layers the viewer is allowed to see
  ctx.zoneAt = async (pt) => {
    const q = async (lyr) => (lyr ? (await lyr.queryFeatures({ geometry: pt, spatialRelationship: "intersects", where: lyr.definitionExpression, outFields: ["*"], returnGeometry: false }).catch(() => ({ features: [] }))).features : []);
    const [ca, sz] = await Promise.all([q(L.ca), q(L.sz)]);
    return ca.length ? { zone: "control", f: ca[0] } : sz.length ? { zone: "surveillance", f: sz[0] } : { zone: null };
  };
  // geometryEngine.distance measures flat Web Mercator metres, which overstate real ground distance by 1/cos(latitude)
  // (about 28% in Maryland), so every distance used for alerts and risk is scaled back to true kilometres
  const trueKm = (a, b) => { const p = b.type === "point" ? b : b.extent.center, lat = p.spatialReference.isWGS84 ? p.latitude : wmu.webMercatorToGeographic(p).latitude;
    return geometryEngine.distance(a, b, "kilometers") * Math.cos(lat * Math.PI / 180); };
  ctx.trueKm = trueKm;
  ctx.distToArea = (pt) => {
    if (!S.areas.length) return null;
    const p = pt.spatialReference.isWebMercator ? pt : wmu.geographicToWebMercator(pt);
    return Math.min(...S.areas.map((f) => trueKm(f.geometry, p)));
  };
  ctx.wildNear = (pt, kmR, days) => { const g = pt.spatialReference.isWGS84 ? pt : wmu.webMercatorToGeographic(pt), p = { lat: g.latitude, lon: g.longitude }; return (S.wildPts || []).filter((w) => Date.now() - w.t <= days * DAY && R.km(p, w) <= kmR); };
  ctx.seasonNow = () => R.seasonIndex(new Date().getMonth(), S.season);

  const DO = {
    control: ["Moving poultry, eggs, feed, litter or equipment in or out needs an MDA permit.", "Keep birds indoors and away from wild birds.", "Report sick or dead birds right away."],
    surveillance: ["Watch your birds closely and report illness.", "Movements may need testing. Check with MDA before moving birds.", "Clean and disinfect vehicles and boots."],
    none: ["No movement restrictions here today.", "Keep birds away from wild waterfowl.", "Report sick or dead birds."]
  };
  // ---------------- info card (our own, not the ArcGIS popup) ----------------
  // Opens just below the spot that was clicked, with a small soft pointer up to it, and follows the map as it moves.
  const cardBox = document.createElement("div"); cardBox.className = "mcard"; cardBox.hidden = true; cardBox.setAttribute("role", "dialog");
  cardBox.innerHTML = `<span class="mtail" aria-hidden="true"></span><button class="mx" type="button" aria-label="Close">&times;</button><div class="mbody"></div>`;
  view.container.appendChild(cardBox);
  let cardPt = null, locDot = null;   // locDot: the blue dot of the place card (other marks, e.g. a trace, stay)
  function placeCard() {
    if (!cardPt || cardBox.hidden) return;
    const sp = view.toScreen(cardPt); if (!sp) return;
    const w = cardBox.offsetWidth, left = Math.max(8, Math.min(view.width - w - 8, sp.x - w / 2));
    cardBox.style.transform = `translate(${Math.round(left)}px, ${Math.round(sp.y + 16)}px)`;
    cardBox.style.setProperty("--tail", Math.round(Math.max(18, Math.min(w - 18, sp.x - left))) + "px");
  }
  reactiveUtils.watch(() => [view.extent, view.width, view.height], placeCard);
  function openCard(pt, el) { cardPt = pt; const b = cardBox.querySelector(".mbody"); b.innerHTML = ""; b.appendChild(el); cardBox.hidden = false; placeCard(); }
  function closeCard() { if (cardBox.hidden) return false; cardBox.hidden = true; cardPt = null; cardBox.querySelector(".mbody").innerHTML = ""; if (locDot) { marks.remove(locDot); locDot = null; } return true; }
  cardBox.querySelector(".mx").onclick = () => closeCard();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("sheet").hidden) closeCard(); });
  ctx.openCard = openCard; ctx.closeCard = closeCard;

  // the card opens BELOW the clicked spot: if it would run off the bottom (or behind the phone's bottom sheet), slide the map up
  async function fitCard(pt, h) {
    const sp = view.toScreen(pt); if (!sp) return;
    const bottom = view.height - ((view.padding && view.padding.bottom) || 0), need = Math.min(h || 290, bottom - 70);
    const dy = sp.y + need + 20 > bottom ? sp.y + need + 20 - bottom : sp.y < 40 ? sp.y - 40 : 0;
    const dx = sp.x < 160 ? 160 - sp.x : sp.x > view.width - 160 ? view.width - 160 - sp.x : 0;
    if (dy || dx) { const c = view.toScreen(view.center); await view.goTo(view.toMap({ x: c.x - dx, y: c.y + dy }), { duration: 250 }).catch(() => {}); }
  }
  ctx.fitCard = fitCard;
  async function locationCard(pt, title, place) {
    if (pt.spatialReference && pt.spatialReference.isWGS84) pt = wmu.geographicToWebMercator(pt);   // accept either coordinate system
    if (!ctx.inArea(pt)) return;
    marks.removeAll(); locDot = new Graphic({ geometry: pt, symbol: { type: "simple-marker", size: 14, color: [10, 108, 255, 1], outline: { color: [255, 255, 255, 1], width: 3 } } }); marks.add(locDot);
    const z = await ctx.zoneAt(pt), cty = ctx.countyAt(wmu.geographicToWebMercator(pt.spatialReference.isWGS84 ? pt : wmu.webMercatorToGeographic(pt)));
    const aff = cty && S.affected.find((a) => a.county === cty.name && a.state === cty.state);
    const wildN = ctx.wildNear(pt, 10, 28).length, wildY = ctx.wildNear(pt, 10, 365).length;
    const g = pt.spatialReference.isWGS84 ? pt : wmu.webMercatorToGeographic(pt);
    const rm = await Promise.race([riskModel(), new Promise((r) => setTimeout(() => r(null), 3000))]);   // the card never waits long for the risk model
    const sr = riskAt(g.latitude, g.longitude, rm);
    const hist = await pastAt(pt);
    const smp = z.f && z.f.attributes.sample === 1;
    const band = z.zone === "control" ? ["ca", "Control area"] : z.zone === "surveillance" ? ["sz", "Surveillance zone"] : ["free", "No restrictions"];
    const since = z.f && (z.f.attributes.since || z.f.attributes.confirmed_date || z.f.attributes.created_date);
    const where = cty ? cty.name + (cty.state !== "Maryland" ? ", " + cty.state.slice(0, 2).toUpperCase() : " County") : "";
    const sub = since ? `since ${fmtShort(since)} · day ${Math.max(1, Math.floor((Date.now() - since) / DAY) + 1)}` : aff ? (aff.items.every((i) => i.sample) ? "sample zone in county" : "HPAI reported in county · " + fmtShort(aff.since)) : "";
    const chips = [];
    if (smp) chips.push(`<i class="c amber">Sample</i>`);
    if (wildN) chips.push(`<i class="c teal">${wildN} wild bird${wildN === 1 ? "" : "s"} · 4 wk</i>`);
    else if (wildY) chips.push(`<i class="c teal">${wildY} wild bird${wildY === 1 ? "" : "s"} · 12 mo</i>`);
    if (sr.tier) chips.push(`<i class="c violet">${R.TIERS[sr.tier]} seasonal risk</i>`);
    if (hist.n) chips.push(`<i class="c">${hist.sample ? "Sample past area" : "Past outbreak area"} · ${fmtShort(hist.last)}</i>`);
    if (place) chips.push(`<i class="c green">${esc(place)}</i>`);
    const tip = { control: "MDA permit needed to move birds, eggs, feed or litter.", surveillance: "Watch birds closely. Check with MDA before moving birds.", none: "Keep birds away from wild waterfowl. Report sick birds." }[z.zone || "none"];
    // modules add buttons to the card; ones marked <!--more--> go inside the expanded Details part
    const parts = emit("card", { pt, zone: z, county: cty }).filter(Boolean);
    const extra = parts.filter((p) => !p.startsWith("<!--more-->")).join(""), extraMore = parts.filter((p) => p.startsWith("<!--more-->")).join("");
    const el = document.createElement("div"); el.className = "pop";
    const more = `<div class="more" hidden>
      ${since ? `<div class="r"><span>Zone since</span><b>${fmtDate(since)}</b></div>` : ""}
      ${aff ? `<div class="r"><span>County status</span><b>${aff.items.every((i) => i.sample) ? "Sample zone" : aff.items.some((i) => i.status === "preliminary") ? "Preliminary detection" : "HPAI reported"} · ${fmtShort(aff.since)}</b></div>` : ""}
      <div class="r"><span>Wildlife within 6 mi</span><b>${wildN} in 4 wk · ${wildY} in 12 mo</b></div>
      <div class="r"><span>Seasonal risk <small>(experimental)</small></span><b>${sr.hasData ? `${R.TIERS[sr.tier]} · ${sr.value.toFixed(1)}× typical` : "Not available"}</b></div>
      <p class="hint">${RISK_NOTE}</p>
      <div class="r"><span>Past outbreaks</span><b>${hist.n ? hist.n + " · last " + fmtShort(hist.last) : "None on record"}</b></div>
      <div class="do"><b>What to do</b><ul>${DO[z.zone || "none"].map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>${extraMore}</div>`;
    el.innerHTML = `<div class="band ${band[0]}"><b>${band[1]}</b><small>${esc(where)}${sub ? " · " + esc(sub) : ""}</small></div><div class="bd"><div class="chips2">${chips.join("")}</div><p class="tip">${esc(tip)}</p>${more}<div class="pacts">${extra}<button class="pb ghostb" data-more>Details ▾</button></div></div>`;
    const mb = el.querySelector("[data-more]"); mb.onclick = async () => { const m = el.querySelector(".more"); m.hidden = !m.hidden; mb.textContent = m.hidden ? "Details ▾" : "Less ▴";
      if (!m.hidden) { await fitCard(pt, el.offsetHeight + 40); placeCard(); } };
    await fitCard(pt); openCard(pt, el);
    el.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => { cardBox.hidden = true; cardPt = null; (ctx.actions[b.dataset.act] || (() => {}))(pt, title); }));
  }
  ctx.locationCard = locationCard;

  // past outbreak areas at a point (released zones + real county history)
  async function pastAt(pt) {
    let n = 0, last = 0, real = 0;
    histLyr.graphics.forEach((g) => { if (g.attributes.released && geometryEngine.intersects(g.geometry, pt.spatialReference.isWebMercator ? pt : wmu.geographicToWebMercator(pt))) { n++; if (g.attributes.kind !== "sample") real++; last = Math.max(last, g.attributes.start || 0); } });
    return { n, last, sample: n > 0 && !real };
  }

  // ---------------- waterfowl habitat (for seasonal risk) ----------------
  let habitatGeom = null, habitatP = null;
  function loadHabitat() {
    if (habitatP) return habitatP;
    const q = (l, where) => l.queryFeatures({ where: where || "1=1", geometry: S.clearGeom ? S.clearGeom.extent : null, returnGeometry: true, maxAllowableOffset: 400, outSpatialReference: { wkid: 102100 } }).then((r) => r.features.map((f) => f.geometry)).catch(() => []);
    habitatP = ready.then(async () => {
      const parts = (await Promise.all([q(env.waterfowl), q(env.wma, "DESIG = 'WMA'"), q(env.refuges)])).flat().filter(Boolean);
      habitatGeom = parts.length ? geometryEngine.union(parts.map((g) => geometryEngine.generalize(g, 300, true))) : null;
      return habitatGeom;
    }).catch(() => null);
    return habitatP;
  }
  setTimeout(loadHabitat, 4000);   // warm up in the background
  // 1 inside habitat, falling to 0 at 5 km
  async function habitatAt(g, wait) {
    const hg = habitatGeom || (wait ? await loadHabitat() : null); if (!hg) return 0;
    const d = trueKm(hg, wmu.geographicToWebMercator(new Point({ longitude: g.longitude, latitude: g.latitude })));
    return Math.max(0, 1 - d / 5);
  }
  ctx.habitatAt = habitatAt;
  ctx.habitatKm = async (g) => { const hg = habitatGeom || await Promise.race([loadHabitat(), new Promise((r) => setTimeout(() => r(null), 8000))]); return hg ? trueKm(hg, wmu.geographicToWebMercator(new Point({ longitude: g.longitude, latitude: g.latitude }))) : null; };

  // ---------------- seasonal risk (hexagons, ~6 km) ----------------
  // Model in js/risk.js: eBird Status & Trends waterfowl abundance with the Gonnerman et al. 2025 coefficient (experimental).
  const HEX_R = 3500;
  const RISK_NOTE = "Experimental, not yet validated; advisory only. Waterfowl-based, adapted from Gonnerman et al. 2025 (One Health), with eBird Status &amp; Trends data.";
  ctx.RISK_NOTE = RISK_NOTE;
  function hexCentres() {
    const ext = S.clearGeom.extent, w = Math.sqrt(3) * HEX_R, out = [];
    for (let y = ext.ymin, row = 0; y < ext.ymax; y += 1.5 * HEX_R, row++) {
      for (let x = ext.xmin + (row % 2 ? w / 2 : 0); x < ext.xmax; x += w) {
        const c = new Point({ x, y, spatialReference: { wkid: 102100 } });
        if (!geometryEngine.contains(S.clearGeom, c)) continue;
        const g = wmu.webMercatorToGeographic(c);
        out.push({ x, y, lat: g.latitude, lon: g.longitude });
      }
    }
    return out;
  }
  // Seasonal risk model inputs: eBird Status & Trends waterfowl (data/waterfowl_st.json, tools/build_ebirdst.py).
  let riskModelP = null;
  function riskModel() {
    if (riskModelP) return riskModelP;
    riskModelP = (async () => {
      await ready;
      const doc = await fetch("data/waterfowl_st.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      return { centres: hexCentres(), st: R.prepareST(doc) };
    })();
    return riskModelP;
  }
  const riskAt = (lat, lon, m) => R.seasonalRisk({ pt: { lat, lon }, st: m && m.st, date: Date.now() });
  ctx.riskModel = riskModel;
  ctx.riskAt = async (lat, lon) => riskAt(lat, lon, await riskModel());
  // every hexagon with its risk and parts, and its outline in lon/lat (for the data export)
  ctx.riskHexes = async () => {
    const m = await riskModel(), Rm = 6378137, deg = 180 / Math.PI;
    const ll = (x, y) => [+(x / Rm * deg).toFixed(5), +((2 * Math.atan(Math.exp(y / Rm)) - Math.PI / 2) * deg).toFixed(5)];
    return m.centres.map(({ x, y, lat, lon }) => {
      const ring = []; for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 30); ring.push(ll(x + HEX_R * Math.cos(a), y + HEX_R * Math.sin(a))); } ring.push(ring[0]);
      return { lat, lon, ring, r: riskAt(lat, lon, m) };
    });
  };
  async function buildRisk() {
    const m = await riskModel(); riskLyr.removeAll();
    const cols = { 0: [0, 0, 0, 0], 1: [209, 196, 233, 0.5], 2: [149, 117, 205, 0.55], 3: [94, 53, 177, 0.6] };   // purples: advisory, not a regulatory zone
    m.centres.forEach(({ x, y, lat, lon }) => {
      const v = riskAt(lat, lon, m);
      if (!v.tier) return;
      const ring = []; for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 30); ring.push([x + HEX_R * Math.cos(a), y + HEX_R * Math.sin(a)]); } ring.push(ring[0]);
      riskLyr.add(new Graphic({ geometry: new Polygon({ rings: [ring], spatialReference: { wkid: 102100 } }), attributes: { tier: v.tier, value: v.value }, symbol: { type: "simple-fill", color: cols[v.tier], outline: { color: [255, 255, 255, 0.25], width: 0.4 } } }));
    });
  }
  let riskBuilt = false;
  reactiveUtils.watch(() => riskLyr.visible, (v) => { if (v && !riskBuilt) { riskBuilt = true; toast("Building seasonal risk…"); buildRisk().then(async () => { const m = await riskModel(); toast(m.st ? "Seasonal risk (experimental, after Gonnerman et al. 2025): week of " + new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" }) : "Seasonal risk data not available yet"); }); } });
  on("wild", () => { if (riskBuilt) buildRisk(); });

  // ---------------- past outbreaks + time slider ----------------
  // Every control area on one timeline: released ones from the public history layer (start = detection, end = release)
  // plus the ones in force today (no end yet). On any date the slider shows, an area is RED if it was in force that day
  // and GREY for 28 days after its release (WOAH / USDA: two 14-day flock incubation periods), and hidden otherwise.
  const PAST_DAYS = 28;
  const pubHist = () => has(C.pub.history) ? new FeatureLayer({ url: C.pub.history }).queryFeatures({ where: "1=1", outFields: ["*"], returnGeometry: true, outSpatialReference: { wkid: 102100 } }).then((r) => r.features).catch(() => []) : Promise.resolve([]);
  let pastItems = [];
  const loadHistory = () => pubHist().then((ph) => {
    pastItems = ph.map((f) => ({ geom: f.geometry, start: f.attributes.start_date, end: f.attributes.end_date, kind: f.attributes.sample ? "sample" : "zone", county: f.attributes.county || "", released: true }));
    S.released = ph.filter((f) => f.attributes.sample !== 1 && f.attributes.end_date).map((f) => ({ county: f.attributes.county, end: f.attributes.end_date }));
    paintCounties(); drawTimeline();
    return pastItems;
  });
  function drawTimeline() {
    histLyr.removeAll();
    const live = (S.areas || []).map((f) => ({ geom: f.geometry, start: f.attributes.since || f.attributes.confirmed_date || f.attributes.created_date || Date.now(), end: Infinity, kind: f.attributes.sample === 1 ? "sample" : "zone", county: f.attributes.county || "", released: false }));
    pastItems.concat(live).forEach((i) => histLyr.add(new Graphic({ geometry: i.geom, attributes: { start: i.start, end: i.end, kind: i.kind, county: i.county, released: i.released } })));
    applyTime();
  }
  on("areas", () => drawTimeline());
  const histReady = loadHistory();
  ctx.reloadHistory = () => loadHistory();
  S.timeAt = null; let timeT0 = null, playing = null;   // S.timeAt null = today
  const statusAt = (a, t) => a.start <= t && t <= a.end ? "active" : a.end < t && t - a.end <= PAST_DAYS * DAY ? "recent" : null;
  function applyTime() {
    const today = S.timeAt == null, t = today ? Date.now() : S.timeAt;
    histLyr.graphics.forEach((g) => {
      const a = g.attributes, st = statusAt(a, t), show = today ? a.released && st === "recent" : !!st;   // today: the live layer draws the areas in force
      g.visible = show; if (!show) return;
      const dash = a.kind === "sample" ? "dash" : "solid";
      g.symbol = st === "active" ? fill(RED, 0.24, RED.concat(1), 2, dash) : fill(SLATE, a.kind === "sample" ? 0.18 : 0.3, SLATE.concat(0.95), 1.2, dash);
    });
    // looking back: today's live areas, markers and premises step aside so the map shows only that date
    S.lookBack = !today;
    [L.ca, L.markers, L.prem, L.perim].forEach((l) => { if (l) l.opacity = today ? 1 : 0; });
    fadeByZoom();
    const lab = $("timeLab"); if (lab) lab.textContent = today ? "Today" : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const tb = $("timeToday"); if (tb) tb.hidden = today;
  }
  histReady.then((items) => { timeT0 = Math.min(Date.parse("2022-01-01"), ...items.map((i) => i.start)); renderKey(); });
  // ---------------- floating layers & key (minimizable) ----------------
  const keyEl = document.createElement("div"); keyEl.className = "lk glass shut";   // starts closed; opens upward when clicked
  const acctEl = document.createElement("div"); acctEl.id = "acctFloat";
  view.ui.add(acctEl, { position: "top-right", index: 0 });
  ctx.acctEl = acctEl;
  view.ui.add(keyEl, "bottom-right");
  const ROWS = () => [
    { sec: "Outbreak" },
    { id: "ca", t: "Control area", n: `${H.mi(C.zones.controlKm)} mi around infected premises`, sw: "ca", ls: () => [L.ca] },
    { id: "sz", t: "Surveillance zone", n: `${H.mi(C.zones.controlKm)}–${H.mi(C.zones.surveillanceKm)} mi out · zoom in to see`, sw: "sz", ls: () => [L.sz] },
    { id: "pm", roles: ["hauler", "industry"], t: "Infected premises", n: C.privacy.markerShiftKm[1] ? "approximate location" : "", sw: "barn", ls: () => [L.markers] },
    { id: "ex", staff: 1, t: "Infected premises (exact)", n: "MDA only", sw: "perim", ls: () => [L.prem, L.perim] },
    { id: "cty", t: "Affected county", n: "HPAI reported in the last 28 days", sw: "cty", ls: () => [tintLyr] },
    { id: "past", t: "Past outbreaks", n: "Released in the last 28 days", sw: "past", ls: () => [histLyr], time: true },
    { sec: "Wildlife" },
    { id: "wb", t: "Wildlife with HPAI", n: "Birds and mammals", sw: "wb", ls: () => [wild], seg: true },
    { id: "risk", t: "Seasonal risk", n: "Experimental · needs validation · advisory. After Gonnerman et al. 2025", sw: "risk", ls: () => [riskLyr], off: true },
    { id: "ebd", t: "Waterfowl sightings", n: S.birdsNote || "eBird · healthy birds", sw: "ebd", ls: () => [birdsLyr], off: true },
    { id: "wf", t: "Waterfowl areas", sw: "wf", ls: () => [env.waterfowl], off: true },
    { id: "nwr", t: "Wildlife refuges", sw: "nwr", ls: () => [env.refuges], off: true },
    { id: "wma", t: "Wildlife management areas", sw: "wma", ls: () => [env.wma], off: true },
    { sec: "Land and water" },
    { id: "for", t: "Forests and land cover", sw: "for", ls: () => [env.land], off: true },
    { sec: "Farms and roads", roles: ["regulator", "industry"] },
    { id: "reg", staff: 1, t: "Registered premises", n: "Dashed = not yet validated", sw: "reg", ls: () => [ctx.layers.registry] },
    { id: "farm", staff: 1, t: "Poultry farms", n: "Estimated locations", sw: "farm", ls: () => [ctx.layers.farms], off: true },
    { id: "road", roles: ["regulator", "industry"], t: "Road closures", sw: "road", ls: () => [closuresLyr], off: true }
  ];
  const vis = store.get("vis", {});
  function renderKey() {
    const $ = (id) => keyEl.querySelector("#" + id) || document.getElementById(id);   // works before the panel is on the page
    const rows = ROWS().filter((r) => (!r.staff || ctx.isStaff()) && (!r.roles || r.roles.includes(S.ws)));
    let html = `<header id="keyHead"><svg class="lki" viewBox="0 0 24 24"><path d="M12 3 2 8l10 5 10-5z"/><path d="M2 13l10 5 10-5"/></svg><span>Layers &amp; key${S.sample ? ' <i class="smpl" title="The control areas shown are exercise data, not real outbreaks">Sample zones</i>' : ""}</span><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></header><div class="body">`;
    rows.forEach((r, i) => {
      if (r.sec) { if (rows[i + 1] && !rows[i + 1].sec) html += `<h4>${esc(r.sec)}</h4>`; return; }
      const ls = r.ls().filter(Boolean); if (!ls.length) return;
      const on = vis[r.id] != null ? vis[r.id] : !r.off;
      ls.forEach((l) => (l.visible = on));
      html += `<label class="lrow"><span class="sw ${r.sw}"></span><span class="nm">${esc(r.t)}${r.n ? `<small title="${esc(r.n)}">${esc(r.n)}</small>` : ""}</span><input type="checkbox" class="tg" data-id="${r.id}" ${on ? "checked" : ""}></label>`;
      if (r.time && on && timeT0) {
        const weeks = Math.max(1, Math.ceil((Date.now() - timeT0) / (7 * DAY))), cur = S.timeAt == null ? weeks : Math.round((S.timeAt - timeT0) / (7 * DAY));
        html += `<div class="tline"><button class="tplay" id="timePlay" aria-label="Play">${playing ? "❚❚" : "▶"}</button><input type="range" id="timeRange" min="0" max="${weeks}" value="${cur}" aria-label="Week"><b id="timeLab"></b></div><button class="mini ttoday" id="timeToday" hidden>Back to today</button>`;
      }
      if (r.id === "ebd" && on && S.birdWeeks && S.birdWeeks.length) {
        const n = S.birdWeeks.length, cur = S.birdWeek == null ? n : S.birdWeek;
        html += `<div class="tline"><button class="tplay" id="bwPlay" aria-label="Play the weeks">${birdPlay ? "❚❚" : "▶"}</button><input type="range" id="bwRange" min="0" max="${n}" value="${cur}" aria-label="Week"><b id="bwLab">${birdWeekLabel(S.birdWeek)}</b></div>`;
      }
      if (r.seg) html += `<div class="seg" id="wildSeg"><button data-d="28" class="${S.wildRange === 28 ? "on" : ""}">4 weeks</button><button data-d="365" class="${S.wildRange === 365 ? "on" : ""}">12 months</button><button data-d="9999" class="${S.wildRange === 9999 ? "on" : ""}">All years</button></div>`;
    });
    html += `</div>`;
    keyEl.innerHTML = html;
    $("keyHead").onclick = () => keyEl.classList.toggle("shut");
    $("keyHead").setAttribute("role", "button"); $("keyHead").setAttribute("tabindex", "0"); $("keyHead").setAttribute("aria-expanded", String(!keyEl.classList.contains("shut")));
    $("keyHead").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); keyEl.classList.toggle("shut"); } };
    keyEl.querySelectorAll(".tg").forEach((t) => (t.onchange = () => { const r = ROWS().find((x) => x.id === t.dataset.id); vis[r.id] = t.checked; store.set("vis", vis); r.ls().filter(Boolean).forEach((l) => (l.visible = t.checked)); if (r.time && !t.checked) { if (playing) { clearInterval(playing); playing = null; } S.timeAt = null; applyTime(); }
      if (r.id === "ebd") { if (t.checked) loadBirdWeeks().then(() => renderKey()); else { if (birdPlay) { clearInterval(birdPlay); birdPlay = null; } if (S.birdWeek != null) showBirdWeek(null); } } if (r.time) renderKey(); }));
    const bw = $("bwRange");
    if (bw) {
      const setW = () => showBirdWeek(+bw.value >= +bw.max ? null : +bw.value);
      bw.oninput = setW;
      $("bwPlay").onclick = () => {
        if (birdPlay) { clearInterval(birdPlay); birdPlay = null; $("bwPlay").textContent = "▶"; return; }
        if (+bw.value >= +bw.max) bw.value = 0;
        $("bwPlay").textContent = "❚❚"; setW();
        birdPlay = setInterval(() => { if (+bw.value >= +bw.max) { clearInterval(birdPlay); birdPlay = null; const p = $("bwPlay"); if (p) p.textContent = "▶"; return; } bw.value = +bw.value + 1; setW(); }, 700);
      };
    }
    const seg = $("wildSeg"); if (seg) seg.querySelectorAll("button").forEach((b) => (b.onclick = () => { S.wildRange = +b.dataset.d; store.set("wildRange", S.wildRange); seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); loadWild(); }));
    const tr = $("timeRange");
    if (tr) {
      const set = () => { S.timeAt = +tr.value >= +tr.max ? null : timeT0 + +tr.value * 7 * DAY; applyTime(); };
      $("timeToday").onclick = () => { if (playing) { clearInterval(playing); playing = null; $("timePlay").textContent = "▶"; } tr.value = tr.max; set(); };
      tr.oninput = set; set();
      $("timePlay").onclick = () => {
        if (playing) { clearInterval(playing); playing = null; $("timePlay").textContent = "▶"; return; }
        if (+tr.value >= +tr.max) tr.value = 0;
        $("timePlay").textContent = "❚❚";
        playing = setInterval(() => { if (+tr.value >= +tr.max) { clearInterval(playing); playing = null; const p = $("timePlay"); if (p) p.textContent = "▶"; return; } tr.value = +tr.value + 1; set(); }, 180);
      };
    }
  }
  ctx.renderKey = renderKey;

  // ---------------- click on the map ----------------
  // an address box that's waiting for a map tap: its pin was pressed, or the cursor was still in it when the map was clicked
  let armedAddr = null, focusAddr = null;
  view.on("pointer-down", () => { const a = document.activeElement; focusAddr = a && a.tagName === "INPUT" && a.closest ? a.closest(".addr") : null; });
  ctx.armAddr = (host) => { armedAddr = host; view.container.style.cursor = "crosshair"; };
  view.on("click", async (e) => {
    const box = armedAddr || focusAddr; armedAddr = focusAddr = null; view.container.style.cursor = "";
    document.querySelectorAll(".addr.arming").forEach((x) => x.classList.remove("arming"));
    if (box && box._fill && document.body.contains(box)) { closeCard(); return box._fill(e.mapPoint); }
    if (emit("pick", e.mapPoint).some(Boolean)) return;            // a module is waiting for a map pick
    if (closeCard()) return;                                       // a card was open: this click only closes it
    if (!ctx.inArea(e.mapPoint)) return;                           // outside Maryland / Delmarva: do nothing
    if (S.lookBack) return pastCard(e.mapPoint);
    const include = [wild, L.markers, L.prem, closuresLyr].concat(emit("hitLayers").flat()).filter(Boolean);
    const hit = await view.hitTest(e, { include }).catch(() => null);
    const g = hit && hit.results.find((r) => r.graphic && r.graphic.layer);
    if (g) {
      if (g.graphic.layer === wild) return wildCard(g.graphic);
      if (g.graphic.layer === L.markers) return markerCard(g.graphic, e.mapPoint);
      if (g.graphic.layer === closuresLyr) return simpleCard(e.mapPoint, "info", "Road closure", g.graphic.attributes.incident, [["Lanes", g.graphic.attributes.lanes], ["Updated", g.graphic.attributes.updated]]);
      if (emit("hit", { g: g.graphic, pt: e.mapPoint }).some(Boolean)) return;
    }
    if (birdsLyr.visible && S.birdsOk && view.zoom >= BIRD_DOTS_ZOOM) {
      const bh = await view.hitTest(e, { include: [birdsLyr] }).catch(() => null), bg = bh && bh.results.find((r) => r.graphic);
      if (bg) {
        const a = bg.graphic.attributes;
        return simpleCard(bg.graphic.geometry, "ebird", `Waterfowl · ${birdWeekLabel(S.birdWeek)}`, a.place || "Waterfowl sighting", [["Birds (highest counts)", a.birds], ["Species", a.species], a.last ? ["Last seen", a.last] : null].filter(Boolean),
          `<div class="do">Healthy wild waterfowl can carry HPAI. Where people went birding, not a census. Source: eBird, Cornell Lab of Ornithology.</div>`);
      }
    }
    // inside a refuge, wildlife management area or waterfowl area that's switched on: name it on the place card
    const envOn = [env.refuges, env.wma, env.waterfowl].filter((l) => l.visible);
    const eh = envOn.length ? await view.hitTest(e, { include: envOn }).catch(() => null) : null, eg = eh && eh.results.find((r) => r.graphic);
    const place = eg ? (eg.graphic.layer === env.refuges ? (eg.graphic.attributes.ORGNAME || "National wildlife refuge") : eg.graphic.layer === env.wma ? (eg.graphic.attributes.DNRName || "Wildlife management area") : "Waterfowl concentration area") : "";
    locationCard(e.mapPoint, "This location", place);
  });
  // looking back on the slider: what was at this spot on that date
  function pastCard(pt) {
    const t = S.timeAt, day = fmtDate(t), hits = histLyr.graphics.toArray().filter((g) => g.visible && geometryEngine.intersects(g.geometry, pt));
    const act = hits.find((g) => statusAt(g.attributes, t) === "active"), g = act || hits[0], a = g && g.attributes, cty = ctx.countyAt(pt);
    const span = a ? `${fmtDate(a.start)} – ${a.end === Infinity ? "still in force" : fmtDate(a.end)}` : "";
    if (!a) return simpleCard(pt, "free", "On " + day, "No control area", [["County", cty ? cty.name : "–"]], `<div class="do">Showing the map as it was on ${esc(day)}. Slide to today for the current status.</div>`);
    simpleCard(pt, act ? "ca" : "info", `On ${day}${a.kind === "sample" ? " · SAMPLE" : ""}`, act ? "Control area in force" : "Released control area", [["County", a.county || (cty ? cty.name : "–")], ["Control area", span]],
      `<div class="do">${act ? "Movement permits were required here on this date." : `Released ${esc(fmtDate(a.end))}, within the 28 days before this date.`} Slide to today for the current status.</div>`);
  }
  function simpleCard(pt, band, small, big, rows, extra) {
    const el = document.createElement("div"); el.className = "pop";
    el.innerHTML = `<div class="band ${band}"><small>${esc(small)}</small><b>${esc(big || "")}</b></div><div class="bd">${(rows || []).map(([k, v]) => `<div class="r"><span>${esc(k)}</span><b>${esc(v == null ? "–" : v)}</b></div>`).join("")}${extra || ""}</div>`;
    fitCard(pt).then(() => openCard(pt, el)); return el;
  }
  ctx.simpleCard = simpleCard;
  function wildCard(g) {
    const a = g.attributes;
    simpleCard(g.geometry, a.group === "mammal" ? "mammal" : "bird", a.group === "mammal" ? "HPAI in a mammal" : "HPAI in a wild bird", a.species || "Species not listed", [["Detected", fmtDate(a.detected) + " · " + H.ago(a.detected)], ["County", `${a.county}, ${a.state}`], ["Strain", a.strain]],
      `<div class="do">Shown at county level, not the exact site. Source: USDA APHIS.</div><button class="cta" data-act="wildReport">Report a dead wild bird</button>`)
      .querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => { closeCard(); ctx.actions.wildReport(); }));
  }
  function markerCard(g, pt) {
    const a = g.attributes, since = a.since;
    simpleCard(pt, "prem", "Infected premises" + (a.sample === 1 ? " · SAMPLE" : ""), C.privacy.markerShiftKm[1] ? "Approximate location" : (a.county || "") + " County", [["County", a.county], ["Confirmed", fmtDate(since)], ["Status", a.status]],
      (C.privacy.markerShiftKm[1] ? `<div class="do">To protect the farm's privacy, this marker is moved up to ${C.privacy.markerShiftKm[1]} km from the real site.</div>` : `<div class="do">Use the zone shading for movement rules.</div>`));
  }

  // ---------------- roles and sign-in ----------------
  const WS = { public: "Public", regulator: "MDA staff", industry: "Industry partner" };
  function setWorkspace(w) {
    S.ws = w; document.body.dataset.ws = w;
    document.querySelectorAll("[data-for]").forEach((el) => (el.hidden = !el.dataset.for.split(" ").includes(w)));
    try { sessionStorage.setItem("hpaiWs", w); } catch (e) {}
    renderAcct(); buildOutbreakLayers(); emit("ws", w);
  }
  ctx.setWorkspace = setWorkspace;
  // the account button + dropdown live in menu.js; it re-renders on these events
  function renderAcct() { emit("acct"); }
  ctx.WS = WS;
  // MDA staff sign in with ArcGIS; industry partners with an email or text code (industry.js)
  ctx.signIn = (kind) => {
    if (kind === "partner" || kind === "industry") return ctx.actions.industrySignIn();
    try { sessionStorage.setItem("hpaiWs", "regulator"); } catch (e) {} esriId.getCredential(sharing).then(initUser).catch(() => {});
  };
  ctx.signOut = () => { esriId.destroyCredentials(); try { sessionStorage.removeItem("hpaiWs"); localStorage.removeItem(IND_KEY); } catch (e) {} location.reload(); };
  async function initUser() {
    const portal = new Portal({ url: C.portalUrl, authMode: "immediate" });
    await portal.load(); S.user = portal.user;
    const groups = await portal.user.fetchGroups().catch(() => []);
    S.groups = groups.map((g) => g.title);
    // what someone sees depends only on who they are (their group), never on a choice
    S.role = S.groups.includes(C.regulatorGroup) ? "regulator"
      : (S.groups.includes(C.industryGroup) || S.groups.includes(C.haulerGroup)) ? "industry" : "pending";   // older ArcGIS industry accounts still work
    S.roles = S.role === "pending" ? [] : [S.role];
    try { sessionStorage.removeItem("hpaiWs"); } catch (e) {}
    const note = $("pendingNote");
    if (S.role === "pending") {
      note.hidden = false;
      note.innerHTML = `<b>This ArcGIS account isn't on MDA's staff list yet.</b> You see the public map. If you should have staff access, send your username <b>${esc(S.user.username)}</b> to the tool's administrator, then sign in again. Industry partners sign in with their email or mobile number instead: <a href="#" id="pendReq">sign out and use a code</a>.`;
      $("pendReq").onclick = (e) => { e.preventDefault(); esriId.destroyCredentials(); try { sessionStorage.removeItem("hpaiWs"); sessionStorage.setItem("hpaiInd", "1"); } catch (x) {} location.reload(); };
    } else note.hidden = true;
    setWorkspace(S.role === "pending" ? "public" : S.role);
    emit("signin", S.user);
  }

  // panel action buttons
  document.addEventListener("click", (e) => { const b = e.target.closest(".act[data-t]"); if (b && ctx.actions[b.dataset.t]) ctx.actions[b.dataset.t](); });

  // ---------------- collapsible side panel (full-screen map) ----------------
  (function panelToggle() {
    const b = $("panelToggle"), setState = (shut) => {
      document.body.classList.toggle("pshut", shut);
      b.setAttribute("aria-expanded", String(!shut)); b.title = shut ? "Show panel" : "Hide panel (full-screen map)";
      store.set("panelShut", shut);
    };
    b.onclick = () => setState(!document.body.classList.contains("pshut"));
    if (window.innerWidth > 760 && store.get("panelShut", false)) setState(true);
  })();

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

  // first visit: one gentle hint, then never again
  if (!store.get("hinted", false)) {
    const b = document.createElement("div"); b.className = "hintbub glass"; b.innerHTML = `<span>Tap anywhere on the map to check a place</span><button aria-label="Dismiss">×</button>`;
    $("viewDiv").appendChild(b);
    const bye = () => { b.remove(); store.set("hinted", true); };
    b.querySelector("button").onclick = bye; view.on("click", bye); setTimeout(bye, 12000);
  }

  // ---------------- start ----------------
  (H.modules || []).forEach((m) => { try { m(ctx); } catch (e) { console.error("module", e); } });
  setWorkspace("public");
  if (ctx.ind.token() && ((C.auth && C.auth.url) || ctx.ind.token().startsWith(H.PREVIEW_PREFIX || "preview."))) {
    // an industry partner who signed in before (30 days): check their access is still active
    ctx.ind.api("/me").then((r) => ctx.ind.begin(r.user)).catch(() => { try { localStorage.removeItem(IND_KEY); } catch (e) {} esriId.checkSignInStatus(sharing).then(initUser).catch(() => {}); });
  } else esriId.checkSignInStatus(sharing).then(initUser).catch(() => {
    let want = null; try { want = sessionStorage.getItem("hpaiWs"); if (sessionStorage.getItem("hpaiInd")) { sessionStorage.removeItem("hpaiInd"); setTimeout(() => ctx.actions.industrySignIn(), 500); } } catch (e) {}
    if (want === "regulator") esriId.getCredential(sharing).then(initUser).catch(() => {});
  });
  if (location.hash.startsWith("#verify=")) on("signin", () => (ctx.actions.verify || (() => {}))(decodeURIComponent(location.hash.slice(8))));
});
