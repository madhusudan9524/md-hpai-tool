/* Maryland HPAI Response Map - prototype
   Public: control-area lookup, released areas fading with age, wild-bird detections
   Haulers: truck routing that avoids active control areas + permit request link
   Regulators: premises, all zone rings, details
*/
require([
  "esri/config", "esri/identity/OAuthInfo", "esri/identity/IdentityManager",
  "esri/Map", "esri/views/MapView", "esri/layers/FeatureLayer", "esri/layers/GraphicsLayer", "esri/Graphic",
  "esri/widgets/Search", "esri/widgets/LayerList", "esri/widgets/Home", "esri/widgets/DistanceMeasurement2D", "esri/widgets/Expand",
  "esri/rest/route", "esri/rest/support/RouteParameters", "esri/rest/support/FeatureSet", "esri/rest/networkService",
  "esri/geometry/geometryEngine", "esri/geometry/support/webMercatorUtils", "esri/portal/Portal"
], function (esriConfig, OAuthInfo, esriId, Map, MapView, FeatureLayer, GraphicsLayer, Graphic,
  Search, LayerList, Home, DistanceMeasurement2D, Expand, route, RouteParameters, FeatureSet, networkService, geometryEngine, webMercatorUtils, Portal) {

  const C = window.HPAI_CONFIG;
  const PZ = C.publicZonesUrl || C.zonesUrl;   // public layer: no premises IDs (use a public view in production)
  esriConfig.portalUrl = C.portalUrl;
  if (C.appId && !C.appId.startsWith("REPLACE")) {
    esriId.registerOAuthInfos([new OAuthInfo({ appId: C.appId, portalUrl: C.portalUrl, popup: false })]);
  }

  const DAY = 86400000;
  const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "";
  const daysAgo = (ms) => Math.max(0, Math.round((Date.now() - ms) / DAY));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------------- Layers ----------------
  const fill = (rgba, outline, w = 1, style = "solid") => ({ type: "simple-fill", color: rgba, outline: { color: outline, width: w, style } });

  // PUBLIC: active control areas (no premises identity in popup)
  const pubCA = new FeatureLayer({
    url: PZ, title: "Active control areas",
    definitionExpression: "zone_type = 'Control Area' AND status = 'Active'",
    outFields: ["confirmed_date"],
    renderer: { type: "simple", symbol: fill([200, 40, 30, 0.25], [180, 35, 24, 0.9], 0.5) },
    popupTemplate: { title: "Active HPAI control area", content: [{ type: "text", text: "Established {confirmed_date}. A movement permit from MDA is required for poultry, poultry products, feed and other regulated items moving onto or off premises in this area." }], fieldInfos: [{ fieldName: "confirmed_date", format: { dateFormat: "short-date" } }] }
  });

  // PUBLIC: active surveillance zones (10-20 km), drawn faint
  const pubSZ = new FeatureLayer({
    url: PZ, title: "Active surveillance zones",
    definitionExpression: "zone_type = 'Surveillance Zone' AND status = 'Active'",
    outFields: ["confirmed_date"],
    renderer: { type: "simple", symbol: fill([243, 198, 74, 0.14], [200, 150, 20, 0.9], 0.75, "dash") },
    popupTemplate: { title: "Active HPAI surveillance zone", content: [{ type: "text", text: "Established {confirmed_date}. Within 20 km of an infected premises, outside the control area. No movement permit is required, but flocks may be tested. Report sick or dead birds to MDA immediately." }], fieldInfos: [{ fieldName: "confirmed_date", format: { dateFormat: "short-date" } }] }
  });

  // PUBLIC + REGULATOR: released control areas, fading with time since release
  const releasedRenderer = {
    type: "simple", symbol: fill([120, 120, 120, 1], [105, 105, 105, 1], 0.75, "dash"),
    visualVariables: [{
      type: "opacity", valueExpression: "DateDiff(Now(), $feature.released_date, 'days')", valueExpressionTitle: "Days since release",
      stops: [{ value: 0, opacity: 0.45 }, { value: 60, opacity: 0.30 }, { value: 180, opacity: 0.16 }, { value: 365, opacity: 0.06 }]
    }]
  };
  const releasedPopup = {
    title: "Released control area",
    expressionInfos: [{ name: "ago", expression: "DateDiff(Now(), $feature.released_date, 'days')" }],
    content: "Control area established {confirmed_date}, released {released_date} ({expression/ago} days ago). No current movement restrictions from this event.",
    fieldInfos: [{ fieldName: "confirmed_date", format: { dateFormat: "short-date" } }, { fieldName: "released_date", format: { dateFormat: "short-date" } }, { fieldName: "expression/ago", format: { digitSeparator: true, places: 0 } }]
  };
  const pubReleased = new FeatureLayer({
    url: PZ, title: "Released control areas (fade with age)",
    definitionExpression: "zone_type = 'Control Area' AND status = 'Released'",
    outFields: ["confirmed_date", "released_date"], renderer: releasedRenderer, popupTemplate: releasedPopup
  });

  // PUBLIC + REGULATOR: wild-bird detections from the last 4 weeks, one point per detection
  // (APHIS publishes county only, so each point sits inside the county; it is not an exact site)
  const WILD_DAYS = 28;
  const wildCutoff = new Date(Date.now() - WILD_DAYS * DAY).toISOString().slice(0, 10);
  const wild = new FeatureLayer({
    url: C.wildBirdsUrl, title: "HPAI in wild birds (last 4 weeks)", outFields: ["*"],
    definitionExpression: `state = 'Maryland' AND last_detected >= DATE '${wildCutoff}'`,
    renderer: { type: "simple", symbol: { type: "simple-marker", style: "circle", size: 9, color: [31, 122, 140, 0.95], outline: { color: [255, 255, 255, 1], width: 1.5 } } },
    popupTemplate: {
      title: "HPAI in a wild bird",
      content: "{species}<br>Detected {last_detected}<br>{county} County, {state}<br><span style='font-size:11px'>Source: USDA APHIS. Shown at county level, not the exact site.</span>",
      fieldInfos: [{ fieldName: "last_detected", format: { dateFormat: "short-date" } }]
    }
  });

  // REGULATOR layers (full detail)
  const regPopup = (title) => ({
    title, content: [{ type: "fields", fieldInfos: [
      { fieldName: "premises_id", label: "Premises ID" }, { fieldName: "zone_type", label: "Zone" },
      { fieldName: "inner_km", label: "Inner radius (km)" }, { fieldName: "outer_km", label: "Outer radius (km)" },
      { fieldName: "status", label: "Status" },
      { fieldName: "confirmed_date", label: "Established", format: { dateFormat: "short-date" } },
      { fieldName: "released_date", label: "Released", format: { dateFormat: "short-date" } }] }]
  });
  const zoneLayer = (title, where, renderer, visible = true) => new FeatureLayer({ url: C.zonesUrl, title, definitionExpression: where, outFields: ["*"], renderer, popupTemplate: regPopup(title), visible });
  const regSZ = zoneLayer("Surveillance Zone (10–20 km)", "zone_type = 'Surveillance Zone' AND status = 'Active'", { type: "simple", symbol: fill([243, 198, 74, 0.12], [200, 150, 20, 1], 1, "dash") });
  const regBZ = zoneLayer("Buffer Zone (3–10 km)", "zone_type = 'Buffer Zone' AND status = 'Active'", { type: "simple", symbol: fill([235, 120, 40, 0.18], [210, 100, 30, 1], 1) });
  const regIZ = zoneLayer("Infected Zone (0–3 km)", "zone_type = 'Infected Zone' AND status = 'Active'", { type: "simple", symbol: fill([200, 30, 30, 0.35], [160, 20, 20, 1], 1.5) });
  const regCA = zoneLayer("Control Area outline (10 km)", "zone_type = 'Control Area' AND status = 'Active'", { type: "simple", symbol: fill([0, 0, 0, 0], [140, 20, 20, 1], 0.5) });
  const regReleased = new FeatureLayer({ url: C.zonesUrl, title: "Released control areas (fade with age)", definitionExpression: "zone_type = 'Control Area' AND status = 'Released'", outFields: ["*"], renderer: releasedRenderer, popupTemplate: regPopup("Released control area") });
  const perim = new FeatureLayer({
    url: C.perimeterUrl, title: "Premises perimeter (zones are measured from this edge)", outFields: ["*"],
    renderer: { type: "simple", symbol: fill([20, 20, 20, 0.3], [20, 20, 20, 1], 1.5) },
    popupTemplate: { title: "{premises_id}: premises perimeter", content: "Status: {status}<br>{note}" }
  });
  const premises = new FeatureLayer({
    url: C.premisesUrl, title: "Infected premises", outFields: ["*"],
    renderer: { type: "unique-value", field: "status",
      uniqueValueInfos: [
        { value: "Active", label: "Infected premises (active)", symbol: { type: "simple-marker", style: "diamond", size: 13, color: [140, 20, 20, 1], outline: { color: "white", width: 1.5 } } },
        { value: "Released", label: "Infected premises (released)", symbol: { type: "simple-marker", style: "diamond", size: 10, color: [120, 120, 120, 0.8], outline: { color: "white", width: 1 } } }] },
    popupTemplate: { title: "{premises_id} ({status})", content: [{ type: "fields", fieldInfos: [
      { fieldName: "county", label: "County" }, { fieldName: "flock_type", label: "Flock type" }, { fieldName: "birds", label: "Birds", format: { digitSeparator: true, places: 0 } },
      { fieldName: "confirmed_date", label: "Confirmed", format: { dateFormat: "short-date" } }, { fieldName: "released_date", label: "Released", format: { dateFormat: "short-date" } },
      { fieldName: "notes", label: "Notes" }] }] }
  });

  // OFFICIALS: submitted detection reports and permit requests (points on the map + review queues)
  const tri = (c) => ({ type: "simple-marker", style: "triangle", size: 15, color: c, outline: { color: "white", width: 1.5 } });
  const sqr = (c) => ({ type: "simple-marker", style: "square", size: 12, color: c, outline: { color: "white", width: 1.5 } });
  const repLyr = new FeatureLayer({ url: C.reportsUrl, title: "Detection reports", outFields: ["*"],
    renderer: { type: "unique-value", field: "review_status", defaultSymbol: tri([230, 90, 30, 1]), uniqueValueInfos: [
      { value: "New", label: "New report", symbol: tri([230, 90, 30, 1]) }, { value: "Confirmed", label: "Confirmed", symbol: tri([140, 20, 20, 1]) }, { value: "Dismissed", label: "Dismissed", symbol: tri([150, 150, 150, 0.8]) }] },
    popupTemplate: { title: "Report: {species}", content: [{ type: "fields", fieldInfos: [{ fieldName: "review_status", label: "Status" }, { fieldName: "premises_address", label: "Where" }, { fieldName: "flock_size", label: "Flock size" }, { fieldName: "sick_dead", label: "Sick / dead" }, { fieldName: "symptoms", label: "Signs" }, { fieldName: "reporter_name", label: "Reporter" }, { fieldName: "phone", label: "Phone" }] }] } });
  const perLyr = new FeatureLayer({ url: C.permitsUrl, title: "Permit requests", outFields: ["*"],
    renderer: { type: "unique-value", field: "review_status", defaultSymbol: sqr([30, 110, 190, 1]), uniqueValueInfos: [
      { value: "Pending", label: "Pending", symbol: sqr([30, 110, 190, 1]) }, { value: "Approved", label: "Approved", symbol: sqr([46, 139, 87, 1]) }, { value: "Denied", label: "Denied", symbol: sqr([150, 150, 150, 0.8]) }] },
    popupTemplate: { title: "Permit: {company}", content: [{ type: "fields", fieldInfos: [{ fieldName: "review_status", label: "Status" }, { fieldName: "commodity", label: "Commodity" }, { fieldName: "origin", label: "From" }, { fieldName: "destination", label: "To" }, { fieldName: "permit_reason", label: "Why" }, { fieldName: "vehicle_id", label: "Vehicle" }, { fieldName: "phone", label: "Phone" }] }] } });

  // OFFICIALS: known poultry farms (USGS houses mapped from 2016-17 imagery, grouped within 200 m); not an official MDA premises registry
  const farmsLyr = new FeatureLayer({ url: C.farmsUrl, title: "Poultry farms (estimated)", outFields: ["*"], visible: false,
    renderer: { type: "simple", symbol: { type: "simple-marker", style: "circle", size: 4, color: [125, 90, 40, 0.8], outline: { color: [255, 255, 255, 0.9], width: 0.6 } } },
    popupTemplate: { title: "Poultry farm {farm_id}", content: "{houses} poultry house(s)<br><span style='font-size:11px'>{source}. Estimated from aerial imagery; not an official premises record.</span>" } });

  // Query-only handle on all zones (never drawn)
  const zonesQ = new FeatureLayer({ url: PZ, outFields: ["zone_type", "status", "confirmed_date", "released_date"] });

  const marks = new GraphicsLayer({ title: "Selected locations", listMode: "hide" });
  const routeLyr = new GraphicsLayer({ title: "Route", listMode: "hide" });

  // Maryland counties (Esri Living Atlas): names + borders fade out as you zoom in
  const COUNTY_URL = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Counties_Generalized_Boundaries/FeatureServer/0";
  const countyLyr = new FeatureLayer({
    url: COUNTY_URL, title: "Counties", definitionExpression: "STATE_NAME = 'Maryland'", outFields: ["NAME"], popupEnabled: false, listMode: "hide",
    renderer: { type: "simple", symbol: { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: [70, 85, 100, 0.9], width: 1 } } },
    labelingInfo: [{ labelExpressionInfo: { expression: "Replace($feature.NAME, ' County', '')" }, labelPlacement: "always-horizontal",
      symbol: { type: "text", color: [45, 60, 78, 1], haloColor: [255, 255, 255, 0.9], haloSize: 1.5, font: { size: 11, weight: "bold" } } }]
  });
  const tintLyr = new GraphicsLayer({ title: "Counties with an outbreak", listMode: "hide" });   // mild red tint on counties that reported an outbreak
  const maskLyr = new GraphicsLayer({ title: "Outside Maryland", listMode: "hide" });
  const map = new Map({ basemap: "topo-vector", layers: [maskLyr, tintLyr, countyLyr, pubSZ, pubReleased, pubCA, wild, routeLyr, marks] });
  const view = new MapView({ container: "viewDiv", map, center: C.center, zoom: C.zoom, popup: { dockEnabled: false, collapseEnabled: false, autoCloseEnabled: false, visibleElements: { featureNavigation: false, actionBar: false, heading: false } }, popupEnabled: false });
  view.ui.add(new Home({ view }), "top-left");

  // ---- Maryland only ----
  let mdGeom = null, mdExtent = null, mdReady = null, outbreakAreas = [];
  const inMD = (pt) => !mdGeom || geometryEngine.contains(mdGeom, pt) || geometryEngine.intersects(mdGeom, pt);
  mdReady = countyLyr.queryFeatures({ where: "STATE_NAME = 'Maryland'", outFields: ["NAME"], returnGeometry: true, outSpatialReference: { wkid: 102100 } }).then((r) => {
    const feats = r.features;
    mdGeom = geometryEngine.union(feats.map((f) => f.geometry));
    mdExtent = mdGeom.extent.clone();
    view.constraints = { geometry: mdExtent.clone().expand(1.35), minZoom: 7 };   // can't pan away from Maryland
    const world = { type: "extent", xmin: -20037508, ymin: -20037508, xmax: 20037508, ymax: 20037508, spatialReference: { wkid: 102100 } };
    const clearArea = (dm) => geometryEngine.union([mdGeom].concat(dm));
    const worldPoly = { type: "polygon", rings: [[[world.xmin, world.ymin], [world.xmin, world.ymax], [world.xmax, world.ymax], [world.xmax, world.ymin], [world.xmin, world.ymin]]], spatialReference: { wkid: 102100 } };
    // Maryland + the rest of Delmarva (Delaware, Virginia's Eastern Shore) stay clear; everything else is faded
    new FeatureLayer({ url: COUNTY_URL }).queryFeatures({ where: "STATE_NAME = 'Delaware' OR (STATE_NAME = 'Virginia' AND NAME IN ('Accomack County','Northampton County'))", returnGeometry: true, outSpatialReference: { wkid: 102100 } })
      .then((dm) => dm.features.map((f) => f.geometry)).catch(() => [])
      .then((dg) => { maskLyr.add(new Graphic({ geometry: geometryEngine.difference(worldPoly, clearArea(dg)), symbol: { type: "simple-fill", color: [244, 246, 249, 0.78], outline: { color: [0, 0, 0, 0] } } })); });
    // outbreak tint: counties containing an active control area's center (the infected premises; no premises ID is read)
    zonesQ.queryFeatures({ where: "zone_type = 'Control Area' AND status = 'Active'", outFields: ["confirmed_date"], returnGeometry: true, outSpatialReference: { wkid: 102100 } }).then((za) => {
      const hit = new Map();
      za.features.forEach((z) => { const c = z.geometry.extent.center; feats.forEach((f) => { if (geometryEngine.contains(f.geometry, c)) { const o = hit.get(f) || { f, since: z.attributes.confirmed_date, ext: z.geometry.extent.clone() }; o.since = Math.min(o.since, z.attributes.confirmed_date); o.ext = o.ext.union(z.geometry.extent); hit.set(f, o); } }); });
      hit.forEach((o) => tintLyr.add(new Graphic({ geometry: o.f.geometry, symbol: { type: "simple-fill", color: [200, 40, 30, 0.12], outline: { color: [200, 40, 30, 0.4], width: 1 } } })));
      outbreakAreas = [...hit.values()].map((o) => ({ county: o.f.attributes.NAME.replace(" County", ""), since: o.since, ext: o.ext })).sort((a, b) => b.since - a.since);
      renderAreas();
    }).catch(() => {});
  }).catch(() => {});
  // county names and borders: fully visible at the opening view, gone by about zoom 11
  // detail: the public sees only control areas at first; surveillance zones and past areas appear as you zoom in
  // (transporters and officials always see everything)
  const fadeCounties = () => {
    const z = view.zoom, cl = (a, b) => Math.max(0, Math.min(1, (z - a) / (b - a)));
    countyLyr.opacity = 1 - cl(8, 11);
    const k = cl(9, 10.5);   // surveillance zones and past areas appear as you zoom in (all users)
    pubSZ.opacity = k; pubReleased.opacity = k;
  };
  view.watch("zoom", fadeCounties); view.when(fadeCounties);
  view.ui.add(new Expand({ view, expandIcon: "measure", expandTooltip: "Measure distance", content: new DistanceMeasurement2D({ view, unit: "kilometers" }) }), "top-left");

  // ---------------- Workspaces: the public needs no sign-in; two sign-in paths (MDA staff / haulers & industry) ----------------
  const WS_NAME = { regulator: "MDA staff", hauler: "Transporter", industry: "Poultry industry" };
  const STAFF_LAYERS = [farmsLyr, regBZ, regIZ, regCA, perim, premises, repLyr, perLyr];
  let ws = "public", roles = [], regAdded = false, signedUser = null;
  const isStaff = () => ws === "regulator";
  const canHaul = () => ws === "hauler" || ws === "regulator";
  const $ = (id) => document.getElementById(id);
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 5000); }

  function renderAcct(user) {
    const a = $("acct");
    if (!user) {
      a.innerHTML = `<button class="signin" id="signin">Sign in</button>`;
      $("signin").onclick = () => ($("modal").hidden = false);
      return;
    }
    const nm = user.fullName || user.username || "Signed in", ini = nm.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    const va = roles.length > 1 ? `<div class="vl">View as</div><div class="va">${roles.map((r) => `<button data-w="${r}" class="${r === ws ? "on" : ""}">${{ regulator: "MDA", hauler: "Hauler", industry: "Industry" }[r]}</button>`).join("")}</div>` : "";
    a.innerHTML = `<button class="me" id="me"><span class="ava">${esc(ini)}</span>${esc(WS_NAME[ws])}</button>
      <div class="menu" id="menu" hidden><div class="nm">${esc(nm)}</div><div class="em">${esc(user.email || user.username || "")}</div>${va}<button id="signout" style="margin-top:8px">Sign out</button></div>`;
    $("me").onclick = (e) => { e.stopPropagation(); $("menu").hidden = !$("menu").hidden; };
    $("menu").onclick = (e) => e.stopPropagation();
    $("menu").querySelectorAll(".va button").forEach((b) => (b.onclick = () => { setWorkspace(b.dataset.w); renderAcct(signedUser); $("menu").hidden = false; }));
    $("signout").onclick = () => { try { sessionStorage.removeItem("hpaiWs"); } catch (e) {} esriId.destroyCredentials(); location.href = location.pathname; };
  }
  document.addEventListener("click", () => { const m = $("menu"); if (m) m.hidden = true; });

  function nearMe() {
    if (!navigator.geolocation) return toast("Your browser can't share its location.");
    navigator.geolocation.getCurrentPosition((p) => {
      const pt = webMercatorUtils.geographicToWebMercator({ type: "point", x: p.coords.longitude, y: p.coords.latitude, spatialReference: { wkid: 4326 } });
      view.goTo({ target: pt, zoom: 11 }); checkLocation(pt, "My location");
    }, () => toast("Couldn't get your location. Search an address or tap the map."), { timeout: 10000 });
  }
  $("locBtn").onclick = nearMe;

  // transporter / industry: permit + report helpers
  function showAct(t) {
    ["permit", "report"].forEach((k) => ($("tool-" + k).hidden = k !== t));
    document.querySelectorAll(".act").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    pickMode = null; updatePickButtons();
  }
  document.querySelectorAll(".act").forEach((b) => (b.onclick = () => showAct(b.classList.contains("on") ? null : b.dataset.t)));

  // MDA staff: Detections / Permits / Premises
  function showPane(p) {
    document.querySelectorAll("#staffTabs button").forEach((b) => b.classList.toggle("on", b.dataset.p === p));
    ["rep", "per", "prem"].forEach((k) => ($("pane-" + k).hidden = k !== p));
    if (p === "rep") loadQueue("rep"); if (p === "per") loadQueue("per");
  }
  document.querySelectorAll("#staffTabs button").forEach((b) => (b.onclick = () => showPane(b.dataset.p)));

  // ---- floating layers + key widget on the map ----
  const sw = (cls) => `<span class="sw ${cls}"></span>`;
  const ico = (svg) => `<span class="ic">${svg}</span>`;
  const KEY = [
    { t: "Control area", n: "0–10 km", sw: sw("ca"), ls: [pubCA] },
    { t: "Surveillance zone", n: "10–20 km", sw: sw("sz"), ls: [pubSZ] },
    { t: "Past control area", n: "fades", sw: sw("rel"), ls: [pubReleased] },
    { t: "Wild bird, 4 weeks", sw: ico('<span class="dot" style="margin:0"></span>'), ls: [wild] },
    { t: "County names", sw: sw("cty"), ls: [countyLyr, tintLyr] },
    { staff: 1, sec: "MDA layers" },
    { staff: 1, t: "Infected zone", n: "0–3 km", sw: sw("iz"), ls: [regIZ] },
    { staff: 1, t: "Buffer zone", n: "3–10 km", sw: sw("bz"), ls: [regBZ] },
    { staff: 1, t: "Premises edge", sw: sw("pm"), ls: [perim] },
    { staff: 1, t: "Infected premises", sw: ico('<svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 2 22 12 12 22 2 12z" fill="#8c1414" stroke="#fff" stroke-width="2"/></svg>'), ls: [premises] },
    { staff: 1, t: "Detection reports", sw: ico('<svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 3 22 20H2z" fill="#e65a1e" stroke="#fff" stroke-width="2"/></svg>'), ls: [repLyr] },
    { staff: 1, t: "Permit requests", sw: ico('<svg width="14" height="14" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" fill="#1e6ebe" stroke="#fff" stroke-width="2"/></svg>'), ls: [perLyr] },
    { staff: 1, t: "Poultry farms", n: "estimated", sw: ico('<span class="dot farm" style="margin:0;width:10px;height:10px"></span>'), ls: [farmsLyr] }
  ];
  const keyEl = document.createElement("div"); keyEl.className = "mapkey" + (window.innerWidth < 900 ? " shut" : "");
  view.ui.add(keyEl, "top-right");
  function renderKey() {
    keyEl.innerHTML = `<button id="keyBtn">Layers &amp; key</button><div class="kb"></div>`;
    $("keyBtn").onclick = () => keyEl.classList.toggle("shut");
    const kb = keyEl.querySelector(".kb");
    KEY.filter((k) => !k.staff || isStaff()).forEach((k) => {
      if (k.sec) { kb.insertAdjacentHTML("beforeend", `<div class="sec">${k.sec}</div>`); return; }
      const lab = document.createElement("label");
      lab.innerHTML = `<input type="checkbox" ${k.ls[0].visible ? "checked" : ""}>${k.sw}<span>${k.t}</span>${k.n ? `<i>${k.n}</i>` : ""}`;
      lab.querySelector("input").onchange = (e) => k.ls.forEach((l) => (l.visible = e.target.checked));
      kb.appendChild(lab);
    });
  }

  function setWorkspace(w) {
    ws = w; pickMode = null; updatePickButtons(); marks.removeAll(); view.closePopup();
    document.body.dataset.ws = w;
    $("sec-route").hidden = w !== "hauler";
    $("sec-acts").hidden = !(w === "hauler" || w === "industry");
    $("sec-staff").hidden = w !== "regulator";
    showAct(null);
    routeLyr.visible = w === "hauler";
    if (isStaff() && !regAdded) {   // private layers are added only for MDA staff, so the public never hits a sign-in prompt
      regAdded = true;
      map.addMany(STAFF_LAYERS);
      map.reorder(routeLyr, map.layers.length - 1); map.reorder(marks, map.layers.length - 1);
      loadPremisesList();
    }
    STAFF_LAYERS.forEach((l) => { if (!isStaff()) l.visible = false; else if (l !== farmsLyr) l.visible = true; });
    renderKey(); fadeCounties();
    if (isStaff()) { refreshBadges(); showPane("rep"); }
  }

  async function initRole() {
    renderAcct(null); setWorkspace("public");
    $("mclose").onclick = () => ($("modal").hidden = true);
    $("modal").onclick = (e) => { if (e.target.id === "modal") $("modal").hidden = true; };
    $("reqAccess").href = "mailto:" + (C.accessEmail || "") + "?subject=" + encodeURIComponent("HPAI map access request");
    document.querySelectorAll(".role").forEach((b) => (b.onclick = () => {
      try { sessionStorage.setItem("hpaiWs", b.dataset.ws); } catch (e) {}
      esriId.getCredential(C.portalUrl + "/sharing");
    }));
    try {
      await esriId.checkSignInStatus(C.portalUrl + "/sharing");
      const portal = new Portal({ url: C.portalUrl }); await portal.load();
      const user = portal.user, groups = await user.fetchGroups();
      const names = groups.map((g) => g.title.toLowerCase());
      const isReg = names.includes((C.regulatorGroup || "").toLowerCase()), isHaul = names.includes((C.haulerGroup || "").toLowerCase());
      roles = isReg ? ["regulator", "hauler", "industry"] : isHaul ? ["hauler"] : ["industry"];
      signedUser = user;
      let want = null; try { want = sessionStorage.getItem("hpaiWs"); sessionStorage.removeItem("hpaiWs"); } catch (e) {}
      const as = new URLSearchParams(location.search).get("as");   // preview, e.g. ?as=hauler or ?as=public
      if (as === "public") { signedUser = null; roles = []; renderAcct(null); setWorkspace("public"); return; }
      let pick = roles[0];
      if (roles.includes(as)) pick = as;
      else if (want === "regulator" && !isReg) toast("This account isn't set up as MDA staff. Opened the partner view.");
      else if (want === "partner") pick = isHaul || isReg ? "hauler" : "industry";
      setWorkspace(pick); renderAcct(user);
    } catch (e) { renderAcct(null); setWorkspace("public"); }
  }

  // ---------------- Zone lookup ----------------
  async function zonesAt(geom) {
    const r = await zonesQ.queryFeatures({ geometry: geom, spatialRelationship: "intersects", where: "1=1", outFields: ["zone_type", "status", "confirmed_date", "released_date"], returnGeometry: false });
    return r.features.map((f) => f.attributes);
  }
  function designation(z) {
    const act = z.filter((a) => a.status === "Active");
    if (act.some((a) => a.zone_type === "Control Area")) return "Control Area";
    if (act.some((a) => a.zone_type === "Surveillance Zone")) return "Surveillance Zone";
    return "Free Area";
  }
  const label = (pt) => { const g = webMercatorUtils.webMercatorToGeographic(pt); return `${g.y.toFixed(5)}, ${g.x.toFixed(5)}`; };

  function mark(pt, color, text) {
    marks.add(new Graphic({ geometry: pt, symbol: { type: "simple-marker", style: "circle", size: 12, color, outline: { color: "white", width: 2 } }, attributes: { text } }));
  }

  // ---------------- PUBLIC ----------------
  let lastCheck = null;
  const mdSources = (ph) => [{ url: "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer", name: "Maryland addresses", placeholder: ph, countryCode: "US", singleLineFieldName: "SingleLine", outFields: ["*"], maxResults: 6, filter: { geometry: { type: "extent", xmin: -79.6, ymin: 37.85, xmax: -74.95, ymax: 39.75, spatialReference: { wkid: 4326 } } }, suggestionsEnabled: true }];
  const pubSearch = new Search({ view, container: "pubSearch", popupEnabled: false, resultGraphicEnabled: false, locationEnabled: false, includeDefaultSources: false, sources: mdSources("Find a Maryland address or place") });
  pubSearch.on("select-result", (e) => e.result && checkLocation(e.result.feature.geometry, e.result.name));

  // radius slider ("show results within N km"), like the Pennsylvania checker
  let radius = 0;
  document.querySelectorAll("#radSeg button").forEach((b) => (b.onclick = () => {
    radius = +b.dataset.r; document.querySelectorAll("#radSeg button").forEach((x) => x.classList.toggle("on", x === b));
    if (lastCheck) checkLocation(lastCheck.pt, lastCheck.name);
  }));

  const haversineKm = (a, b) => {
    const A = webMercatorUtils.webMercatorToGeographic(a), B = webMercatorUtils.webMercatorToGeographic(b), R = 6371.0088, rad = Math.PI / 180;
    const dLat = (B.y - A.y) * rad, dLon = (B.x - A.x) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(A.y * rad) * Math.cos(B.y * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const ICON = {
    ca: '<svg viewBox="0 0 24 24"><path d="M12 2.5 4 6v6c0 5 3.4 8.5 8 9.5 4.6-1 8-4.5 8-9.500V6z"/><path d="M12 8v5M12 16v.5"/></svg>',
    sz: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.500S22 12 22 12s-3.6 6.5-10 6.500S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    free: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.5 3 3 6-6.5"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.5"/></svg>',
    bird: '<svg viewBox="0 0 24 24"><path d="M3 15c3-1 4-4 6-6 2.5-2.5 6-2 7.5 0L21 8l-1.500 3.500c0 5-4 8.5-9 8.5-3 0-5-1.500-7.5-5z"/><circle cx="15.5" cy="10" r=".8"/></svg>'
  };
  function showPop(pt, cls, big, sub, body) {
    const el = document.createElement("div");
    el.className = "pop " + cls;
    el.innerHTML = `<div class="banner">${ICON[cls]}<div><div class="big">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div></div>${body || ""}`;
    view.openPopup({ location: pt, title: " ", content: el });
    const sp = view.toScreen(pt); if (sp && sp.y < 360) view.goTo({ center: pt }, { duration: 350 }).catch(() => {});   // keep the card on screen
  }
  function showWildPop(f, pt) {
    const a = f.attributes, d = a.last_detected || a.collection_date;
    showPop(pt, "bird", "HPAI in a wild bird", esc(a.species || "Species not listed"),
      `<div class="rows"><div class="row2">Detected<span>${fmtDate(d)}</span></div><div class="row2">County<span>${esc(a.county || "")}</span></div></div><div class="meta">USDA APHIS · shown at county level, not the exact site</div>`);
  }
  async function checkLocation(pt, name) {
    if (mdGeom && !inMD(pt)) return;   // outside Maryland: nothing happens
    lastCheck = { pt, name };
    marks.removeAll(); mark(pt, [23, 50, 77, 1]);
    showPop(pt, "info", "Checking…", "");
    await mdReady;
    if (!inMD(pt)) { view.closePopup(); marks.removeAll(); return; }
    let ring = null;
    if (radius > 0) {
      ring = geometryEngine.geodesicBuffer(pt, radius, "kilometers");
      marks.add(new Graphic({ geometry: ring, symbol: { type: "simple-fill", color: [23, 50, 77, 0.04], outline: { color: [23, 50, 77, 0.9], width: 1, style: "dash" } } }));
    }
    try {
      const [z, zr, prem] = await Promise.all([
        zonesAt(pt),
        ring ? zonesAt(ring) : Promise.resolve(null),
        canHaul() ? premises.queryFeatures({ where: "status = 'Active'", outFields: ["premises_id"], returnGeometry: true, outSpatialReference: view.spatialReference }).catch(() => null) : Promise.resolve(null)
      ]);
      const wr = geometryEngine.geodesicBuffer(pt, radius || 10, "kilometers");
      const wildN = await wild.queryFeatureCount({ geometry: wr, spatialRelationship: "intersects" }).catch(() => 0);
      const d = designation(z);
      const act = z.filter((a) => a.status === "Active" && a.zone_type === d);
      const inIZ = z.some((a) => a.status === "Active" && a.zone_type === "Infected Zone");
      const since = act.length ? fmtDate(Math.min(...act.map((a) => a.confirmed_date))) : "";
      const rel = z.filter((a) => a.status === "Released" && a.zone_type === "Control Area").sort((a, b) => b.released_date - a.released_date)[0];
      const dists = prem ? prem.features.map((f) => haversineKm(pt, f.geometry)) : [];
      const nearest = dists.length ? Math.min(...dists) : null;
      const inCA = d === "Control Area", inSZ = z.some((a) => a.status === "Active" && a.zone_type === "Surveillance Zone");
      let cls, big, sub;
      if (inCA) { cls = "ca"; big = "Control Area"; sub = inIZ ? "Infected Zone · call MDA first" : "Movement permit required"; }
      else if (inSZ) { cls = "sz"; big = "Surveillance Zone"; sub = "No permit · flocks may be tested"; }
      else { cls = "free"; big = "Outside all zones"; sub = "No HPAI limits here"; }
      let body = `<div class="rows"><div class="row2">Control Area<span class="yn ${inCA ? "y" : ""}">${inCA ? "YES" : "No"}</span></div><div class="row2">Surveillance Zone<span class="yn ${inSZ ? "s" : ""}">${inSZ ? "YES" : "No"}</span></div>`;
      if (nearest != null) body += `<div class="row2">Nearest premises<span>${nearest.toFixed(1)} km</span></div>`;
      if (ring) {
        const n = dists.filter((k) => k <= radius).length;
        const ca = zr.some((a) => a.status === "Active" && a.zone_type === "Control Area");
        const sz = zr.some((a) => a.status === "Active" && a.zone_type === "Surveillance Zone");
        body += `<div class="row2">Within ${radius} km<span>${ca ? "control area" : sz ? "surveillance" : "clear"}${prem ? " · " + n + " premises" : ""}</span></div>`;
      }
      if (isStaff()) { const fN = await farmsLyr.queryFeatureCount({ geometry: wr, spatialRelationship: "intersects" }).catch(() => 0); if (fN) body += `<div class="row2">Poultry farms<span>~${fN} within ${radius || 10} km</span></div>`; }
      if (wildN) body += `<div class="row2">Wild birds<span>${wildN} within ${radius || 10} km</span></div>`;
      body += `</div>`;
      if (rel) body += `<div class="note">Past control area, released ${fmtDate(rel.released_date)}</div>`;
      if (inCA && (ws === "hauler" || ws === "industry") && C.permitFormUrl && !C.permitFormUrl.startsWith("REPLACE")) {
        const g = webMercatorUtils.webMercatorToGeographic(pt);
        body += `<a class="cta red" target="_blank" rel="noopener" href="${C.permitFormUrl}?center=${g.y.toFixed(6)},${g.x.toFixed(6)}&field:origin=${encodeURIComponent(name || label(pt))}">Request a permit</a>`;
      }
      if (inCA || inSZ) body += `<div class="meta">Since ${since} · ${esc(name || label(pt))}</div>`; else body += `<div class="meta">${esc(name || label(pt))}</div>`;
      showPop(pt, cls, big, sub, body);
    } catch (err) {
      showPop(pt, "info", "Couldn't check", esc(err.message));
    }
  }

  // data last-updated stamp (like Pennsylvania's "updated daily" note)
  zonesQ.load().then(() => {
    const d = zonesQ.editingInfo && zonesQ.editingInfo.lastEditDate;
    document.getElementById("updated").textContent = d ? "Updated " + new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";
  }).catch(() => {});

  // ---------------- HAULER ----------------
  const stops = { org: null, dst: null };
  const orgSearch = new Search({ view, container: "orgSearch", popupEnabled: false, resultGraphicEnabled: false, locationEnabled: false, includeDefaultSources: false, sources: mdSources("Origin in Maryland") });
  const dstSearch = new Search({ view, container: "dstSearch", popupEnabled: false, resultGraphicEnabled: false, locationEnabled: false, includeDefaultSources: false, sources: mdSources("Destination in Maryland") });
  orgSearch.on("select-result", (e) => { if (e.result) { stops.org = { pt: e.result.feature.geometry, name: e.result.name }; drawStops(); } });
  dstSearch.on("select-result", (e) => { if (e.result) { stops.dst = { pt: e.result.feature.geometry, name: e.result.name }; drawStops(); } });
  let pickMode = null;
  function updatePickButtons() {
    document.getElementById("pickOrg").classList.toggle("active", pickMode === "org");
    document.getElementById("pickDst").classList.toggle("active", pickMode === "dst");
    document.getElementById("pickRep").classList.toggle("active", pickMode === "rep");
    document.getElementById("pickPerm").classList.toggle("active", pickMode === "perm");
  }
  document.getElementById("pickOrg").onclick = () => { pickMode = pickMode === "org" ? null : "org"; updatePickButtons(); };
  document.getElementById("pickDst").onclick = () => { pickMode = pickMode === "dst" ? null : "dst"; updatePickButtons(); };
  document.getElementById("pickPerm").onclick = () => { pickMode = pickMode === "perm" ? null : "perm"; updatePickButtons(); };
  function setPermit(pt) {
    if (!inMD(pt)) { toast("Pick a location inside Maryland."); return; }
    marks.removeAll(); mark(pt, [217, 130, 43, 1]);
    const g = webMercatorUtils.webMercatorToGeographic(pt);
    const q = new URLSearchParams({ center: `${g.y.toFixed(6)},${g.x.toFixed(6)}`, "field:origin": label(pt) });
    $("permLoc").textContent = `Marked: ${label(pt)}`;
    const a = $("permLink");
    if (C.permitFormUrl && !C.permitFormUrl.startsWith("REPLACE")) { a.href = `${C.permitFormUrl}?${q}`; a.hidden = false; } else a.hidden = true;
  }
  document.getElementById("pickRep").onclick = () => { pickMode = pickMode === "rep" ? null : "rep"; updatePickButtons(); };
  function setReport(pt) {
    if (!inMD(pt)) { toast("Pick a location inside Maryland."); return; }
    marks.removeAll(); mark(pt, [180, 35, 24, 1]);
    const g = webMercatorUtils.webMercatorToGeographic(pt);
    const q = new URLSearchParams({ center: `${g.y.toFixed(6)},${g.x.toFixed(6)}` });
    if (signedUser && signedUser.fullName) q.set("field:reporter_name", signedUser.fullName);
    if (signedUser && signedUser.email) q.set("field:email", signedUser.email);
    document.getElementById("repLoc").textContent = `Marked: ${label(pt)}`;
    const a = document.getElementById("repLink");
    if (C.reportFormUrl && !C.reportFormUrl.startsWith("REPLACE")) { a.href = `${C.reportFormUrl}?${q.toString()}`; a.hidden = false; }
    else { a.hidden = true; document.getElementById("repLoc").textContent += ". The report form is not set up yet."; }
  }
  function drawStops() {
    marks.removeAll();
    if (stops.org) mark(stops.org.pt, [23, 120, 60, 1]);
    if (stops.dst) mark(stops.dst.pt, [23, 50, 120, 1]);
  }
  document.getElementById("clearRoute").onclick = () => {
    stops.org = stops.dst = null; orgSearch.clear(); dstSearch.clear(); marks.removeAll(); routeLyr.removeAll();
    const b = document.getElementById("routeResult"); b.innerHTML = "";
  };

  let travelModePromise = null;
  function truckMode() {
    if (!travelModePromise) {
      travelModePromise = networkService.fetchServiceDescription(C.routeUrl).then((d) =>
        (d.supportedTravelModes || []).find((m) => /trucking time/i.test(m.name)) || null).catch(() => null);
    }
    return travelModePromise;
  }

  async function activePolys(zoneType) {
    const r = await zonesQ.queryFeatures({ where: `zone_type = '${zoneType}' AND status = 'Active'`, outFields: ["confirmed_date"], returnGeometry: true, outSpatialReference: view.spatialReference });
    return r.features.map((f) => f.geometry);
  }
  const kmIn = (line, area) => { if (!area) return 0; const i = geometryEngine.intersect(line, area); return i ? geometryEngine.geodesicLength(i, "kilometers") : 0; };

  async function solveBetween(from, to, barriers, mode, dirs) {
    const p = new RouteParameters({
      stops: new FeatureSet({ features: [new Graphic({ geometry: from, attributes: { Name: "Origin" } }), new Graphic({ geometry: to, attributes: { Name: "Destination" } })] }),
      returnDirections: !!dirs, directionsLengthUnits: "kilometers", returnRoutes: true, outSpatialReference: view.spatialReference
    });
    if (mode) p.travelMode = mode;
    if (barriers.length) p.polygonBarriers = new FeatureSet({ features: barriers.map((g) => new Graphic({ geometry: g, attributes: { BarrierType: 0, Name: "Active control area" } })) });
    const res = await route.solve(C.routeUrl, p);
    const rr = res.routeResults[0], g = rr.route, a = g.attributes;
    const minutes = a.Total_TravelTime ?? a.Total_Minutes ?? a.Total_TruckMinutes ?? null;
    const steps = dirs && rr.directions ? rr.directions.features.map((f) => ({ text: f.attributes.text, km: f.attributes.length })) : null;
    return { geom: g.geometry, km: geometryEngine.geodesicLength(g.geometry, "kilometers"), minutes, steps };
  }
  const solve = (barriers, mode, dirs) => solveBetween(stops.org.pt, stops.dst.pt, barriers, mode, dirs);

  // road distance from a stop to the nearest active infected premises (checks the 3 closest in a straight line)
  async function roadToNearest(pt, mode) {
    const act = (await premises.queryFeatures({ where: "status = 'Active'", returnGeometry: true, outSpatialReference: view.spatialReference })).features;
    if (!act.length) return null;
    const cand = act.map((f) => ({ g: f.geometry, d: haversineKm(pt, f.geometry) })).sort((x, y) => x.d - y.d).slice(0, 3);
    const res = await Promise.all(cand.map(async (cd) => { try { const r = await solveBetween(pt, cd.g, [], mode, false); return { km: r.km, min: r.minutes, straight: cd.d }; } catch (e) { return null; } }));
    return res.filter(Boolean).sort((x, y) => x.km - y.km)[0] || { km: null, straight: cand[0].d };
  }
  const roadLine = (who, r) => !r ? "" : `<li>${who}: nearest infected premises <b>${r.km != null ? r.km.toFixed(1) + " km by road" + (r.min != null ? " (" + Math.round(r.min) + " min)" : "") : "no road route"}</b>, ${r.straight.toFixed(1)} km straight-line</li>`;

  document.getElementById("routeBtn").onclick = async () => {
    const box = document.getElementById("routeResult");
    if (stops.org && stops.dst && (!inMD(stops.org.pt) || !inMD(stops.dst.pt))) { box.className = "result"; box.innerHTML = `<div class="res info"><p>Origin and destination must both be in Maryland.</p></div>`; return; }
    if (!stops.org || !stops.dst) { box.className = "result"; box.innerHTML = `<div class="res info"><p>Set both an origin and a destination.</p></div>`; return; }
    box.className = "result"; box.innerHTML = `<div class="res info"><p>Planning route…</p></div>`; routeLyr.removeAll();
    try {
      const [ca, sz, mode] = await Promise.all([activePolys("Control Area"), activePolys("Surveillance Zone"), truckMode()]);
      const caUnion = ca.length ? geometryEngine.union(ca) : null;
      const szOnly = sz.length ? (caUnion ? geometryEngine.difference(geometryEngine.union(sz), caUnion) : geometryEngine.union(sz)) : null;
      const orgIn = caUnion && geometryEngine.contains(caUnion, stops.org.pt);
      const dstIn = caUnion && geometryEngine.contains(caUnion, stops.dst.pt);
      // Barriers = active control areas that do not contain the origin or destination
      const barriers = ca.filter((g) => !geometryEngine.contains(g, stops.org.pt) && !geometryEngine.contains(g, stops.dst.pt));
      let r, avoided = true;
      try { r = await solve(barriers, mode, true); } catch (e) { avoided = false; r = await solve([], mode, true); }
      const caKm = kmIn(r.geom, caUnion), szKm = kmIn(r.geom, szOnly);
      const [roadO, roadD] = await Promise.all([roadToNearest(stops.org.pt, mode).catch(() => null), roadToNearest(stops.dst.pt, mode).catch(() => null)]);
      let direct = null;
      if (barriers.length) { try { direct = await solve([], mode); } catch (e) { direct = null; } }

      routeLyr.add(new Graphic({ geometry: r.geom, symbol: { type: "simple-line", color: [23, 50, 77, 0.9], width: 5 } }));
      if (direct && Math.abs(direct.km - r.km) > 0.5) routeLyr.add(new Graphic({ geometry: direct.geom, symbol: { type: "simple-line", color: [180, 35, 24, 0.7], width: 2.5, style: "dash" } }));
      view.goTo(r.geom.extent.clone().expand(1.3));

      const permit = orgIn || dstIn || caKm > 0.05;
      const reasons = [];
      if (orgIn) reasons.push("origin is inside a control area");
      if (dstIn) reasons.push("destination is inside a control area");
      if (caKm > 0.05) reasons.push(`route passes ${caKm.toFixed(1)} km through a control area`);
      const mins = r.minutes != null ? `${Math.round(r.minutes)} min` : "";
      let html = `<div class="big">${permit ? "Permit required" : "No permit needed"}</div>`;
      html += `<p><b>${r.km.toFixed(1)} km</b>${mins ? ", about " + mins : ""}${mode ? " (truck routing)" : ""}.</p><ul>`;
      html += `<li>In control areas: <b>${caKm.toFixed(1)} km</b></li>`;
      if (direct && Math.abs(direct.km - r.km) > 0.5) html += `<li>Detour around control areas: +${(r.km - direct.km).toFixed(1)} km (red dashed = direct)</li>`;
      if (!avoided) html += `<li>No road avoids every control area.</li>`;
      html += roadLine("Origin", roadO) + roadLine("Destination", roadD);
      html += `</ul>`;
      if (r.steps && r.steps.length) html += `<details class="dirs"><summary>Turn-by-turn directions</summary><ol>${r.steps.map((d) => `<li>${esc(d.text)}${d.km > 0.05 ? " (" + d.km.toFixed(1) + " km)" : ""}</li>`).join("")}</ol></details>`;
      if (permit) {
        html += `<p>${reasons.join("; ")}.</p>`;
        if (C.permitFormUrl && !C.permitFormUrl.startsWith("REPLACE")) {
          const q = new URLSearchParams({
            "field:origin": stops.org.name || label(stops.org.pt), "field:destination": stops.dst.name || label(stops.dst.pt),
            "field:commodity": document.getElementById("commodity").value, "field:route_km": r.km.toFixed(1),
            "field:ca_km": caKm.toFixed(1), "field:permit_reason": reasons.join("; ")
          });
          const og = webMercatorUtils.webMercatorToGeographic(stops.org.pt);
          q.set("center", `${og.y.toFixed(6)},${og.x.toFixed(6)}`); // places the request point at the origin
          html += `<a class="cta red" target="_blank" rel="noopener" href="${C.permitFormUrl}?${q.toString()}">Request a movement permit</a>`;
        } else html += `<p><i>Permit request form not configured yet.</i></p>`;
      }
      box.className = "result"; box.innerHTML = `<div class="res ${permit ? "ca" : "free"}">${html}</div>`;
    } catch (err) {
      box.className = "result"; box.innerHTML = `<div class="res info"><p>Couldn't plan the route: ${esc(err.message)}</p></div>`;
    }
  };

  // ---------------- REGULATOR ----------------
  // ---- Officials: review queues ----
  const pendingWhere = (kind) => kind === "rep" ? "review_status IS NULL OR review_status = 'New'" : "review_status IS NULL OR review_status = 'Pending'";
  async function refreshBadges() {
    for (const [kind, lyr] of [["rep", repLyr], ["per", perLyr]]) {
      const n = await lyr.queryFeatureCount({ where: pendingWhere(kind) }).catch(() => 0);
      const bd = document.querySelector(`#staffTabs button[data-p="${kind}"] .badge`);
      bd.textContent = n; bd.hidden = !n;
    }
  }
  async function loadQueue(kind) {
    const lyr = kind === "rep" ? repLyr : perLyr, box = $(kind === "rep" ? "repQueue" : "perQueue");
    box.innerHTML = `<p class="hint">Loading…</p>`;
    const done = kind === "rep" ? ["Confirmed", "Dismissed"] : ["Approved", "Denied"];
    const yes = kind === "rep" ? ["Confirm", "Confirmed"] : ["Approve", "Approved"], no = kind === "rep" ? ["Dismiss", "Dismissed"] : ["Deny", "Denied"];
    try {
      const r = await lyr.queryFeatures({ where: "1=1", outFields: ["*"], returnGeometry: true, outSpatialReference: view.spatialReference });
      const rows = r.features.map((f) => ({ f, st: f.attributes.review_status || (kind === "rep" ? "New" : "Pending") })).sort((a, b) => (done.includes(a.st) - done.includes(b.st)) || (b.f.attributes.OBJECTID - a.f.attributes.OBJECTID));
      if (!rows.length) { box.innerHTML = `<p class="hint">Nothing submitted yet.</p>`; return; }
      box.innerHTML = rows.map(({ f, st }, i) => {
        const a = f.attributes, pend = !done.includes(st);
        const head = kind === "rep" ? esc(a.species || "Report") : esc(a.company || "Permit request");
        const l1 = kind === "rep" ? `${(a.sick_dead ?? "?").toLocaleString()} sick/dead of ${(a.flock_size ?? "?").toLocaleString()}${a.onset_date ? " · onset " + fmtDate(a.onset_date) : ""}` : `${esc(a.commodity || "")} · ${esc(a.origin || "?")} → ${esc(a.destination || "?")}`;
        const l2 = kind === "rep" ? esc(a.premises_address || "") + (a.symptoms ? "<br>" + esc(a.symptoms) : "") : `${a.route_km != null ? a.route_km + " km" : ""}${a.ca_km ? ", " + a.ca_km + " km in control area" : ""}${a.move_date ? " · " + fmtDate(a.move_date) : ""}<br>${esc(a.permit_reason || "")}`;
        const who = kind === "rep" ? `${esc(a.reporter_name || "")} ${esc(a.phone || "")}` : `${esc(a.contact_name || "")} ${esc(a.phone || "")}`;
        return `<div class="qi ${pend ? "" : "done"}" data-i="${i}"><div class="qh"><b>${head}</b><span class="tag ${pend ? "Active" : "Released"}">${esc(st)}</span></div><div class="q1">${l1}</div><div class="q2">${l2}</div><div class="q3">${who}</div>
          <div class="qa"><button data-a="loc">Locate</button>${pend ? `<button class="ok" data-a="yes">${yes[0]}</button><button class="no" data-a="no">${no[0]}</button>` : ""}</div></div>`;
      }).join("");
      box.querySelectorAll(".qi").forEach((el) => el.querySelectorAll("button").forEach((btn) => btn.onclick = async () => {
        const { f } = rows[+el.dataset.i], act = btn.dataset.a;
        if (act === "loc") { view.goTo({ target: f.geometry, zoom: 12 }); view.openPopup({ features: [f], location: f.geometry }); return; }
        btn.disabled = true;
        try {
          const res = await lyr.applyEdits({ updateFeatures: [{ attributes: { OBJECTID: f.attributes.OBJECTID, review_status: act === "yes" ? yes[1] : no[1] } }] });
          if (res.updateFeatureResults[0].error) throw new Error(res.updateFeatureResults[0].error.message);
          toast(`${act === "yes" ? yes[1] : no[1]}`); lyr.refresh(); loadQueue(kind); refreshBadges();
        } catch (err) { btn.disabled = false; toast("Couldn't save: " + err.message); }
      }));
    } catch (err) { box.innerHTML = `<p class="hint">Couldn't load: ${esc(err.message)}</p>`; }
  }

  // ---- Active control areas list (transporters, industry, officials) ----
  function renderAreas() {
    const html = outbreakAreas.length ? outbreakAreas.map((a, i) => `<button class="area" data-i="${i}"><b>${esc(a.county)}</b><span>since ${fmtDate(a.since)}</span></button>`).join("") : `<p class="hint">No active control areas.</p>`;
    document.querySelectorAll(".areaList").forEach((el) => {
      el.innerHTML = html;
      el.querySelectorAll(".area").forEach((b) => (b.onclick = () => view.goTo(outbreakAreas[+b.dataset.i].ext.clone().expand(2.2))));
    });
  }
  async function loadPremisesList() {
    const div = document.getElementById("premList");
    try {
      const r = await premises.queryFeatures({ where: "1=1", outFields: ["*"], returnGeometry: true, orderByFields: ["status ASC", "confirmed_date DESC"] });
      div.innerHTML = r.features.map((f, i) => { const a = f.attributes; return `<div class="prem" data-i="${i}"><b>${esc(a.premises_id)}</b><span class="tag ${a.status}">${a.status}</span><br>${esc(a.county)} Co. · ${esc(a.flock_type)} · ${(a.birds || 0).toLocaleString()} birds<br>Confirmed ${fmtDate(a.confirmed_date)}${a.released_date ? " · Released " + fmtDate(a.released_date) : ""}</div>`; }).join("");
      div.querySelectorAll(".prem").forEach((el) => el.onclick = () => { const f = r.features[+el.dataset.i]; view.goTo({ target: f.geometry, zoom: 11 }); view.openPopup({ features: [f], location: f.geometry }); });
    } catch (err) { div.innerHTML = "Could not load premises: " + esc(err.message); }
    const links = [];
    if (C.permitResultsUrl) links.push(`<a href="${C.permitResultsUrl}" target="_blank" rel="noopener">Permit requests</a>`);
    if (C.reportResultsUrl) links.push(`<a href="${C.reportResultsUrl}" target="_blank" rel="noopener">Outbreak reports</a>`);
    document.getElementById("permitAdmin").innerHTML = links.join(" &nbsp; ");
  }

  // ---------------- Map clicks ----------------
  view.on("click", async (e) => {
    if (pickMode === "perm") { setPermit(e.mapPoint); pickMode = null; updatePickButtons(); e.stopPropagation(); return; }
    if (pickMode === "rep") { setReport(e.mapPoint); pickMode = null; updatePickButtons(); e.stopPropagation(); return; }
    if (pickMode === "org" || pickMode === "dst") {
      stops[pickMode] = { pt: e.mapPoint, name: label(e.mapPoint) };
      (pickMode === "org" ? orgSearch : dstSearch).searchTerm = label(e.mapPoint);
      pickMode = null; updatePickButtons(); drawStops(); e.stopPropagation(); return;
    }
    const inc = [wild].concat(isStaff() ? [premises, perim, repLyr, perLyr, farmsLyr] : []);
    const hit = await view.hitTest(e, { include: inc }).catch(() => null);
    const g = hit && hit.results.find((r) => r.graphic && r.graphic.layer);
    if (g && g.graphic.layer === wild) { showWildPop(g.graphic, g.graphic.geometry); return; }
    if (g) { view.openPopup({ features: [g.graphic], location: e.mapPoint }); return; }
    checkLocation(e.mapPoint);
  });

  initRole();
});
