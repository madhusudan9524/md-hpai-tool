/* Maryland HPAI map: hauler tools.
 * Truck route planning that avoids control areas (Esri truck routing: height, weight, hazmat, live traffic),
 * keeps away from other poultry farms, adds a cleaning & disinfection stop, checks allowed hours and road closures;
 * saved trips, permit requests filled in from the route, permit status with QR code (Apple Wallet when configured),
 * printable trip sheet, and farm check-ins (visit log for tracing).
 */
window.HPAI.modules.push(function (ctx) {
  const { H, C, S, view } = ctx, { $, esc, DAY, fmtDate, fmtTime, toast, store, sheet, closeSheet, qrSvg } = H;
  const { Graphic, Point, Polygon, geometryEngine: ge, wmu } = ctx.esri, { routeLyr, closuresLyr } = ctx.layers;
  const ICON = { live: "🐔", eggs: "🥚", feed: "🌾", litter: "🧺", dead: "⚠️", service: "🛠️" };
  const local = { trips: store.get("trips", []), permits: store.get("permits", []) };

  // ---- inputs ----
  let org = null, dst = null, commodity = store.get("commodity", "feed"), last = null;
  const wgs = (g) => (g.spatialReference && !g.spatialReference.isWGS84 ? wmu.webMercatorToGeographic(g) : g);
  const orgS = ctx.makeSearch("orgBox", "From: farm, mill or address", (g, n) => { org = { pt: wgs(g), name: n }; pin(); });
  const dstS = ctx.makeSearch("dstBox", "To: destination", (g, n) => { dst = { pt: wgs(g), name: n }; pin(); });
  const chips = $("commChips");
  chips.innerHTML = Object.entries(C.commodities).map(([k, v]) => `<button class="chip ${k === commodity ? "on" : ""}" data-k="${k}">${ICON[k] || ""} ${esc(v.label)}</button>`).join("");
  chips.querySelectorAll(".chip").forEach((b) => (b.onclick = () => { commodity = b.dataset.k; store.set("commodity", commodity); chips.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b)); }));
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4); $("depart").value = now.toISOString().slice(0, 16);
  const veh = store.get("vehicle", null); if (veh && veh.hft) { $("vehH").value = veh.hft; $("vehW").value = veh.wt; }
  $("swapBtn").onclick = () => { [org, dst] = [dst, org]; orgS.searchTerm = org ? org.name : ""; dstS.searchTerm = dst ? dst.name : ""; pin(); };
  function pin() {
    routeLyr.removeAll();
    [[org, [30, 110, 190]], [dst, [200, 40, 30]]].forEach(([p, c]) => p && routeLyr.add(new Graphic({ geometry: new Point({ longitude: p.pt.longitude, latitude: p.pt.latitude }), symbol: { type: "simple-marker", size: 14, color: c.concat(1), outline: { color: [255, 255, 255, 1], width: 3 } } })));
  }
  $("clearRoute").onclick = () => { org = dst = last = null; orgS.clear(); dstS.clear(); routeLyr.removeAll(); $("routeResult").innerHTML = ""; };
  ctx.actions.tripFrom = (pt, name) => { ctx.setWorkspace("hauler"); org = { pt: wgs(pt), name: name || "Picked point" }; orgS.searchTerm = org.name; pin(); };
  ctx.actions.tripTo = (pt, name) => { ctx.setWorkspace("hauler"); dst = { pt: wgs(pt), name: name || "Picked point" }; dstS.searchTerm = dst.name; pin(); };
  ctx.on("card", () => S.ws === "hauler" ? `<button class="pb" data-act="tripFrom">Start here</button><button class="pb" data-act="tripTo">End here</button>` : "");

  // ---- road closures (MDOT CHART via Maryland Open Data) ----
  let closures = [];
  async function loadClosures() {
    try {
      const r = await fetch(C.closuresUrl + "?$limit=1000").then((x) => x.json());
      closures = r.filter((c) => c.lat && c.long).map((c) => ({ x: +c.long, y: +c.lat, full: /all lanes|road closed|closed in both|full closure/i.test((c.lanes || "") + " " + (c.incident || "")), a: c }));
      closuresLyr.removeAll();
      closures.forEach((c) => closuresLyr.add(new Graphic({ geometry: new Point({ longitude: c.x, latitude: c.y }), attributes: { incident: c.a.incident, lanes: c.a.lanes, updated: c.a.updated },
        symbol: { type: "simple-marker", style: c.full ? "x" : "triangle", size: c.full ? 11 : 10, color: c.full ? [200, 40, 30, 1] : [230, 161, 0, 1], outline: { color: c.full ? [200, 40, 30, 1] : [60, 60, 60, 1], width: c.full ? 3 : 1 } } })));
    } catch (e) { closures = []; }
  }
  ctx.on("ws", (w) => { if ((w === "hauler" || w === "regulator") && !closures.length) loadClosures(); if (w === "hauler") { loadTrips(); loadPermits(); } });

  // ---- C&D stations (sample until MDA lists real ones) ----
  let stations = [];
  fetch(C.stationsUrl).then((r) => r.json()).then((j) => (stations = (j.stations || []).map((s) => Object.assign({ sample: !!j.sample }, s)))).catch(() => {});

  // ---- travel modes (Esri truck routing) ----
  let modes = null;
  async function truckMode() {
    if (!modes) { const d = await ctx.rest(C.routeUrl, {}); modes = d.supportedTravelModes || []; }
    const m = JSON.parse(JSON.stringify(modes.find((x) => /trucking time/i.test(x.name)) || modes.find((x) => /truck/i.test(x.name)) || modes[0]));
    return m;
  }

  const fs = (features, geometryType) => JSON.stringify({ geometryType, spatialReference: { wkid: 4326 }, features });
  const poly4326 = (g) => { const p = wmu.webMercatorToGeographic(g); return { rings: p.rings, spatialReference: { wkid: 4326 } }; };

  $("routeBtn").onclick = plan;
  async function plan() {
    if (!org || !dst) return toast("Pick where you start and where you're going");
    if (!S.user) return toast("Sign in to plan truck routes");
    const box = $("routeResult"), cm = C.commodities[commodity], depart = Date.parse($("depart").value) || Date.now();
    const vhFt = +$("vehH").value || 13.5, vwT = +$("vehW").value || 40; store.set("vehicle", { hft: vhFt, wt: vwT });
    const vh = vhFt * 0.3048, vw = vwT * 0.907185;   // to meters and metric tonnes for the routing service
    box.innerHTML = `<div class="rres"><p class="hint">Planning a truck route…</p></div>`; $("routeBtn").disabled = true;
    const rules = [];
    try {
      const oP = new Point({ longitude: org.pt.longitude, latitude: org.pt.latitude }), dP = new Point({ longitude: dst.pt.longitude, latitude: dst.pt.latitude });
      const [oz, dz] = await Promise.all([ctx.zoneAt(oP), ctx.zoneAt(dP)]);
      const ca = S.areas.map((f) => f.geometry);
      // 1. control areas: a "fence" along each area's border blocks the roads that cross into it
      //    (a filled shape would touch thousands of streets, over the routing service's 2,000-street limit).
      //    Areas the trip starts or ends in are left open so the truck can get in or out.
      const polys = [], fences = [];
      ca.forEach((g) => {
        const inside = ge.contains(g, wmu.geographicToWebMercator(oP)) || ge.contains(g, wmu.geographicToWebMercator(dP));
        if (inside) return;
        const p = wmu.webMercatorToGeographic(ge.generalize(g, 40, true));
        p.rings.forEach((r) => fences.push({ geometry: { paths: [r] }, attributes: { BarrierType: 0 } }));
      });
      if (ca.length) rules.push(["🛑", oz.zone === "control" || dz.zone === "control" ? "Shortest time inside the control area" : "Routed around control areas"]);
      // 2. other poultry farms (biosecurity): routes stay away where they can
      if (cm.farmBuffer && ctx.layers.farmsUrlReadable !== false) {
        try {
          const ext = { xmin: Math.min(oP.longitude, dP.longitude) - 0.15, ymin: Math.min(oP.latitude, dP.latitude) - 0.15, xmax: Math.max(oP.longitude, dP.longitude) + 0.15, ymax: Math.max(oP.latitude, dP.latitude) + 0.15, spatialReference: { wkid: 4326 } };
          const r = await ctx.rest(C.farmsUrl + "/query", { geometry: JSON.stringify(ext), geometryType: "esriGeometryEnvelope", where: "1=1", returnGeometry: true, outSR: 102100, resultRecordCount: 600, f: "json" });
          // only farms close to the direct line of travel (keeps the request small)
          const direct = { type: "polyline", paths: [[[oP.longitude, oP.latitude], [dP.longitude, dP.latitude]]], spatialReference: { wkid: 4326 } }, dm = wmu.geographicToWebMercator(direct);
          const pts = r.features.map((f) => new Point({ x: f.geometry.x, y: f.geometry.y, spatialReference: { wkid: 102100 } }))
            .filter((p) => ge.distance(p, wmu.geographicToWebMercator(oP), "kilometers") > 1 && ge.distance(p, wmu.geographicToWebMercator(dP), "kilometers") > 1 && ge.distance(p, dm, "kilometers") <= 5)
            .slice(0, 120);
          if (pts.length) {
            const buf = ge.union(ge.geodesicBuffer(pts, C.farmBufferKm, "kilometers"));
            const simple = ge.generalize(buf, 60, true);
            (simple.rings.length > 400 ? [] : [simple]).forEach((g) => polys.push({ geometry: poly4326(g), attributes: { BarrierType: 1, Attr_TravelTime: 1.6, Attr_TruckTravelTime: 1.6 } }));
            rules.push(["🐔", `Keeps about ${Math.round(C.farmBufferKm * 3280.84 / 100) * 100} ft from ${pts.length} other poultry farms where it can`]);
          }
        } catch (e) { ctx.layers.farmsUrlReadable = false; }
      }
      // 3. road closures (full closures blocked; lane closures slow the route)
      const bb = (c) => c.x > Math.min(oP.longitude, dP.longitude) - 0.3 && c.x < Math.max(oP.longitude, dP.longitude) + 0.3 && c.y > Math.min(oP.latitude, dP.latitude) - 0.3 && c.y < Math.max(oP.latitude, dP.latitude) + 0.3;
      if (!closures.length) await loadClosures();
      const near = closures.filter(bb).slice(0, 150);
      const pointBarriers = near.map((c) => ({ geometry: { x: c.x, y: c.y }, attributes: c.full ? { BarrierType: 0 } : { BarrierType: 2, Attr_TravelTime: 5, Attr_TruckTravelTime: 5 } }));
      if (near.length) rules.push(["🚧", `${near.length} MDOT CHART closures considered`]);
      // 4. cleaning & disinfection stop when leaving a control area
      const stops = [{ geometry: { x: oP.longitude, y: oP.latitude }, attributes: { Name: "Start" } }];
      const needCD = (cm.cd === true && (oz.zone === "control" || dz.zone === "control")) || (cm.cd === "leaving" && oz.zone === "control");
      let cd = null;
      if (needCD && stations.length) {
        cd = stations.map((s) => ({ s, d: ge.distance(wmu.geographicToWebMercator(new Point({ longitude: s.lon, latitude: s.lat })), wmu.geographicToWebMercator(oz.zone === "control" ? oP : dP), "kilometers") }))
          .filter(({ s }) => !ca.some((g) => ge.contains(g, wmu.geographicToWebMercator(new Point({ longitude: s.lon, latitude: s.lat }))))).sort((a, b) => a.d - b.d)[0];
        if (cd) { stops.push({ geometry: { x: cd.s.lon, y: cd.s.lat }, attributes: { Name: cd.s.name } }); rules.push(["🧼", `Cleaning & disinfection stop: ${cd.s.name.replace(/^Sample C&D station: /, "")}`]); }
      }
      stops.push({ geometry: { x: dP.longitude, y: dP.latitude }, attributes: { Name: "End" } });
      // 5. truck limits (height, weight, hazmat) + live traffic at the departure time
      const tm = await truckMode();
      tm.attributeParameterValues = (tm.attributeParameterValues || []).map((p) => {
        if (/height/i.test(p.parameterName) && /height/i.test(p.attributeName)) p.value = vh;
        if (/weight/i.test(p.parameterName) && /weight/i.test(p.attributeName) && !/axle/i.test(p.attributeName)) p.value = vw * 1000;
        return p;
      });
      if (cm.hazmat) { tm.restrictionAttributeNames = (tm.restrictionAttributeNames || []).concat(["Any Hazmat Prohibited"]).filter((v, i, a) => a.indexOf(v) === i); rules.push(["☣️", "Hazmat-restricted roads avoided (dead-bird load)"]); }
      rules.push(["🚛", `Truck limits: ${vhFt} ft high, ${vwT} tons`]);
      const params = { stops: fs(stops, "esriGeometryPoint"), travelMode: JSON.stringify(tm), startTime: depart, startTimeIsUTC: true, returnRoutes: true, returnStops: false, outputLines: "esriNAOutputLineTrueShape", outSR: 102100, directionsLanguage: "en", returnDirections: false };
      if (pointBarriers.length) params.barriers = fs(pointBarriers, "esriGeometryPoint");
      // try the full set of rules first, then relax step by step so a route is always found
      const tries = [
        { fences, polys, note: null },
        { fences, polys: [], note: polys.length ? "Farm spacing skipped for this trip (too many farms along the way)" : null },
        { fences: [], polys: [], note: "No road avoids the control areas completely. Check with MDA before entering." }
      ];
      let res, lastErr;
      for (const t of tries) {
        const q = Object.assign({}, params);
        if (t.fences.length) q.polylineBarriers = JSON.stringify({ geometryType: "esriGeometryPolyline", spatialReference: { wkid: 4326 }, features: t.fences });
        if (t.polys.length) q.polygonBarriers = fs(t.polys, "esriGeometryPolygon");
        try { res = await ctx.rest(C.routeUrl + "/solve", q); if (res.routes && res.routes.features.length) { if (t.note) rules.push(["⚠️", t.note]); break; } }
        catch (e) { lastErr = e; res = null; }
      }
      if (!res) throw lastErr || new Error("No route found");
      const feat = res.routes && res.routes.features[0]; if (!feat) throw new Error("No route found");
      const line = { type: "polyline", paths: feat.geometry.paths, spatialReference: { wkid: 102100 } };
      const km = ge.geodesicLength(line, "kilometers"), min = feat.attributes.Total_TravelTime || feat.attributes.Total_TruckTravelTime || feat.attributes.Total_Minutes || 0;
      // exposure along the route
      let caKm = 0, szKm = 0;
      ca.forEach((g) => { const i = ge.intersect(line, g); if (i) caKm += ge.geodesicLength(i, "kilometers"); });
      if (ctx.layers.L.sz) { try { const r = await ctx.layers.L.sz.queryFeatures({ where: ctx.layers.L.sz.definitionExpression, geometry: line, returnGeometry: true, outSpatialReference: { wkid: 102100 } }); r.features.forEach((f) => { const i = ge.intersect(line, f.geometry); if (i) szKm += ge.geodesicLength(i, "kilometers"); }); } catch (e) {} }
      const permit = caKm > 0.05 || oz.zone === "control" || dz.zone === "control";
      // allowed hours for this movement type
      const hrs = cm.hours, dh = new Date(depart).getHours(), arr = new Date(depart + min * 6e4).getHours();
      const hoursOk = !hrs || (dh >= hrs[0] && arr < hrs[1]);
      if (hrs) rules.push([hoursOk ? "🕒" : "⛔", hoursOk ? `Within allowed hours (${hrs[0]}:00–${hrs[1]}:00)` : `Outside allowed hours for ${cm.label.toLowerCase()} (${hrs[0]}:00–${hrs[1]}:00)`]);
      rules.push(["🚦", "Live and typical traffic at departure time"]);

      routeLyr.removeAll(); pin();
      routeLyr.add(new Graphic({ geometry: line, symbol: { type: "simple-line", color: [255, 255, 255, 0.95], width: 9 } }));
      routeLyr.add(new Graphic({ geometry: line, symbol: { type: "simple-line", color: permit ? [200, 40, 30, 1] : [30, 110, 190, 1], width: 5 } }));
      if (cd) routeLyr.add(new Graphic({ geometry: new Point({ longitude: cd.s.lon, latitude: cd.s.lat }), symbol: { type: "simple-marker", style: "square", size: 13, color: [19, 128, 143, 1], outline: { color: [255, 255, 255, 1], width: 2 } } }));
      view.goTo(routeLyr.graphics.toArray(), { padding: 60 }).catch(() => {});
      const free = Math.max(0, km - caKm - szKm);
      last = { org, dst, commodity, depart, km, min, caKm, szKm, permit, line, zones: [oz.zone, dz.zone], cd: cd && cd.s.name, hoursOk };
      box.innerHTML = `<div class="rres">
        <div class="ch" style="margin:0"><h3>${permit ? "Permit needed" : "No permit needed"}</h3><span class="pill ${permit ? "red" : "green"}">${permit ? "Control area" : "Clear"}</span></div>
        <div class="rbar"><i class="c" style="width:${(caKm / km) * 100}%"></i><i class="s" style="width:${(szKm / km) * 100}%"></i><i class="f" style="width:${(free / km) * 100}%"></i></div>
        <div class="rkv"><div><b>${Math.round(min)}</b><span>min</span></div><div><b>${H.mi(km, 0)}</b><span>miles</span></div><div><b>${H.mi(caKm)}</b><span>mi in zone</span></div></div>
        <div style="margin-top:8px">${rules.map(([i, t]) => `<div class="rule"><i>${i}</i><span>${esc(t)}</span></div>`).join("")}</div>
        <div class="btns">${permit ? `<button class="primary" id="permitBtn">Request permit</button>` : ""}<button class="ghost" id="saveTrip">Save</button><button class="ghost" id="sheetBtn">Trip sheet</button></div></div>`;
      if (permit) $("permitBtn").onclick = () => permitForm(last);
      $("saveTrip").onclick = () => saveTrip(last);
      $("sheetBtn").onclick = () => tripSheet(last);
      ctx.sheetHalf();
    } catch (e) {
      box.innerHTML = `<div class="rres"><p class="hint">Couldn't plan the route: ${esc(e.message)}</p></div>`;
    } finally { $("routeBtn").disabled = false; }
  }

  // ---- saved trips ----
  async function saveTrip(t) {
    const name = `${t.org.name.split(",")[0]} → ${t.dst.name.split(",")[0]}`;
    const rec = { id: H.uid("T"), name, commodity: t.commodity, org: t.org, dst: t.dst, km: t.km, min: t.min, inZone: t.caKm > 0.05, at: Date.now() };
    local.trips.unshift(rec); store.set("trips", local.trips.slice(0, 30));
    if (ctx.has(C.movement.trips)) {
      ctx.rest(C.movement.trips + "/addFeatures", { features: JSON.stringify([{ geometry: t.line, attributes: { trip_id: rec.id, name, commodity: t.commodity, origin: t.org.name, destination: t.dst.name, depart: t.depart, km: +t.km.toFixed(1), minutes: Math.round(t.min), zone_km: +t.caKm.toFixed(2), saved: 1 } }]) }).catch(() => {});
    }
    toast("Trip saved"); loadTrips();
  }
  function loadTrips() {
    const box = $("tripList");
    if (!local.trips.length) { box.innerHTML = `<p class="hint">Plan a route and tap Save.</p>`; return; }
    box.innerHTML = local.trips.map((t) => `<div class="trip" data-id="${t.id}"><span class="ic">${ICON[t.commodity] || "🚛"}</span><span class="tx"><b>${esc(t.name)}</b><small>${Math.round(t.min)} min · ${H.mi(t.km, 0)} mi${t.inZone ? " · through zone" : ""}</small></span><button class="mini" data-go="${t.id}">Plan</button></div>`).join("");
    box.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => {
      const t = local.trips.find((x) => x.id === b.dataset.go); org = t.org; dst = t.dst; commodity = t.commodity;
      orgS.searchTerm = org.name; dstS.searchTerm = dst.name; chips.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x.dataset.k === commodity)); pin(); plan();
    }));
  }
  document.querySelectorAll("#hTabs button").forEach((b) => (b.onclick = () => { document.querySelectorAll("#hTabs button").forEach((x) => x.classList.toggle("on", x === b)); $("pane-trips").hidden = b.dataset.p !== "trips"; $("pane-permits").hidden = b.dataset.p !== "permits"; if (b.dataset.p === "permits") loadPermits(); }));

  // ---- permit request (filled in from the route) ----
  function permitForm(t) {
    const prof = store.get("profile", {}), cm = C.commodities[t.commodity];
    const tomorrow = new Date(t.depart + DAY).toISOString().slice(0, 10);
    sheet("Movement permit request", `<div class="form">
      <div class="rres" style="margin:0"><div class="rule"><i>🅰</i><span>${esc(t.org.name)}</span></div><div class="rule"><i>🅱</i><span>${esc(t.dst.name)}</span></div>
        <div class="rule"><i>${ICON[t.commodity] || ""}</i><span>${esc(cm.label)} · ${H.mi(t.km, 0)} mi · ${H.mi(t.caKm)} mi in control area</span></div></div>
      <div class="two"><label>Leave<input id="pmFrom" type="date" value="${new Date(t.depart).toISOString().slice(0, 10)}"></label><label>Valid until<input id="pmTo" type="date" value="${tomorrow}"></label></div>
      <div class="two"><label>Loads<input id="pmLoads" type="number" min="1" value="1"></label><label>Plate / unit<input id="pmPlate" value="${esc(prof.plate || "")}"></label></div>
      <div class="two"><label>Company<input id="pmCo" value="${esc(prof.company || "")}"></label><label>Driver<input id="pmDrv" value="${esc(prof.driver || (S.user && S.user.fullName) || "")}"></label></div>
      <label>Phone<input id="pmPh" type="tel" value="${esc(prof.phone || "")}"></label>
      <label>Premises or NPIP ID (if moving birds or eggs)<input id="pmPrem"></label>
      <label class="lrow" style="padding:0"><input type="checkbox" id="pmCD" checked class="tg"><span>Truck will be cleaned and disinfected${t.cd ? " at " + esc(t.cd) : ""}</span></label>
      <button class="primary" id="pmGo">Send to MDA</button></div>`);
    $("pmGo").onclick = async () => {
      const p = { company: $("pmCo").value, driver: $("pmDrv").value, phone: $("pmPh").value, plate: $("pmPlate").value }; store.set("profile", p);
      if (!p.company || !p.phone) return toast("Add company and phone");
      const id = "MD-" + new Date().getFullYear() + "-" + Math.random().toString(36).slice(2, 7).toUpperCase();
      const attrs = { permit_id: id, status: "Pending", commodity: t.commodity, origin: t.org.name, destination: t.dst.name, depart: Date.parse($("pmFrom").value + "T00:00:00"), valid_to: Date.parse($("pmTo").value + "T23:59:00"),
        loads: +$("pmLoads").value || 1, company: p.company, driver: p.driver, phone: p.phone, plate: p.plate, premises_ref: $("pmPrem").value, zone_km: +t.caKm.toFixed(2), km: +t.km.toFixed(1), cd_planned: $("pmCD").checked ? 1 : 0, requested: Date.now() };
      $("pmGo").disabled = true;
      try {
        if (ctx.has(C.movement.permits)) { const r = await ctx.rest(C.movement.permits + "/addFeatures", { features: JSON.stringify([{ geometry: t.line, attributes: attrs }]) }); if (!r.addResults[0].success) throw new Error("not saved"); }
        local.permits.unshift(attrs); store.set("permits", local.permits.slice(0, 50));
        closeSheet(); toast("Permit request sent: " + id, 4500); loadPermits();
        document.querySelector('#hTabs [data-p="permits"]').click();
      } catch (e) { $("pmGo").disabled = false; toast("Couldn't send: " + e.message); }
    };
  }
  ctx.actions.permitFromRoute = () => last ? permitForm(last) : toast("Plan a route first");

  // ---- my permits + QR ----
  async function loadPermits() {
    const box = $("permitList"); let list = local.permits;
    if (ctx.has(C.movement.permits) && S.user) {
      try { const r = await ctx.rest(C.movement.permits + "/query", { where: "1=1", outFields: "*", returnGeometry: false, orderByFields: "requested DESC", resultRecordCount: 50 }); list = r.features.map((f) => f.attributes); } catch (e) {}
    }
    const col = { Pending: "amber", Approved: "green", Denied: "red", Expired: "" };
    box.innerHTML = list.length ? list.map((p) => {
      const exp = p.status === "Approved" && p.valid_to < Date.now(), st = exp ? "Expired" : p.status;
      return `<div class="permit" data-id="${esc(p.permit_id)}"><span class="tx"><b>${esc(p.permit_id)}</b><small>${esc((p.origin || "").split(",")[0])} → ${esc((p.destination || "").split(",")[0])} · ${fmtDate(p.depart)}</small></span><span class="pill ${col[st] || ""}">${st}</span></div>`;
    }).join("") : `<p class="hint">No permits yet.</p>`;
    box.querySelectorAll(".permit").forEach((el) => (el.onclick = () => showPermit(list.find((p) => p.permit_id === el.dataset.id))));
  }
  function showPermit(p) {
    const url = location.origin + location.pathname + "#verify=" + encodeURIComponent(p.permit_id);
    const ok = p.status === "Approved" && p.valid_to >= Date.now();
    sheet("Permit " + p.permit_id, `<div class="form">
      <div class="pill ${ok ? "green" : p.status === "Denied" ? "red" : "amber"}" style="justify-self:start;font-size:14px">${ok ? "Approved" : p.status === "Approved" ? "Expired" : esc(p.status)}</div>
      ${ok ? `<div class="qr">${qrSvg(url)}</div><p class="hint" style="text-align:center">Show this at checkpoints. MDA scans it to confirm.</p>` : `<p class="hint">${p.status === "Pending" ? "MDA is reviewing your request. You'll see the QR code here once it's approved." : esc(p.reason || "")}</p>`}
      <div class="rres" style="margin:0"><div class="rule"><i>🅰</i><span>${esc(p.origin)}</span></div><div class="rule"><i>🅱</i><span>${esc(p.destination)}</span></div>
      <div class="rule"><i>📅</i><span>${fmtDate(p.depart)} – ${fmtDate(p.valid_to)}</span></div><div class="rule"><i>${ICON[p.commodity] || ""}</i><span>${esc((C.commodities[p.commodity] || {}).label || p.commodity)} · ${p.loads || 1} load(s) · ${esc(p.plate || "")}</span></div></div>
      ${ok && ctx.has(C.walletPassUrl) ? `<a class="wallet" href="${esc(C.walletPassUrl.replace("{id}", encodeURIComponent(p.permit_id)))}"> Add to Apple Wallet</a>` : ""}
      ${ok ? `<button class="ghost" id="pmPrint">Print permit</button>` : ""}</div>`);
    if (ok) $("pmPrint").onclick = () => printDoc(`Movement permit ${p.permit_id}`, `<div style="display:flex;gap:24px;align-items:center"><div style="width:220px">${qrSvg(url)}</div><div><h2>Approved</h2><p>${esc(p.origin)} → ${esc(p.destination)}</p><p>${fmtDate(p.depart)} – ${fmtDate(p.valid_to)}</p><p>${esc(p.company)} · ${esc(p.driver)} · ${esc(p.plate || "")}</p></div></div>`);
  }

  // ---- printable trip sheet ----
  function tripSheet(t) {
    const cm = C.commodities[t.commodity];
    view.takeScreenshot({ width: 900, height: 520 }).then((shot) => printDoc("Trip sheet", `<p><b>${esc(t.org.name)}</b> → <b>${esc(t.dst.name)}</b></p>
      <p>${esc(cm.label)} · leave ${fmtTime(t.depart)} · ${Math.round(t.min)} min · ${H.mi(t.km, 0)} miles · ${H.mi(t.caKm)} miles in a control area</p>
      <p>${t.permit ? "<b>MDA movement permit required.</b>" : "No permit needed at time of planning."} ${t.cd ? "C&D stop: " + esc(t.cd) : ""}</p><img src="${shot.dataUrl}" style="width:100%;border-radius:8px">
      <p style="font-size:12px;color:#666">Zones can change. Check the Maryland HPAI Map before you leave. Call MDA ${esc(C.mdaPhone)} with questions.</p>`)).catch(() => toast("Couldn't make the sheet"));
  }
  function printDoc(title, html) {
    const w = window.open("", "_blank"); if (!w) return toast("Allow pop-ups to print");
    w.document.write(`<!doctype html><title>${esc(title)}</title><style>body{font:15px -apple-system,Segoe UI,Arial;margin:32px;color:#14202e}h1{font-size:22px}svg{width:100%;height:auto}</style><h1>${esc(title)}</h1>${html}<p style="font-size:12px;color:#666">Maryland HPAI Map · printed ${new Date().toLocaleString()}</p><script>setTimeout(()=>print(),400)<\/script>`);
    w.document.close();
  }
  ctx.printDoc = printDoc;

  // ---- farm check-in (visit log used by MDA tracing and grower risk) ----
  let checking = false;
  ctx.on("pick", (mp) => { if (!checking) return false; checking = false; checkIn(wgs(mp)); return true; });
  ctx.actions.checkin = () => {
    sheet("Farm check-in", `<div class="form"><p class="hint">Log each farm you visit. If a farm later tests positive, MDA can reach the right drivers fast.</p>
      <button class="primary" id="ciHere">I'm at the farm now</button><button class="ghost" id="ciMap">Pick the farm on the map</button></div>`);
    $("ciHere").onclick = () => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => checkIn({ longitude: p.coords.longitude, latitude: p.coords.latitude }), () => toast("Location not available")) : toast("Location not available");
    $("ciMap").onclick = () => { closeSheet(); checking = true; toast("Tap the farm on the map"); };
  };
  async function checkIn(g) {
    const fromZone = local.trips.some((t) => t.inZone && Date.now() - t.at <= 14 * DAY) || (await ctx.zoneAt(new Point({ longitude: g.longitude, latitude: g.latitude }))).zone === "control";
    const rec = { geometry: { x: g.longitude, y: g.latitude, spatialReference: { wkid: 4326 } }, attributes: { visited: Date.now(), from_zone: fromZone ? 1 : 0, commodity, note: "" } };
    try { if (ctx.has(C.movement.visits)) await ctx.rest(C.movement.visits + "/addFeatures", { features: JSON.stringify([rec]) }); closeSheet(); toast("Checked in" + (fromZone ? " · flagged: vehicle was in a control area in the last 14 days" : ""), 4500); }
    catch (e) { toast("Couldn't check in: " + e.message); }
  }
});
