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
    definitionExpression: `last_detected >= DATE '${wildCutoff}'`,
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

  // Query-only handle on all zones (never drawn)
  const zonesQ = new FeatureLayer({ url: PZ, outFields: ["zone_type", "status", "confirmed_date", "released_date"] });

  const marks = new GraphicsLayer({ title: "Selected locations", listMode: "hide" });
  const routeLyr = new GraphicsLayer({ title: "Route", listMode: "hide" });

  const map = new Map({ basemap: "topo-vector", layers: [pubSZ, pubReleased, pubCA, wild, routeLyr, marks] });
  const view = new MapView({ container: "viewDiv", map, center: C.center, zoom: C.zoom, popup: { dockEnabled: false } });
  view.ui.add(new Home({ view }), "top-left");
  view.ui.add(new Expand({ view, expandIcon: "measure", expandTooltip: "Measure distance", content: new DistanceMeasurement2D({ view, unit: "kilometers" }) }), "top-left");

  // ---------------- Roles: signing in decides what is shown; the public needs no sign-in ----------------
  const RANK = { public: 0, member: 1, hauler: 2, regulator: 3 };
  let role = "public", layerList = null, regAdded = false, signedUser = null;
  const can = (r) => RANK[role] >= RANK[r];
  function applyRole(r, user) {
    role = r; signedUser = user || null;
    document.getElementById("s-report").hidden = !can("member");
    document.getElementById("s-hauler").hidden = !can("hauler");
    document.getElementById("s-reg").hidden = !can("regulator");
    routeLyr.visible = can("hauler");
    view.popupEnabled = can("regulator");
    const who = document.getElementById("who");
    who.innerHTML = user ? `${esc(user.fullName || user.username)} · ${{ member: "signed in", hauler: "hauler", regulator: "regulator" }[r]} · <a href="#" id="signout">Sign out</a>` : `<a href="#" id="signin">Staff sign in</a>`;
    const so = document.getElementById("signout");
    if (so) so.onclick = (e) => { e.preventDefault(); esriId.destroyCredentials(); location.href = location.pathname; };
    const si = document.getElementById("signin");
    if (si) si.onclick = (e) => { e.preventDefault(); esriId.getCredential(C.portalUrl + "/sharing"); };
    if (can("regulator") && !regAdded) {   // private layers are added only for regulators, so the public never hits a sign-in prompt
      regAdded = true;
      map.addMany([regBZ, regIZ, regCA, perim, premises]);
      map.reorder(routeLyr, map.layers.length - 1); map.reorder(marks, map.layers.length - 1);
      layerList = new LayerList({ view, container: "layerListDiv" }); loadPremisesList();
    }
  }
  async function initRole() {
    try {
      await esriId.checkSignInStatus(C.portalUrl + "/sharing");
      const portal = new Portal({ url: C.portalUrl }); await portal.load();
      const user = portal.user, groups = await user.fetchGroups();
      const names = groups.map((g) => g.title.toLowerCase());
      let r = "member";
      if (names.includes((C.haulerGroup || "").toLowerCase())) r = "hauler";
      if (names.includes((C.regulatorGroup || "").toLowerCase())) r = "regulator";
      const as = new URLSearchParams(location.search).get("as");   // preview a lower role, e.g. ?as=hauler
      if (as && RANK[as] !== undefined && RANK[as] < RANK[r]) r = as;
      if (r === "public") applyRole("public"); else applyRole(r, user);
    } catch (e) { applyRole("public"); }
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
  const pubSearch = new Search({ view, container: "pubSearch", popupEnabled: false, resultGraphicEnabled: false, locationEnabled: false });
  pubSearch.on("select-result", (e) => e.result && checkLocation(e.result.feature.geometry, e.result.name));

  // radius slider ("show results within N km"), like the Pennsylvania checker
  const radiusEl = document.getElementById("radius"), radVal = document.getElementById("radVal");
  let lastCheck = null;
  radiusEl.oninput = () => { radVal.textContent = radiusEl.value; };
  radiusEl.onchange = () => { if (lastCheck) checkLocation(lastCheck.pt, lastCheck.name); };

  const haversineKm = (a, b) => {
    const A = webMercatorUtils.webMercatorToGeographic(a), B = webMercatorUtils.webMercatorToGeographic(b), R = 6371.0088, rad = Math.PI / 180;
    const dLat = (B.y - A.y) * rad, dLon = (B.x - A.x) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(A.y * rad) * Math.cos(B.y * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  async function checkLocation(pt, name) {
    lastCheck = { pt, name };
    const box = document.getElementById("pubResult");
    const radius = +radiusEl.value;
    box.className = "result show r-info"; box.innerHTML = "Checking…";
    marks.removeAll(); mark(pt, [23, 50, 77, 1]);
    let ring = null;
    if (radius > 0) {
      ring = geometryEngine.geodesicBuffer(pt, radius, "kilometers");
      marks.add(new Graphic({ geometry: ring, symbol: { type: "simple-fill", color: [23, 50, 77, 0.04], outline: { color: [23, 50, 77, 0.9], width: 1, style: "dash" } } }));
    }
    try {
      const [z, zr, prem] = await Promise.all([
        zonesAt(pt),
        ring ? zonesAt(ring) : Promise.resolve(null),
        can("hauler") ? premises.queryFeatures({ where: "status = 'Active'", outFields: ["premises_id"], returnGeometry: true, outSpatialReference: view.spatialReference }).catch(() => ({ features: [] })) : Promise.resolve({ features: [] })
      ]);
      const d = designation(z);
      const act = z.filter((a) => a.status === "Active" && a.zone_type === d);
      const inIZ = z.some((a) => a.status === "Active" && a.zone_type === "Infected Zone");
      const since = act.length ? fmtDate(Math.min(...act.map((a) => a.confirmed_date))) : "";
      const rel = z.filter((a) => a.status === "Released" && a.zone_type === "Control Area").sort((a, b) => b.released_date - a.released_date)[0];
      const dists = prem.features.map((f) => haversineKm(pt, f.geometry));
      const nearest = dists.length ? Math.min(...dists) : null;
      const inCA = d === "Control Area", inSZ = z.some((a) => a.status === "Active" && a.zone_type === "Surveillance Zone");
      let html = `<div class="chips"><span class="chip ${inCA ? "yes" : "no"}">Control Area: ${inCA ? "YES" : "No"}</span><span class="chip ${inSZ ? "ysz" : "no"}">Surveillance Zone: ${inSZ ? "YES" : "No"}</span></div>`;
      if (d === "Control Area") {
        box.className = "result show r-ca";
        html += `<div class="big">Inside an HPAI Control Area</div><p>In place since ${since}.</p><ul>`
          + (inIZ ? `<li><b>Infected Zone</b> (within 3 km of an infected premises): the strictest limits apply. Call MDA before any movement.</li>` : `<li>Buffer Zone (3–10 km from an infected premises).</li>`)
          + `<li>Moving poultry, eggs, feed, litter, carcasses or service vehicles onto or off a premises here requires an <b>MDA movement permit</b>.</li><li>Flocks here are under surveillance testing. Follow enhanced biosecurity.</li><li>Haulers: use the <b>Haulers &amp; industry</b> tab to plan a route and request a permit.</li></ul>`;
      } else if (d === "Surveillance Zone") {
        box.className = "result show r-sz";
        html += `<div class="big">Inside an HPAI Surveillance Zone</div><p>10–20 km from an infected premises, outside the control area. Since ${since}.</p><ul><li>No movement permit is required, but commercial flocks may be tested.</li><li>Watch flocks closely and report sick or dead birds to MDA immediately.</li><li>Check with MDA before moving birds; zones can expand.</li></ul><p>Help close the outbreak: tell MDA your birds are healthy or report sick birds at <b>(410) 841-5810</b>.</p>`;
      } else {
        box.className = "result show r-free";
        html += `<div class="big">Not in an active HPAI zone</div><p>No HPAI movement restrictions apply here right now.</p>`;
      }
      if (can("hauler")) html += `<p>` + (nearest == null ? "No active infected premises." : `Nearest active infected premises: <b>${nearest.toFixed(1)} km</b> away.`) + `</p>`;
      if (ring) {
        const n = dists.filter((k) => k <= radius).length;
        const ca = zr.some((a) => a.status === "Active" && a.zone_type === "Control Area");
        const sz = zr.some((a) => a.status === "Active" && a.zone_type === "Surveillance Zone");
        const relN = zr.filter((a) => a.status === "Released" && a.zone_type === "Control Area").length;
        html += `<p><b>Within ${radius} km:</b> ${can("hauler") ? n + " active infected premises; " : ""}${ca ? "a control area reaches this area" : "no control area"}${sz ? "; a surveillance zone reaches this area" : ""}${relN ? `; ${relN} released control area${relN > 1 ? "s" : ""}` : ""}.</p>`;
      }
      if (rel) html += `<p style="font-size:12px;opacity:.85">History: this location was in a control area released ${fmtDate(rel.released_date)} (${daysAgo(rel.released_date)} days ago).</p>`;
      html += `<p style="font-size:12px;opacity:.85">Location: ${esc(name || label(pt))}. Checked ${new Date().toLocaleString()}. Sample data.</p>`;
      box.innerHTML = html;
    } catch (err) {
      box.className = "result show r-info"; box.innerHTML = "Could not check this location: " + esc(err.message);
    }
  }

  // use my location (like the Washington "Near Me" tool)
  document.getElementById("locBtn").onclick = () => {
    const box = document.getElementById("pubResult");
    if (!navigator.geolocation) { box.className = "result show r-info"; box.innerHTML = "Your browser cannot share its location."; return; }
    box.className = "result show r-info"; box.innerHTML = "Finding your location…";
    navigator.geolocation.getCurrentPosition((p) => {
      const pt = webMercatorUtils.geographicToWebMercator({ type: "point", x: p.coords.longitude, y: p.coords.latitude, spatialReference: { wkid: 4326 } });
      view.goTo({ target: pt, zoom: 11 }); checkLocation(pt, "My location");
    }, () => { box.className = "result show r-info"; box.innerHTML = "Could not get your location. Search an address or click the map instead."; }, { timeout: 10000 });
  };

  // data last-updated stamp (like Pennsylvania's "updated daily" note)
  zonesQ.load().then(() => {
    const d = zonesQ.editingInfo && zonesQ.editingInfo.lastEditDate;
    document.getElementById("updated").textContent = d ? "Zones last updated " + new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";
  }).catch(() => {});

  // wild-bird status line
  wild.when(() => wild.queryFeatureCount().then((n) => {
    document.getElementById("wildNote").textContent = n ? `${n} wild-bird detection${n > 1 ? "s" : ""} in the last 4 weeks.` : "No wild-bird detections reported in the last 4 weeks.";
  }).catch(() => {}));

  // ---------------- HAULER ----------------
  const stops = { org: null, dst: null };
  const orgSearch = new Search({ view, container: "orgSearch", popupEnabled: false, resultGraphicEnabled: false, locationEnabled: false, allPlaceholder: "Origin address" });
  const dstSearch = new Search({ view, container: "dstSearch", popupEnabled: false, resultGraphicEnabled: false, locationEnabled: false, allPlaceholder: "Destination address" });
  orgSearch.on("select-result", (e) => { if (e.result) { stops.org = { pt: e.result.feature.geometry, name: e.result.name }; drawStops(); } });
  dstSearch.on("select-result", (e) => { if (e.result) { stops.dst = { pt: e.result.feature.geometry, name: e.result.name }; drawStops(); } });
  let pickMode = null;
  function updatePickButtons() {
    document.getElementById("pickOrg").classList.toggle("active", pickMode === "org");
    document.getElementById("pickDst").classList.toggle("active", pickMode === "dst");
    document.getElementById("pickRep").classList.toggle("active", pickMode === "rep");
  }
  document.getElementById("pickOrg").onclick = () => { pickMode = pickMode === "org" ? null : "org"; updatePickButtons(); };
  document.getElementById("pickDst").onclick = () => { pickMode = pickMode === "dst" ? null : "dst"; updatePickButtons(); };
  document.getElementById("pickRep").onclick = () => { pickMode = pickMode === "rep" ? null : "rep"; updatePickButtons(); };
  function setReport(pt) {
    marks.removeAll(); mark(pt, [180, 35, 24, 1]);
    const g = webMercatorUtils.webMercatorToGeographic(pt);
    const q = new URLSearchParams({ center: `${g.y.toFixed(6)},${g.x.toFixed(6)}` });
    if (signedUser && signedUser.fullName) q.set("field:reporter_name", signedUser.fullName);
    if (signedUser && signedUser.email) q.set("field:email", signedUser.email);
    document.getElementById("repLoc").textContent = `Location marked: ${label(pt)}`;
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
    const b = document.getElementById("routeResult"); b.className = "result"; b.innerHTML = "";
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
    if (!stops.org || !stops.dst) { box.className = "result show r-info"; box.innerHTML = "Set both an origin and a destination."; return; }
    box.className = "result show r-info"; box.innerHTML = "Planning route…"; routeLyr.removeAll();
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
      let html = `<div class="big">${permit ? "Movement permit required" : "No permit required for this route"}</div>`;
      html += `<p><b>${r.km.toFixed(1)} km</b>${mins ? ", about " + mins : ""}${mode ? " (truck routing)" : ""}.</p><ul>`;
      html += `<li>In control areas: <b>${caKm.toFixed(1)} km</b></li><li>In surveillance zones: ${szKm.toFixed(1)} km</li>`;
      if (direct && Math.abs(direct.km - r.km) > 0.5) html += `<li>Avoiding control areas adds ${(r.km - direct.km).toFixed(1)} km compared with the direct route (red dashed line).</li>`;
      if (!avoided) html += `<li>No road route avoids every control area, so the shortest route is shown.</li>`;
      html += roadLine("Origin", roadO) + roadLine("Destination", roadD);
      html += `</ul>`;
      if (r.steps && r.steps.length) html += `<details class="dirs"><summary>Turn-by-turn directions</summary><ol>${r.steps.map((d) => `<li>${esc(d.text)}${d.km > 0.05 ? " (" + d.km.toFixed(1) + " km)" : ""}</li>`).join("")}</ol></details>`;
      if (permit) {
        html += `<p>Why: ${reasons.join("; ")}.</p>`;
        if (C.permitFormUrl && !C.permitFormUrl.startsWith("REPLACE")) {
          const q = new URLSearchParams({
            "field:origin": stops.org.name || label(stops.org.pt), "field:destination": stops.dst.name || label(stops.dst.pt),
            "field:commodity": document.getElementById("commodity").value, "field:route_km": r.km.toFixed(1),
            "field:ca_km": caKm.toFixed(1), "field:permit_reason": reasons.join("; ")
          });
          const og = webMercatorUtils.webMercatorToGeographic(stops.org.pt);
          q.set("center", `${og.y.toFixed(6)},${og.x.toFixed(6)}`); // places the request point at the origin
          html += `<a class="permit" target="_blank" rel="noopener" href="${C.permitFormUrl}?${q.toString()}">Request a movement permit →</a>`;
        } else html += `<p><i>Permit request form not configured yet.</i></p>`;
      }
      box.className = "result show " + (permit ? "r-ca" : "r-free"); box.innerHTML = html;
    } catch (err) {
      box.className = "result show r-info"; box.innerHTML = "Could not plan the route: " + esc(err.message);
    }
  };

  // ---------------- REGULATOR ----------------
  async function loadPremisesList() {
    const div = document.getElementById("premList");
    try {
      const r = await premises.queryFeatures({ where: "1=1", outFields: ["*"], returnGeometry: true, orderByFields: ["status ASC", "confirmed_date DESC"] });
      div.innerHTML = r.features.map((f, i) => { const a = f.attributes; return `<div class="prem" data-i="${i}"><b>${esc(a.premises_id)}</b><span class="tag ${a.status}">${a.status}</span><br>${esc(a.county)} Co. · ${esc(a.flock_type)} · ${(a.birds || 0).toLocaleString()} birds<br>Confirmed ${fmtDate(a.confirmed_date)}${a.released_date ? " · Released " + fmtDate(a.released_date) : ""}</div>`; }).join("");
      div.querySelectorAll(".prem").forEach((el) => el.onclick = () => { const f = r.features[+el.dataset.i]; view.goTo({ target: f.geometry, zoom: 11 }); view.openPopup({ features: [f], location: f.geometry }); });
    } catch (err) { div.innerHTML = "Could not load premises: " + esc(err.message); }
    const links = [];
    if (C.permitResultsUrl) links.push(`<a href="${C.permitResultsUrl}" target="_blank" rel="noopener">Permit requests →</a>`);
    if (C.reportResultsUrl) links.push(`<a href="${C.reportResultsUrl}" target="_blank" rel="noopener">Outbreak reports →</a>`);
    document.getElementById("permitAdmin").innerHTML = links.join(" &nbsp; ");
  }

  // ---------------- Map clicks ----------------
  view.on("click", (e) => {
    if (pickMode === "rep") { setReport(e.mapPoint); pickMode = null; updatePickButtons(); e.stopPropagation(); return; }
    if (pickMode === "org" || pickMode === "dst") {
      stops[pickMode] = { pt: e.mapPoint, name: label(e.mapPoint) };
      (pickMode === "org" ? orgSearch : dstSearch).searchTerm = label(e.mapPoint);
      pickMode = null; updatePickButtons(); drawStops(); e.stopPropagation(); return;
    }
    checkLocation(e.mapPoint);
  });

  initRole();
});
