/* Maryland HPAI map: MDA premises registry (MDA staff only).
 * Accurate premises boundaries (auto-suggested from FEMA/ORNL building footprints, drawn, edited, imported, or batch-built),
 * poultry house outlines, and a full record per premises: operator, birds, history, compliance. Nothing is "validated" until MDA approves it.
 */
(function (root) {
  // A poultry house is a long, large building: at least 800 m2 and about 3.5 times longer than wide.
  // Length/width come from the outline's perimeter P and area A (rectangle: L + W = P/2, L x W = A).
  function houseShape(P, A) {
    const s = P / 2, disc = s * s - 4 * A;
    if (!(A > 0) || disc < 0) return { L: 0, W: 0, ratio: 0 };
    const L = (s + Math.sqrt(disc)) / 2, W = s - L;
    return { L, W, ratio: W > 0 ? L / W : 0 };
  }
  const isPoultryHouse = (P, A) => A >= 800 && houseShape(P, A).ratio >= 3.5;
  const api = { houseShape, isPoultryHouse };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  root.HPAIRegistry = api;

  root.HPAI.modules.push(function (ctx) {
    const { H, C, S, view } = ctx, { $, esc, DAY, fmtDate, fmtShort, toast, sheet, closeSheet, csv } = H;
    const { FeatureLayer, Graphic, Point, Polygon, geometryEngine: ge, wmu, SketchViewModel } = ctx.esri, { marks } = ctx.layers;
    const has = ctx.has, ok = () => has(C.core.registry);
    const edit = (u, p) => ctx.rest(u + "/applyEdits", p);
    const Q = (u, p) => ctx.rest(u + "/query", Object.assign({ where: "1=1", outFields: "*", returnGeometry: false }, p || {}));
    const NAVY = [30, 60, 90];

    // ---- map layers (MDA only): registered premises + poultry houses ----
    let regLyr = null, houseLyr = null;
    function addLayers() {
      if (!ok() || regLyr) return;
      houseLyr = new FeatureLayer({ url: C.core.houses, title: "Poultry houses", minScale: 60000, outFields: ["*"], popupEnabled: false,
        renderer: { type: "simple", symbol: { type: "simple-fill", color: [120, 85, 45, 0.55], outline: { color: [90, 60, 30, 1], width: 0.8 } } } });
      regLyr = new FeatureLayer({ url: C.core.registry, title: "Registered premises", minScale: 250000, outFields: ["*"], popupEnabled: false,
        renderer: { type: "unique-value", field: "validation",
          defaultSymbol: { type: "simple-fill", color: NAVY.concat(0.05), outline: { color: NAVY.concat(1), width: 1.6, style: "dash" } },
          uniqueValueInfos: [
            { value: "Validated", label: "MDA validated", symbol: { type: "simple-fill", color: NAVY.concat(0.1), outline: { color: NAVY.concat(1), width: 2.2 } } },
            { value: "Rejected", label: "Rejected", symbol: { type: "simple-fill", color: [140, 140, 150, 0.05], outline: { color: [140, 140, 150, 0.8], width: 1, style: "dot" } } }] },
        labelingInfo: [{ minScale: 40000, labelExpressionInfo: { expression: "DefaultValue($feature.name, $feature.premises_id)" }, symbol: { type: "text", color: NAVY.concat(1), haloColor: [255, 255, 255, 0.95], haloSize: 1.5, font: { size: 11, weight: "bold" } } }] });
      view.map.addMany([regLyr, houseLyr]);
      ctx.layers.registry = regLyr; ctx.layers.houses = houseLyr; ctx.renderKey();
    }
    ctx.on("ws", (w) => { if (w === "regulator") addLayers(); else if (regLyr) { view.map.removeMany([regLyr, houseLyr]); regLyr = houseLyr = null; ctx.layers.registry = ctx.layers.houses = null; } });
    ctx.on("hitLayers", () => (ctx.isStaff() && regLyr ? [regLyr] : []));
    ctx.on("hit", ({ g }) => { if (regLyr && g.layer === regLyr) { openPremises(g.attributes.OBJECTID); return true; } return false; });
    // used by "New infected premises": a registered boundary at this point
    ctx.registryAt = async (pt) => {
      if (!regLyr) return null;
      const r = await regLyr.queryFeatures({ geometry: pt, spatialRelationship: "intersects", outFields: ["*"], returnGeometry: true, outSpatialReference: { wkid: 102100 } }).catch(() => ({ features: [] }));
      return r.features[0] || null;
    };

    // ---- auto outline from building footprints ----
    async function autoOutline(pt) {   // pt in 102100 or 4326 → { perimeter, houses[], source }
      const g = pt.spatialReference.isWGS84 ? pt : wmu.webMercatorToGeographic(pt);
      let feats = [];
      try {
        const r = await fetch(C.structuresUrl + "/query?" + new URLSearchParams({ f: "json", geometry: JSON.stringify({ x: g.longitude, y: g.latitude, spatialReference: { wkid: 4326 } }),
          geometryType: "esriGeometryPoint", inSR: 4326, distance: 350, units: "esriSRUnit_Meter", outFields: "SQMETERS,Shape__Area,Shape__Length", returnGeometry: true, outSR: 102100 })).then((x) => x.json());
        feats = r.features || [];
      } catch (e) {}
      const houses = feats.map((f) => Polygon.fromJSON(Object.assign({ spatialReference: { wkid: 102100 } }, f.geometry)))
        .filter((p) => { const A = ge.geodesicArea(p, "square-meters"), P = ge.geodesicLength(p, "meters"); return isPoultryHouse(P, A); });
      if (!houses.length) {
        return { perimeter: ge.geodesicBuffer(pt.spatialReference.isWGS84 ? wmu.geographicToWebMercator(pt) : pt, 0.15, "kilometers"), houses: [], source: "default 150 m (no poultry houses found)" };
      }
      // keep the group of houses nearest the point (each within 100 m of another), so a neighboring farm is not merged in
      const p0 = pt.spatialReference.isWGS84 ? wmu.geographicToWebMercator(pt) : pt;
      houses.sort((a, b) => ge.distance(a, p0, "meters") - ge.distance(b, p0, "meters"));
      const cluster = [houses[0]];
      let grew = true;
      while (grew) { grew = false; houses.forEach((h) => { if (!cluster.includes(h) && cluster.some((c) => ge.distance(c, h, "meters") <= 100)) { cluster.push(h); grew = true; } }); }
      const hull = ge.convexHull(ge.union(cluster), true);
      return { perimeter: ge.geodesicBuffer(hull, 40, "meters"), houses: cluster, source: `auto: ${cluster.length} poultry house${cluster.length > 1 ? "s" : ""} (FEMA/ORNL footprints)` };
    }
    ctx.autoOutline = autoOutline;

    const countyOf = (geom) => { const c = ctx.countyAt(geom.centroid || geom.extent.center); return c ? { county: c.name, state: c.state } : { county: "", state: "" }; };
    async function saveNew(o, attrs) {
      const pid = attrs.premises_id || "MDP-" + (attrs.farm_id || H.uid());
      const cs = countyOf(o.perimeter);
      const area = o.houses.reduce((s, h) => s + ge.geodesicArea(h, "square-meters"), 0);
      const r = await edit(C.core.registry, { adds: JSON.stringify([{ geometry: o.perimeter.toJSON(), attributes: Object.assign({ premises_id: pid, county: cs.county, state: cs.state, houses: o.houses.length || null,
        house_area_m2: area ? Math.round(area) : null, status: "Active", validation: "Auto", outline_source: o.source }, attrs, { premises_id: pid }) }]) });
      const res = r.addResults && r.addResults[0]; if (!res || !res.success) throw new Error("not saved");
      if (o.houses.length) await edit(C.core.houses, { adds: JSON.stringify(o.houses.map((h) => ({ geometry: h.toJSON(), attributes: { premises_id: pid, area_m2: Math.round(ge.geodesicArea(h, "square-meters")), source: "FEMA/ORNL USA Structures" } }))) }).catch(() => {});
      return { oid: res.objectId, pid };
    }

    // ---- registry pane (inside the MDA "Premises" tab) ----
    let filter = "all", term = "", batchStop = false;
    ctx.registryPane = async (box) => {
      if (!ok()) { box.innerHTML = `<p class="hint">Registry layer not connected (config.js core.registry).</p>`; return; }
      addLayers();
      box.innerHTML = `<div class="kv" id="rgStats"><div><b>–</b><span>registered</span></div><div><b>–</b><span>MDA validated</span></div></div>
        <div class="btns" style="margin-top:0"><button class="primary" id="rgAdd">+ Add premises</button></div>
        <div class="btns"><button class="ghost" id="rgBatch" style="flex:1">Auto-outline farms in view</button><button class="ghost" id="rgImp" style="flex:1">Import file</button></div>
        <input type="file" id="rgFile" accept=".geojson,.json,.csv" hidden><div id="rgProg"></div>
        <div class="form" style="margin-top:10px"><input id="rgQ" placeholder="Search name, ID, operator, county" value="${esc(term)}"></div>
        <div class="seg" id="rgSeg" style="margin-top:8px"><button data-f="all">All</button><button data-f="review">Needs review</button><button data-f="valid">Validated</button></div>
        <div id="rgList"><p class="hint">Loading…</p></div>`;
      box.querySelectorAll("#rgSeg button").forEach((b) => { b.classList.toggle("on", b.dataset.f === filter); b.onclick = () => { filter = b.dataset.f; ctx.registryPane(box); }; });
      let tmo; $("rgQ").oninput = () => { clearTimeout(tmo); tmo = setTimeout(() => { term = $("rgQ").value.trim(); list(); }, 300); };
      $("rgAdd").onclick = addOne; $("rgBatch").onclick = batch; $("rgImp").onclick = () => $("rgFile").click(); $("rgFile").onchange = importFile;
      const [all, val] = await Promise.all([ctx.rest(C.core.registry + "/query", { where: "1=1", returnCountOnly: true }), ctx.rest(C.core.registry + "/query", { where: "validation = 'Validated'", returnCountOnly: true })]).catch(() => [{}, {}]);
      $("rgStats").innerHTML = `<div><b>${all.count ?? "–"}</b><span>registered</span></div><div><b>${val.count ?? "–"}</b><span>MDA validated</span></div>`;
      list();
    };
    async function list() {
      const el = $("rgList"); if (!el) return;
      const w = [filter === "review" ? "validation <> 'Validated'" : filter === "valid" ? "validation = 'Validated'" : "1=1"];
      if (term) { const t = term.replace(/'/g, "''").toUpperCase(); w.push(`(UPPER(name) LIKE '%${t}%' OR UPPER(premises_id) LIKE '%${t}%' OR UPPER(operator) LIKE '%${t}%' OR UPPER(county) LIKE '%${t}%')`); }
      try {
        const r = await Q(C.core.registry, { where: w.join(" AND "), outFields: "OBJECTID,premises_id,name,county,production_type,capacity,validation,status", orderByFields: "validation ASC, county ASC", resultRecordCount: 150 });
        el.innerHTML = r.features.length ? r.features.map((f) => { const a = f.attributes; return `<div class="prow" data-o="${a.OBJECTID}"><span class="tx"><b>${esc(a.name || a.premises_id)}</b><small>${esc(a.county || "")}${a.production_type ? " · " + esc(a.production_type) : ""}${a.capacity ? " · " + a.capacity.toLocaleString() + " birds" : ""}</small></span><span class="pill ${a.validation === "Validated" ? "green" : a.validation === "Rejected" ? "" : "amber"}">${a.validation === "Validated" ? "Validated" : a.validation === "Rejected" ? "Rejected" : "Review"}</span></div>`; }).join("")
          : `<p class="hint">No premises yet. Use “+ Add premises” or “Auto-outline farms in view”.</p>`;
        el.querySelectorAll(".prow").forEach((row) => (row.onclick = () => openPremises(+row.dataset.o, true)));
      } catch (e) { el.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
    }

    // single premises: tap the map, outline is suggested automatically
    let picking = false;
    ctx.on("pick", (mp) => { if (!picking) return false; picking = false; addAt(mp); return true; });
    function addOne() { picking = true; ctx.sheetPeek(); toast("Tap the farm on the map. The outline is suggested from building footprints.", 5000); }
    async function addAt(mp) {
      toast("Finding poultry houses…");
      let farmId = null;
      try { const r = await ctx.layers.farms.queryFeatures({ geometry: mp, distance: 400, units: "meters", outFields: ["farm_id"], returnGeometry: false }); if (r.features[0]) farmId = r.features[0].attributes.farm_id; } catch (e) {}
      const o = await autoOutline(mp);
      try { const s = await saveNew(o, { farm_id: farmId }); ctx.audit("registry:add", s.pid, o.source); toast(o.source); regLyr && regLyr.refresh(); houseLyr && houseLyr.refresh(); openPremises(s.oid, true); }
      catch (e) { toast("Couldn't save: " + e.message); }
    }

    // batch: every estimated farm in the current view that isn't registered yet
    async function batch() {
      const prog = $("rgProg");
      if (!ctx.layers.farms) return toast("Farms layer not loaded");
      if (view.zoom < 9.5) return toast("Zoom in to a county or smaller first");
      const fr = await ctx.layers.farms.queryFeatures({ geometry: view.extent, outFields: ["farm_id"], returnGeometry: true, outSpatialReference: { wkid: 102100 } }).catch(() => ({ features: [] }));
      const ids = fr.features.map((f) => f.attributes.farm_id).filter(Boolean);
      let done = new Set();
      if (ids.length) { try { (await Q(C.core.registry, { where: `farm_id IN (${ids.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(",")})`, outFields: "farm_id" })).features.forEach((f) => done.add(f.attributes.farm_id)); } catch (e) {} }
      const todo = fr.features.filter((f) => !done.has(f.attributes.farm_id)).slice(0, 200);
      if (!todo.length) return toast("Every farm in view is already registered");
      if (!confirm(`Auto-outline ${todo.length} farm${todo.length > 1 ? "s" : ""} in view? They are added as “Needs review” until MDA validates them.`)) return;
      batchStop = false; let n = 0, withHouses = 0;
      prog.innerHTML = `<div class="rres"><div class="rbar"><i class="f" id="rgBar" style="width:0%"></i></div><div style="display:flex;justify-content:space-between;align-items:center"><small id="rgTxt">Starting…</small><button class="mini" id="rgStop">Stop</button></div></div>`;
      $("rgStop").onclick = () => (batchStop = true);
      for (const f of todo) {
        if (batchStop) break;
        try { const o = await autoOutline(f.geometry); await saveNew(o, { farm_id: f.attributes.farm_id }); if (o.houses.length) withHouses++; } catch (e) {}
        n++; $("rgBar").style.width = `${(n / todo.length) * 100}%`; $("rgTxt").textContent = `${n} of ${todo.length} · ${withHouses} with poultry houses found`;
      }
      ctx.audit("registry:batch", `${n} farms`, `${withHouses} outlined from building footprints`);
      toast(`Added ${n} premises (${withHouses} outlined from poultry houses). Review and validate them.`, 6000);
      regLyr && regLyr.refresh(); houseLyr && houseLyr.refresh(); const box = $("rgList") && $("rgList").parentElement; if (box) ctx.registryPane(box);
    }

    // import GeoJSON (polygons or points) or CSV (latitude/longitude columns)
    async function importFile() {
      const file = $("rgFile").files[0]; if (!file) return;
      const text = await file.text(); let items = [];
      const FIELDS = ["premises_id", "farm_id", "name", "operator", "phone", "email", "address", "usda_pin", "npip_id", "integrator", "production_type", "species", "bird_class", "capacity", "current_birds", "houses", "water_source", "status", "notes"];
      const pick = (o) => { const a = {}; Object.keys(o || {}).forEach((k) => { const kk = k.toLowerCase().trim().replace(/\s+/g, "_"); if (FIELDS.includes(kk) && o[k] !== "" && o[k] != null) a[kk] = ["capacity", "current_birds", "houses"].includes(kk) ? parseInt(o[k], 10) || null : String(o[k]).slice(0, 250); }); return a; };
      try {
        if (/\.csv$/i.test(file.name)) {
          const rows = text.split(/\r?\n/).filter(Boolean), hd = rows[0].split(",").map((h) => h.trim().toLowerCase());
          const li = hd.findIndex((h) => /^(lat|latitude|y)$/.test(h)), lo = hd.findIndex((h) => /^(lon|lng|long|longitude|x)$/.test(h));
          if (li < 0 || lo < 0) throw new Error("CSV needs latitude and longitude columns");
          items = rows.slice(1).map((r) => { const v = r.split(","); const o = {}; hd.forEach((h, i) => (o[h] = v[i])); return { pt: new Point({ longitude: +v[lo], latitude: +v[li] }), a: pick(o) }; }).filter((x) => !isNaN(x.pt.latitude));
        } else {
          const gj = JSON.parse(text);
          items = (gj.features || []).map((f) => {
            const g = f.geometry || {};
            if (g.type === "Point") return { pt: new Point({ longitude: g.coordinates[0], latitude: g.coordinates[1] }), a: pick(f.properties) };
            if (g.type === "Polygon" || g.type === "MultiPolygon") { const rings = g.type === "Polygon" ? g.coordinates : g.coordinates.flat(); return { poly: wmu.geographicToWebMercator(new Polygon({ rings, spatialReference: { wkid: 4326 } })), a: pick(f.properties) }; }
            return null;
          }).filter(Boolean);
        }
      } catch (e) { return toast("Couldn't read the file: " + e.message); }
      if (!items.length) return toast("No usable features in the file");
      if (!confirm(`Import ${items.length} premises from ${file.name}? Points get an outline suggested from building footprints.`)) return;
      let n = 0;
      for (const it of items.slice(0, 500)) {
        try { const o = it.poly ? { perimeter: it.poly, houses: [], source: "imported: " + file.name } : await autoOutline(it.pt); await saveNew(o, it.a); n++; } catch (e) {}
        if (n % 10 === 0) toast(`Imported ${n} of ${items.length}…`);
      }
      ctx.audit("registry:import", file.name, `${n} premises`); toast(`Imported ${n} premises`); regLyr && regLyr.refresh(); houseLyr && houseLyr.refresh();
    }

    // ---- premises record ----
    const PROD = ["Broiler", "Broiler breeder", "Table-egg layer", "Pullet", "Turkey", "Turkey breeder", "Duck", "Upland gamebird", "Live bird market", "Backyard", "Other"];
    const EVENTS = ["Inspection", "Sample collected", "Test result", "HPAI detection", "Quarantine", "Depopulation", "Cleaning & disinfection", "Restocking", "Biosecurity audit", "Permit", "Note"];
    const STAT = ["Active", "Vacant (between flocks)", "Quarantined", "Depopulated", "Closed"];
    const opt = (list, v) => list.map((x) => `<option ${x === v ? "selected" : ""}>${esc(x)}</option>`).join("");
    const dv = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "");
    let svm = null;
    async function openPremises(oid, zoom) {
      let f;
      try { f = (await Q(C.core.registry, { objectIds: oid, returnGeometry: true, outSR: 102100 })).features[0]; } catch (e) { return toast(e.message); }
      if (!f) return;
      const a = f.attributes, geom = Polygon.fromJSON(Object.assign({ spatialReference: { wkid: 102100 } }, f.geometry));
      if (zoom) view.goTo(geom.extent.clone().expand(2.5)).catch(() => {});
      let tab = "ov";
      const body = sheet(a.name || a.premises_id, `<div class="ch" style="margin:-6px 0 8px"><span class="sub">${esc(a.premises_id)} · ${esc(a.county || "")}${a.state && a.state !== "Maryland" ? ", " + esc(a.state) : ""}</span><span class="pill ${a.validation === "Validated" ? "green" : "amber"}">${a.validation === "Validated" ? "MDA validated" : esc(a.validation || "Review")}</span></div>
        <div class="seg" id="pmTabs"><button data-t="ov" class="on">Overview</button><button data-t="bd">Birds</button><button data-t="hi">History</button><button data-t="co">Compliance</button><button data-t="ol">Outline</button></div>
        <div class="form" id="pmBody"></div>
        <div class="btns"><button class="primary" id="pmSave">Save</button>${a.validation !== "Validated" ? `<button class="ghost" id="pmVal" style="color:var(--green)">Validate</button>` : ""}<button class="ghost" id="pmRej" title="Not a poultry premises">Reject</button></div>`);
      const vals = Object.assign({}, a);
      const field = (k, label, type) => `<label>${label}<input data-k="${k}" ${type ? `type="${type}"` : ""} value="${esc(type === "date" ? dv(vals[k]) : vals[k] ?? "")}"></label>`;
      const sel = (k, label, list) => `<label>${label}<select data-k="${k}"><option value=""></option>${opt(list, vals[k])}</select></label>`;
      async function render() {
        const el = $("pmBody");
        if (tab === "ov") el.innerHTML = `${field("name", "Premises name")}<div class="two">${field("operator", "Operator / owner")}${field("integrator", "Integrator / company")}</div>
          <div class="two">${field("phone", "Phone", "tel")}${field("email", "Email", "email")}</div>${field("address", "Address")}
          <div class="two">${field("usda_pin", "USDA premises ID (PIN)")}${field("npip_id", "NPIP number")}</div><div class="two">${sel("status", "Status", STAT)}${field("water_source", "Water source")}</div>${`<label>Notes<textarea data-k="notes" rows="2">${esc(vals.notes || "")}</textarea></label>`}`;
        if (tab === "bd") el.innerHTML = `<div class="two">${sel("production_type", "Production type", PROD)}${field("species", "Species (e.g. chicken, turkey)")}</div>
          ${field("bird_class", "Bird size / age class (e.g. broilers 6–8 wk, ~6 lb)")}<div class="two">${field("capacity", "Capacity (birds)", "number")}${field("current_birds", "Birds on site now", "number")}</div>
          <div class="two">${field("placement_date", "Flock placed", "date")}${field("market_date", "Expected market", "date")}</div>
          <div class="two">${field("houses", "Poultry houses", "number")}<label>House floor area<input disabled value="${vals.house_area_m2 ? Math.round(vals.house_area_m2).toLocaleString() + " m²" : "–"}"></label></div>`;
        if (tab === "co") {
          let audits = "";
          if (has(C.core.biosecurity) && a.farm_id) { try { audits = (await Q(C.core.biosecurity, { where: `farm_id = '${String(a.farm_id).replace(/'/g, "''")}'`, orderByFields: "audit_date DESC" })).features.map((x) => `<div class="prow"><span class="tx"><b>${fmtDate(x.attributes.audit_date)}</b><small>${esc(x.attributes.auditor || "")} ${esc(x.attributes.notes || "")}</small></span><span class="pill ${x.attributes.passed ? "green" : "red"}">${x.attributes.passed ? "Passed" : "Not passed"}</span></div>`).join(""); } catch (e) {} }
          el.innerHTML = `<label class="lrow" style="padding:0"><input type="checkbox" class="tg" data-k="bio_plan" ${vals.bio_plan ? "checked" : ""}><span>Written biosecurity plan on file</span></label>
            <div class="two">${field("bio_plan_date", "Plan date", "date")}${sel("npip_status", "NPIP status", ["Participating", "Not participating", "Suspended", "Unknown"])}</div>
            <div class="two">${field("last_audit", "Last biosecurity audit", "date")}${sel("audit_result", "Audit result", ["Passed", "Passed with corrections", "Not passed"])}</div>
            <label>Compliance notes<textarea data-k="compliance_notes" rows="3">${esc(vals.compliance_notes || "")}</textarea></label>${audits ? `<h4 style="margin:4px 0">Audit records</h4>${audits}` : ""}`;
        }
        if (tab === "hi") {
          let ev = [], linked = [];
          try { ev = (await Q(C.core.events, { where: `premises_id = '${a.premises_id.replace(/'/g, "''")}'`, orderByFields: "event_date DESC" })).features.map((x) => x.attributes); } catch (e) {}
          try { linked = (await Q(has(C.core.premises) ? C.core.premises : C.legacy.premises, { geometry: JSON.stringify(geom.toJSON()), geometryType: "esriGeometryPolygon", outFields: "premises_id,status,confirmed_date,released_date,flock_type" })).features.map((x) => x.attributes); } catch (e) {}
          el.innerHTML = `${linked.map((l) => `<div class="prow"><span class="tx"><b>HPAI · ${esc(l.premises_id)}</b><small>confirmed ${fmtDate(l.confirmed_date)}${l.released_date ? " · released " + fmtDate(l.released_date) : ""}</small></span><span class="pill ${l.status === "Active" ? "red" : ""}">${esc(l.status)}</span></div>`).join("")}
            ${ev.map((e) => `<div class="prow"><span class="tx"><b>${esc(e.event_type)}${e.result ? " · " + esc(e.result) : ""}</b><small>${fmtDate(e.event_date)} · ${esc(e.by_user || "")}${e.details ? " · " + esc(e.details) : ""}</small></span></div>`).join("") || (linked.length ? "" : `<p class="hint">No history yet.</p>`)}
            <h4 style="margin:8px 0 2px">Add event</h4><div class="two"><label>Date<input type="date" id="evD" value="${dv(Date.now())}"></label><label>Type<select id="evT">${opt(EVENTS)}</select></label></div>
            <div class="two"><label>Result<input id="evR" placeholder="e.g. negative, 12 samples"></label><label>Details<input id="evX"></label></div><button class="ghost" id="evAdd">Add to history</button>`;
          $("evAdd").onclick = async () => {
            try { await edit(C.core.events, { adds: JSON.stringify([{ attributes: { premises_id: a.premises_id, event_date: Date.parse($("evD").value + "T12:00:00"), event_type: $("evT").value, result: $("evR").value, details: $("evX").value, by_user: S.user.username } }]) });
              ctx.audit("registry:event", a.premises_id, $("evT").value); toast("Added"); render(); } catch (e) { toast("Couldn't add: " + e.message); }
          };
        }
        if (tab === "ol") {
          el.innerHTML = `<p class="hint">Source: ${esc(a.outline_source || "–")}. ${a.houses ? a.houses + " poultry houses, " + Math.round(a.house_area_m2 || 0).toLocaleString() + " m²." : ""}</p>
            <div class="btns" style="margin-top:0"><button class="ghost" id="olAuto" style="flex:1">Suggest from buildings</button><button class="ghost" id="olEdit" style="flex:1">Edit shape</button><button class="ghost" id="olDraw" style="flex:1">Draw new</button></div><p class="hint" id="olMsg"></p>`;
          const saveGeom = async (g, src, hs) => {
            await edit(C.core.registry, { updates: JSON.stringify([{ geometry: g.toJSON(), attributes: Object.assign({ OBJECTID: oid, outline_source: src, validation: "Auto" }, hs ? { houses: hs.length || null, house_area_m2: Math.round(hs.reduce((s, h) => s + ge.geodesicArea(h, "square-meters"), 0)) || null } : {}) }]) });
            if (hs) {
              const old = await ctx.rest(C.core.houses + "/query", { where: `premises_id = '${a.premises_id.replace(/'/g, "''")}'`, returnIdsOnly: true }).catch(() => ({}));
              if (old.objectIds && old.objectIds.length) await edit(C.core.houses, { deletes: old.objectIds.join(",") });
              if (hs.length) await edit(C.core.houses, { adds: JSON.stringify(hs.map((h) => ({ geometry: h.toJSON(), attributes: { premises_id: a.premises_id, area_m2: Math.round(ge.geodesicArea(h, "square-meters")), source: "FEMA/ORNL USA Structures" } }))) });
            }
            ctx.audit("registry:outline", a.premises_id, src); regLyr && regLyr.refresh(); houseLyr && houseLyr.refresh(); toast("Outline saved. Validate it when it looks right.");
          };
          $("olAuto").onclick = async () => { $("olMsg").textContent = "Looking for poultry houses…"; const o = await autoOutline(geom.centroid); await saveGeom(o.perimeter, o.source, o.houses); $("olMsg").textContent = o.source; };
          const sketch = (mode) => {
            $("sheet").hidden = true; marks.removeAll();
            if (!svm) svm = new SketchViewModel({ view, layer: marks, polygonSymbol: { type: "simple-fill", color: NAVY.concat(0.15), outline: { color: NAVY.concat(1), width: 2 } } });
            const done = async (g) => { $("sheet").hidden = false; marks.removeAll(); if (g) await saveGeom(g, mode === "draw" ? "drawn by " + S.user.username : "edited by " + S.user.username); };
            if (mode === "draw") { toast("Tap the corners of the premises, double-tap to finish", 5000); svm.create("polygon"); const h = svm.on("create", (e) => { if (e.state === "complete") { h.remove(); done(e.graphic.geometry); } else if (e.state === "cancel") { h.remove(); done(null); } }); }
            else { const gr = new Graphic({ geometry: geom, symbol: svm.polygonSymbol }); marks.add(gr); svm.update([gr], { tool: "reshape" }); toast("Drag the corners. Click outside the shape when done.", 5000);
              const h = svm.on("update", (e) => { if (e.state === "complete") { h.remove(); done(e.graphics[0].geometry); } }); }
          };
          $("olEdit").onclick = () => sketch("edit"); $("olDraw").onclick = () => sketch("draw");
        }
        el.querySelectorAll("[data-k]").forEach((inp) => (inp.onchange = () => { const k = inp.dataset.k; vals[k] = inp.type === "checkbox" ? (inp.checked ? 1 : 0) : inp.type === "date" ? (inp.value ? Date.parse(inp.value + "T12:00:00") : null) : inp.type === "number" ? (inp.value === "" ? null : +inp.value) : inp.value; }));
      }
      body.querySelectorAll("#pmTabs button").forEach((b) => (b.onclick = () => { tab = b.dataset.t; body.querySelectorAll("#pmTabs button").forEach((x) => x.classList.toggle("on", x === b)); render(); }));
      render();
      const save = async (extra, msg) => {
        const keys = ["name", "operator", "integrator", "phone", "email", "address", "usda_pin", "npip_id", "status", "water_source", "notes", "production_type", "species", "bird_class", "capacity", "current_birds", "placement_date", "market_date", "houses", "bio_plan", "bio_plan_date", "npip_status", "last_audit", "audit_result", "compliance_notes"];
        const at = { OBJECTID: oid }; keys.forEach((k) => { if (vals[k] !== a[k]) at[k] = vals[k]; }); Object.assign(at, extra || {});
        try { await edit(C.core.registry, { updates: JSON.stringify([{ attributes: at }]) }); ctx.audit("registry:" + (msg || "update"), a.premises_id, Object.keys(at).filter((k) => k !== "OBJECTID").join(", ")); toast(msg === "validate" ? "Validated" : msg === "reject" ? "Rejected" : "Saved"); regLyr && regLyr.refresh(); closeSheet(); const l = $("rgList"); if (l) list(); }
        catch (e) { toast("Couldn't save: " + e.message); }
      };
      $("pmSave").onclick = () => save();
      if ($("pmVal")) $("pmVal").onclick = () => save({ validation: "Validated", validated_by: S.user.username, validated_date: Date.now() }, "validate");
      $("pmRej").onclick = () => confirm("Mark as not a poultry premises?") && save({ validation: "Rejected", validated_by: S.user.username, validated_date: Date.now() }, "reject");
    }
    ctx.openPremises = openPremises;
  });
})(typeof window !== "undefined" ? window : this);
