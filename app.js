/* Maryland HPAI Response Map - prototype
   Public: control-area lookup, released areas fading with age, wild-bird detections
   Haulers: truck routing that avoids active control areas + permit request link
   Regulators: premises, all zone rings, details
*/
require([
  "esri/config", "esri/identity/OAuthInfo", "esri/identity/IdentityManager",
  "esri/Map", "esri/views/MapView", "esri/layers/FeatureLayer", "esri/layers/GraphicsLayer", "esri/Graphic",
  "esri/widgets/Search", "esri/widgets/LayerList", "esri/widgets/Home",
  "esri/rest/route", "esri/rest/support/RouteParameters", "esri/rest/support/FeatureSet", "esri/rest/networkService",
  "esri/geometry/geometryEngine", "esri/geometry/support/webMercatorUtils"
], function (esriConfig, OAuthInfo, esriId, Map, MapView, FeatureLayer, GraphicsLayer, Graphic,
  Search, LayerList, Home, route, RouteParameters, FeatureSet, networkService, geometryEngine, webMercatorUtils) {

  const C = window.HPAI_CONFIG;
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
    url: C.zonesUrl, title: "Active control areas",
    definitionExpression: "zone_type = 'Control Area' AND status = 'Active'",
    outFields: ["confirmed_date"],
    renderer: { type: "simple", symbol: fill([200, 40, 30, 0.28], [180, 35, 24, 1], 2) },
    popupTemplate: { title: "Active HPAI control area", content: [{ type: "text", text: "Established {confirmed_date}. A movement permit from MDA is required for poultry, poultry products, feed and other regulated items moving onto or off premises in this area." }], fieldInfos: [{ fieldName: "confirmed_date", format: { dateFormat: "short-date" } }] }
  });

  // PUBLIC + REGULATOR: released control areas, fading with time since release
  const releasedRenderer = {
    type: "simple", symbol: fill([130, 90, 170, 1], [122, 90, 166, 1], 1, "dash"),
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
    url: C.zonesUrl, title: "Released control areas (fade with age)",
    definitionExpression: "zone_type = 'Control Area' AND status = 'Released'",
    outFields: ["confirmed_date", "released_date"], renderer: releasedRenderer, popupTemplate: releasedPopup
  });

  // PUBLIC + REGULATOR: wild bird detections (county level)
  const wild = new FeatureLayer({
    url: C.wildBirdsUrl, title: "HPAI in wild birds (USDA APHIS, by county)", outFields: ["*"],
    renderer: {
      type: "simple", symbol: { type: "simple-marker", color: [31, 122, 140, 0.85], outline: { color: [255, 255, 255, 1], width: 1.5 } },
      visualVariables: [
        { type: "size", field: "detections_total", stops: [{ value: 1, size: 8 }, { value: 10, size: 14 }, { value: 40, size: 24 }] },
        { type: "color", valueExpression: "DateDiff(Now(), $feature.last_detected, 'days')", valueExpressionTitle: "Days since most recent detection",
          stops: [{ value: 30, color: [200, 60, 30, 0.9] }, { value: 180, color: [31, 122, 140, 0.85] }, { value: 730, color: [150, 160, 170, 0.75] }] }
      ]
    },
    popupTemplate: {
      title: "{county}, {state}: HPAI in wild birds",
      content: "<b>{detections_total}</b> detections since 2022 ({detections_90d} in the last 90 days).<br>Most recent: <b>{last_detected}</b><br>{recent}<br><br><span style='font-size:11px'>Source: USDA APHIS. Locations are county-level, not exact sites.</span>",
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
  const regCA = zoneLayer("Control Area outline (10 km)", "zone_type = 'Control Area' AND status = 'Active'", { type: "simple", symbol: fill([0, 0, 0, 0], [140, 20, 20, 1], 2.5) });
  const regReleased = new FeatureLayer({ url: C.zonesUrl, title: "Released control areas (fade with age)", definitionExpression: "zone_type = 'Control Area' AND status = 'Released'", outFields: ["*"], renderer: releasedRenderer, popupTemplate: regPopup("Released control area") });
  const premises = new FeatureLayer({
    url: C.premisesUrl, title: "Infected premises", outFields: ["*"],
    renderer: { type: "unique-value", field: "status",
      uniqueValueInfos: [
        { value: "Active", label: "Infected premises (active)", symbol: { type: "simple-marker", style: "diamond", size: 13, color: [140, 20, 20, 1], outline: { color: "white", width: 1.5 } } },
        { value: "Released", label: "Infected premises (released)", symbol: { type: "simple-marker", style: "diamond", size: 10, color: [122, 90, 166, 0.8], outline: { color: "white", width: 1 } } }] },
    popupTemplate: { title: "{premises_id} ({status})", content: [{ type: "fields", fieldInfos: [
      { fieldName: "county", label: "County" }, { fieldName: "flock_type", label: "Flock type" }, { fieldName: "birds", label: "Birds", format: { digitSeparator: true, places: 0 } },
      { fieldName: "confirmed_date", label: "Confirmed", format: { dateFormat: "short-date" } }, { fieldName: "released_date", label: "Released", format: { dateFormat: "short-date" } },
      { fieldName: "notes", label: "Notes" }] }] }
  });

  // Query-only handle on all zones (never drawn)
  const zonesQ = new FeatureLayer({ url: C.zonesUrl, outFields: ["*"] });

  const marks = new GraphicsLayer({ title: "Selected locations", listMode: "hide" });
  const routeLyr = new GraphicsLayer({ title: "Route", listMode: "hide" });

  const map = new Map({ basemap: "topo-vector", layers: [regSZ, regBZ, pubReleased, regReleased, pubCA, regIZ, regCA, wild, premises, routeLyr, marks] });
  const view = new MapView({ container: "viewDiv", map, center: C.center, zoom: C.zoom, popup: { dockEnabled: false } });
  view.ui.add(new Home({ view }), "top-left");

  // ---------------- Tiers ----------------
  const TIER_LAYERS = {
    public: [pubCA, pubReleased, wild],
    hauler: [pubCA, pubReleased],
    regulator: [premises, regIZ, regBZ, regCA, regSZ, regReleased, wild]
  };
  const ALL = [pubCA, pubReleased, wild, premises, regIZ, regBZ, regCA, regSZ, regReleased];
  let tier = "public", layerList = null;
  function setTier(t) {
    tier = t; pickMode = null; updatePickButtons();
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tier === t));
    document.querySelectorAll("section[data-panel]").forEach((s) => s.classList.toggle("on", s.dataset.panel === t));
    ALL.forEach((l) => (l.visible = TIER_LAYERS[t].includes(l)));
    routeLyr.visible = t === "hauler";
    marks.removeAll(); view.closePopup();
    if (t === "regulator" && !layerList) { layerList = new LayerList({ view, container: "layerListDiv" }); loadPremisesList(); }
    if (layerList) layerList.visible = t === "regulator";
  }
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => setTier(b.dataset.tier)));

  // ---------------- Zone lookup ----------------
  async function zonesAt(pt) {
    const r = await zonesQ.queryFeatures({ geometry: pt, spatialRelationship: "intersects", where: "1=1", outFields: ["*"], returnGeometry: false });
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

  async function checkLocation(pt, name) {
    const box = document.getElementById("pubResult");
    box.className = "result show r-info"; box.innerHTML = "Checking…";
    marks.removeAll(); mark(pt, [23, 50, 77, 1]);
    try {
      const z = await zonesAt(pt);
      const d = designation(z);
      const act = z.filter((a) => a.status === "Active" && a.zone_type === d);
      const since = act.length ? fmtDate(Math.min(...act.map((a) => a.confirmed_date))) : "";
      const rel = z.filter((a) => a.status === "Released" && a.zone_type === "Control Area").sort((a, b) => b.released_date - a.released_date)[0];
      let html = "";
      if (d === "Control Area") {
        box.className = "result show r-ca";
        html = `<div class="big">Inside an HPAI Control Area</div><p>In place since ${since}.</p><ul><li>Moving poultry, eggs, feed, litter, carcasses or service vehicles onto or off a premises here requires an <b>MDA movement permit</b>.</li><li>Follow enhanced biosecurity. Flocks here are under surveillance testing.</li><li>Haulers: use the <b>Haulers &amp; industry</b> tab to plan a route and request a permit.</li></ul>`;
      } else if (d === "Surveillance Zone") {
        box.className = "result show r-sz";
        html = `<div class="big">Inside an HPAI Surveillance Zone</div><p>Within 20 km of an infected premises, outside the control area. Since ${since}.</p><ul><li>Not a movement-control area, but commercial flocks may be tested.</li><li>Watch flocks closely and report sick birds immediately.</li><li>Check with MDA before moving birds; zones can expand.</li></ul>`;
      } else {
        box.className = "result show r-free";
        html = `<div class="big">Not in an active HPAI zone</div><p>No HPAI movement restrictions apply here right now.</p>`;
      }
      if (rel) html += `<p style="font-size:12px;opacity:.85">History: this location was in a control area released ${fmtDate(rel.released_date)} (${daysAgo(rel.released_date)} days ago).</p>`;
      html += `<p style="font-size:12px;opacity:.85">Location: ${esc(name || label(pt))}. Checked ${new Date().toLocaleString()}. Sample data.</p>`;
      box.innerHTML = html;
    } catch (err) {
      box.className = "result show r-info"; box.innerHTML = "Could not check this location: " + esc(err.message);
    }
  }

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
  }
  document.getElementById("pickOrg").onclick = () => { pickMode = pickMode === "org" ? null : "org"; updatePickButtons(); };
  document.getElementById("pickDst").onclick = () => { pickMode = pickMode === "dst" ? null : "dst"; updatePickButtons(); };
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

  async function solve(barriers, mode) {
    const p = new RouteParameters({
      stops: new FeatureSet({ features: [new Graphic({ geometry: stops.org.pt, attributes: { Name: "Origin" } }), new Graphic({ geometry: stops.dst.pt, attributes: { Name: "Destination" } })] }),
      returnDirections: false, returnRoutes: true, outSpatialReference: view.spatialReference
    });
    if (mode) p.travelMode = mode;
    if (barriers.length) p.polygonBarriers = new FeatureSet({ features: barriers.map((g) => new Graphic({ geometry: g, attributes: { BarrierType: 0, Name: "Active control area" } })) });
    const res = await route.solve(C.routeUrl, p);
    const g = res.routeResults[0].route;
    const a = g.attributes;
    const minutes = a.Total_TravelTime ?? a.Total_Minutes ?? a.Total_TruckMinutes ?? null;
    return { geom: g.geometry, km: geometryEngine.geodesicLength(g.geometry, "kilometers"), minutes };
  }

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
      try { r = await solve(barriers, mode); } catch (e) { avoided = false; r = await solve([], mode); }
      const caKm = kmIn(r.geom, caUnion), szKm = kmIn(r.geom, szOnly);
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
      html += `</ul>`;
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
    if (C.permitResultsUrl) document.getElementById("permitAdmin").innerHTML = `<a href="${C.permitResultsUrl}" target="_blank" rel="noopener">View permit requests →</a>`;
  }

  // ---------------- Map clicks ----------------
  view.on("click", (e) => {
    if (tier === "public") { checkLocation(e.mapPoint); }
    else if (tier === "hauler" && pickMode) {
      stops[pickMode] = { pt: e.mapPoint, name: label(e.mapPoint) };
      (pickMode === "org" ? orgSearch : dstSearch).searchTerm = label(e.mapPoint);
      pickMode = null; updatePickButtons(); drawStops(); e.stopPropagation();
    }
  });

  setTier("public");
});
