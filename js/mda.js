/* Maryland HPAI map: MDA staff tools.
 * Overview + daily situation summary, review queues (reports with photos, permits, access requests),
 * zones drawn outward from the premises boundary, release, county declarations, publishing the public map
 * with a privacy check, premises inside each zone with biosecurity status, movement tracing, audit log, QR verification.
 */
window.HPAI.modules.push(function (ctx) {
  const { H, C, S, view } = ctx, { $, esc, DAY, fmtDate, fmtShort, fmtTime, toast, sheet, closeSheet, csv } = H;
  const { FeatureLayer, Graphic, Point, Polygon, geometryEngine: ge, wmu, SketchViewModel } = ctx.esri, { L, marks } = ctx.layers;
  const has = ctx.has, live = (u) => has(u);
  const url = {
    prem: () => live(C.core.premises) ? C.core.premises : C.legacy.premises,
    perim: () => live(C.core.perimeters) ? C.core.perimeters : C.legacy.perimeters,
    zones: () => live(C.core.zones) ? C.core.zones : C.legacy.zones
  };
  const Q = (u, p) => ctx.rest(u + "/query", Object.assign({ where: "1=1", outFields: "*", returnGeometry: false }, p || {}));
  const edit = (u, p) => ctx.rest(u + "/applyEdits", p);
  const BLUE = [30, 110, 190];

  // poultry farms layer (estimated, USGS study): MDA only
  const farms = new FeatureLayer({ url: C.farmsUrl, title: "Poultry farms", visible: false, outFields: ["*"], popupEnabled: false, minScale: 1500000,
    renderer: { type: "simple", symbol: { type: "simple-marker", size: 6, color: [109, 90, 58, 0.85], outline: { color: [255, 255, 255, 0.9], width: 0.8 } } } });
  ctx.layers.farms = farms;
  ctx.on("ws", (w) => { if (w === "regulator") { if (!view.map.layers.includes(farms)) view.map.add(farms, view.map.layers.indexOf(ctx.layers.L.ca || ctx.layers.tintLyr) + 1); ctx.renderKey(); open("ov"); } else if (view.map.layers.includes(farms)) view.map.remove(farms); });
  ctx.on("hitLayers", () => (ctx.isStaff() ? [farms, L.prem, L.perim].filter(Boolean) : []));
  ctx.on("hit", ({ g, pt }) => {
    if (!ctx.isStaff()) return false;
    if (g.layer === farms) { farmCard(g, pt); return true; }
    if (L.prem && g.layer === L.prem) { premCard(g.attributes, pt); return true; }
    return false;
  });

  // ---------------- tabs ----------------
  const panes = ["ov", "q", "z", "pr", "tr", "au"], loaders = {};
  function open(p) {
    document.querySelectorAll("#mdaTabs .tile").forEach((t) => t.classList.toggle("on", t.dataset.p === p));
    panes.forEach((x) => ($("pane-" + x).hidden = x !== p)); (loaders[p] || (() => {}))();
  }
  document.querySelectorAll("#mdaTabs .tile").forEach((t) => (t.onclick = () => open(t.dataset.p)));

  // ---------------- overview ----------------
  async function counts() {
    const n = async (u, where) => (has(u) ? (await ctx.rest(u + "/query", { where: where || "1=1", returnCountOnly: true }).catch(() => ({ count: null }))).count : null);
    const [prem, rep, per, acc] = await Promise.all([n(url.prem(), "status = 'Active'"), n(C.submitMda.reports, "status = 'New'"), n(C.movementMda.permits, "status = 'Pending'"), n(C.submitMda.accounts, "status = 'New'")]);
    const q = (rep || 0) + (per || 0) + (acc || 0);
    $("tOv").textContent = prem == null ? "–" : prem; $("tQ").textContent = q; $("tZ").textContent = S.areas.length; $("tPr").textContent = "▦";
    return { prem, rep, per, acc };
  }
  loaders.ov = async () => {
    const box = $("pane-ov"), c = await counts();
    box.innerHTML = `<div class="kv">
      <div><b>${c.prem == null ? "–" : c.prem}</b><span>active premises</span></div><div><b>${S.areas.length}</b><span>control areas</span></div>
      <div><b>${S.affected.length}</b><span>affected counties</span></div><div><b>${(S.wildPts || []).filter((w) => Date.now() - w.t <= 28 * DAY).length}</b><span>wild birds · 4 wk</span></div>
      <div><b>${c.rep == null ? "–" : c.rep}</b><span>new reports</span></div><div><b>${c.per == null ? "–" : c.per}</b><span>permits pending</span></div></div>
      <div class="btns" style="margin-top:0"><button class="primary" id="sumBtn">Daily situation summary</button></div>
      <div class="btns"><button class="ghost" id="pubBtn" style="flex:1">Publish public map</button><button class="ghost" id="declBtn" style="flex:1">Declare a county</button></div>
`;
    $("sumBtn").onclick = summary; $("pubBtn").onclick = publish; $("declBtn").onclick = declare;
  };

  // ---------------- daily situation summary (print / save as PDF) ----------------
  async function summary() {
    toast("Building summary…");
    const [prem, c] = await Promise.all([Q(url.prem(), { where: "status = 'Active'", orderByFields: "confirmed_date DESC" }).catch(() => ({ features: [] })), counts()]);
    const shot = await view.takeScreenshot({ width: 1000, height: 600 }).catch(() => null);
    const wild7 = (S.wildPts || []).filter((w) => Date.now() - w.t <= 7 * DAY);
    const rows = prem.features.map((f) => f.attributes).map((a) => `<tr><td>${esc(a.premises_id)}</td><td>${esc(a.county)}</td><td>${esc(a.flock_type || "")}</td><td>${fmtDate(a.confirmed_date)}</td><td>Day ${Math.floor((Date.now() - a.confirmed_date) / DAY) + 1}</td></tr>`).join("");
    ctx.printDoc("HPAI daily situation summary · " + new Date().toLocaleDateString("en-US", { dateStyle: "long" }), `
      <p style="color:#c8281e;font-weight:700">CONFIDENTIAL · MDA INTERNAL</p>
      <table style="width:100%;border-collapse:collapse;margin:12px 0" border="1" cellpadding="6"><tr><th>Active premises</th><th>Control areas</th><th>Affected counties</th><th>Wild birds (7 d / 28 d)</th><th>New reports</th><th>Permits pending</th><th>Access requests</th></tr>
      <tr style="text-align:center;font-size:20px"><td>${c.prem ?? "–"}</td><td>${S.areas.length}</td><td>${S.affected.length}</td><td>${wild7.length} / ${(S.wildPts || []).filter((w) => Date.now() - w.t <= 28 * DAY).length}</td><td>${c.rep ?? "–"}</td><td>${c.per ?? "–"}</td><td>${c.acc ?? "–"}</td></tr></table>
      ${shot ? `<img src="${shot.dataUrl}" style="width:100%;border-radius:8px">` : ""}
      <h3>Active premises</h3><table style="width:100%;border-collapse:collapse" border="1" cellpadding="6"><tr><th>ID</th><th>County</th><th>Flock</th><th>Confirmed</th><th>Day</th></tr>${rows || '<tr><td colspan="5">None</td></tr>'}</table>
      <h3>Affected counties</h3><p>${S.affected.map((a) => `${esc(a.county)}${a.state !== "Maryland" ? ", " + esc(a.state) : ""} (since ${fmtShort(a.since)})`).join("; ") || "None"}</p>
      <h3>Latest official notices</h3><ul>${((S.live && S.live.notices) || []).slice(0, 6).map((n) => `<li>${esc(n.date)} · ${esc(n.source)}: ${esc(n.title)}</li>`).join("")}</ul>`);
    ctx.audit("summary", "daily", "");
  }

  // ---------------- review queues ----------------
  let qkind = "rep";
  loaders.q = () => {
    $("pane-q").innerHTML = `<div class="seg" id="qSeg"><button data-k="rep" class="${qkind === "rep" ? "on" : ""}">Reports</button><button data-k="per" class="${qkind === "per" ? "on" : ""}">Permits</button><button data-k="acc" class="${qkind === "acc" ? "on" : ""}">Access</button></div>
      <div class="qtools"><button class="mini" id="qAll">Show done</button><button class="mini" id="qCsv">Export CSV</button></div><div id="qList"><p class="hint">Loading…</p></div>`;
    $("pane-q").querySelectorAll("#qSeg button").forEach((b) => (b.onclick = () => { qkind = b.dataset.k; loaders.q(); }));
    let all = false; $("qAll").onclick = () => { all = !all; $("qAll").textContent = all ? "Hide done" : "Show done"; load(); };
    let rows = []; $("qCsv").onclick = () => csv(rows.map((f) => f.attributes), `hpai_${qkind}.csv`);
    const cfg = {
      rep: { u: C.submitMda.reports, open: "status = 'New'", yes: ["Confirm", "Confirmed"], no: ["Dismiss", "Dismissed"] },
      per: { u: C.movementMda.permits, open: "status = 'Pending'", yes: ["Approve", "Approved"], no: ["Deny", "Denied"] },
      acc: { u: C.submitMda.accounts, open: "status = 'New'", yes: ["Approve", "Approved"], no: ["Deny", "Denied"] }
    }[qkind];
    async function load() {
      const box = $("qList");
      if (!has(cfg.u)) { box.innerHTML = `<p class="hint">This list is unavailable right now. Try again shortly.</p>`; return; }
      try {
        const r = await Q(cfg.u, { where: all ? "1=1" : cfg.open, orderByFields: (qkind === "per" ? "requested" : "created") + " DESC", resultRecordCount: 100, returnGeometry: qkind !== "acc", outSR: 4326 });
        rows = r.features;
        if (!rows.length) { box.innerHTML = `<p class="hint">Nothing waiting. 🎉</p>`; return; }
        let att = {};
        if (qkind === "rep") { try { const a = await ctx.rest(cfg.u + "/queryAttachments", { objectIds: rows.map((f) => f.attributes.OBJECTID).join(",") }); (a.attachmentGroups || []).forEach((g) => (att[g.parentObjectId] = g.attachmentInfos[0])); } catch (e) {} }
        const tk = ctx.token();
        box.innerHTML = rows.map((f, i) => {
          const a = f.attributes, done = a.status !== "New" && a.status !== "Pending";
          const img = att[a.OBJECTID] ? `<img class="photo" src="${cfg.u}/${a.OBJECTID}/attachments/${att[a.OBJECTID].id}${tk ? "?token=" + tk : ""}" alt="Photo">` : "";
          const title = qkind === "rep" ? `${a.report_type === "flock" ? "Sick flock" : "Dead wild bird"} · ${esc(a.species || "")} × ${a.count || 1}` : qkind === "per" ? `${esc(a.permit_id)} · ${esc((C.commodities[a.commodity] || {}).label || a.commodity)}` : `${esc(a.name)} · ${a.role === "hauler" ? "Hauler" : "Industry"}`;
          const sub = qkind === "rep" ? `${fmtShort(a.observed || a.created)} · ${esc(a.name || "anonymous")} ${esc(a.phone || "")}<br>${esc(a.description || "")}`
            : qkind === "per" ? `${esc((a.origin || "").split(",")[0])} → ${esc((a.destination || "").split(",")[0])}<br>${fmtDate(a.depart)}–${fmtShort(a.valid_to)} · ${esc(a.company)} · ${H.mi(a.zone_km || 0)} mi in zone`
            : `${esc(a.email)} · ${esc(a.org || "")} · ${esc(a.county || "")}${a.ref_id ? " · " + esc(a.ref_id) : ""}`;
          return `<div class="qi" data-i="${i}">${img}<span class="tx"><b>${title}</b><small>${sub}</small></span>${done ? `<span class="pill">${esc(a.status)}</span>` : `<span style="display:grid;gap:4px"><button class="mini ok" data-a="yes" data-i="${i}">${cfg.yes[0]}</button><button class="mini no" data-a="no" data-i="${i}">${cfg.no[0]}</button></span>`}</div>`;
        }).join("");
        box.querySelectorAll(".qi").forEach((el) => (el.onclick = (e) => {
          if (e.target.dataset.a) return; const f = rows[+el.dataset.i]; if (!f.geometry) return;
          marks.removeAll();
          const geom = f.geometry.paths ? { type: "polyline", paths: f.geometry.paths, spatialReference: { wkid: 4326 } } : { type: "point", x: f.geometry.x, y: f.geometry.y, spatialReference: { wkid: 4326 } };
          marks.add(new Graphic({ geometry: geom, symbol: geom.type === "polyline" ? { type: "simple-line", color: BLUE.concat(1), width: 4 } : { type: "simple-marker", style: "triangle", size: 16, color: [230, 90, 30, 1], outline: { color: [255, 255, 255, 1], width: 2 } } }));
          view.goTo(geom.type === "point" ? { target: geom, zoom: 12 } : geom).catch(() => {});
        }));
        box.querySelectorAll("[data-a]").forEach((b) => (b.onclick = async () => {
          const f = rows[+b.dataset.i], yes = b.dataset.a === "yes", st = yes ? cfg.yes[1] : cfg.no[1];
          let reason = "";
          if (!yes && qkind !== "rep") { reason = prompt("Reason (shown to the requester)") || ""; }
          const attrs = { OBJECTID: f.attributes.OBJECTID, status: st };
          if (qkind === "per") Object.assign(attrs, { decided: Date.now(), decided_by: S.user.username, reason });
          if (qkind === "rep") Object.assign(attrs, { reviewed_by: S.user.username });
          b.disabled = true;
          try {
            await edit(cfg.u, { updates: JSON.stringify([{ attributes: attrs }]) });
            ctx.audit(`${qkind}:${st}`, f.attributes.permit_id || f.attributes.email || f.attributes.OBJECTID, reason);
            toast(st); load(); counts();
            if (qkind === "acc" && yes) invite(f.attributes);
          } catch (e) { b.disabled = false; toast("Couldn't save: " + e.message); }
        }));
      } catch (e) { box.innerHTML = `<p class="hint">Couldn't load: ${esc(e.message)}</p>`; }
    }
    load();
  };
  // approving an access request: invite the person to the right ArcGIS group
  async function invite(a) {
    const title = a.role === "hauler" ? C.haulerGroup : C.industryGroup;
    try {
      const r = await ctx.rest(ctx.sharing + "/rest/community/groups", { q: `title:"${title}"`, num: 1 });
      const g = r.results && r.results[0];
      if (g) { window.open(`${C.portalUrl}/home/group.html?id=${g.id}#members`, "_blank"); toast(`Invite ${a.email} to “${title}” in the tab that opened`, 6000); }
      else toast(`Create the group “${title}” in ArcGIS, then invite ${a.email}`, 6000);
    } catch (e) { toast("Approved. Invite " + a.email + " in ArcGIS Online."); }
  }

  // ---------------- zones ----------------
  loaders.z = async () => {
    const box = $("pane-z");
    box.innerHTML = `<div class="btns" style="margin-top:0"><button class="primary" id="newZone">+ New infected premises</button></div><h4 style="margin:14px 0 6px">Active</h4><div id="zList"><p class="hint">Loading…</p></div><h4 style="margin:14px 0 6px">County declarations</h4><div id="dList"></div>`;
    $("newZone").onclick = newPremises;
    try {
      const r = await Q(url.prem(), { where: "status = 'Active'", orderByFields: "confirmed_date DESC", returnGeometry: true, outSR: 4326 });
      $("zList").innerHTML = r.features.length ? r.features.map((f, i) => { const a = f.attributes; return `<div class="prow" data-i="${i}"><span class="tx"><b>${esc(a.premises_id)} · ${esc(a.county)}</b><small>${esc(a.flock_type || "")} · confirmed ${fmtShort(a.confirmed_date)} · day ${Math.floor((Date.now() - a.confirmed_date) / DAY) + 1}</small></span><button class="mini no" data-rel="${i}">Release</button></div>`; }).join("") : `<p class="hint">No active premises.</p>`;
      $("zList").querySelectorAll(".prow").forEach((el) => (el.onclick = (e) => { const f = r.features[+el.dataset.i]; if (e.target.dataset.rel != null) return release(f.attributes); view.goTo({ target: new Point({ longitude: f.geometry.x, latitude: f.geometry.y }), zoom: 11 }); }));
    } catch (e) { $("zList").innerHTML = `<p class="hint">Couldn't load: ${esc(e.message)}</p>`; }
    const dl = $("dList");
    if (!has(C.core.declarations)) { dl.innerHTML = `<p class="hint">County declarations come from data/curated_detections.json until the declarations layer is connected.</p>`; return; }
    try {
      const d = await Q(C.core.declarations, { where: "status <> 'Withdrawn'", orderByFields: "declared DESC" });
      dl.innerHTML = d.features.length ? d.features.map((f) => `<div class="prow"><span class="tx"><b>${esc(f.attributes.county)}, ${esc(f.attributes.state)}</b><small>${fmtShort(f.attributes.declared)} · ${esc(f.attributes.status_text || "")}</small></span><button class="mini" data-w="${f.attributes.OBJECTID}">Withdraw</button></div>`).join("") : `<p class="hint">None.</p>`;
      dl.querySelectorAll("[data-w]").forEach((b) => (b.onclick = async () => { await edit(C.core.declarations, { updates: JSON.stringify([{ attributes: { OBJECTID: +b.dataset.w, status: "Withdrawn" } }]) }); ctx.audit("declaration:withdraw", b.dataset.w); ctx.paintCounties(); loaders.z(); }));
    } catch (e) { dl.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
  };

  // new infected premises → boundary → zones radiating from the boundary
  let picker = null, svm = null;
  ctx.on("pick", (mp) => { if (!picker) return false; const cb = picker; picker = null; cb(mp); return true; });
  function newPremises() {
    const year = new Date().getFullYear();
    sheet("New infected premises", `<div class="form">
      <p class="hint">1. Mark the premises. 2. Use its registered boundary or draw one. Zones are drawn outward from the boundary.</p>
      <div class="btns" style="margin:0"><button class="ghost" id="npPick" style="flex:1">1 · Mark premises</button><button class="ghost" id="npDraw" style="flex:1" disabled>2 · Draw boundary</button></div>
      <p class="hint" id="npWhere">Not marked yet.</p>
      <div class="two"><label>Premises ID<input id="npId" value="MD-${year}-${String(Math.floor(Math.random() * 900) + 100)}"></label><label>Confirmed<input id="npDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></label></div>
      <div class="two"><label>Flock type<select id="npFlock"><option>Commercial broiler</option><option>Commercial layer</option><option>Commercial turkey</option><option>Broiler breeder</option><option>Commercial duck</option><option>Backyard</option></select></label><label>Birds<input id="npBirds" type="number" min="0"></label></div>
      <div class="two"><label>Control area (miles)<input id="npCA" type="number" step="0.1" value="${H.mi(C.zones.controlKm)}"></label><label>Surveillance zone (miles)<input id="npSZ" type="number" step="0.1" value="${H.mi(C.zones.surveillanceKm)}"></label></div>
      <label class="lrow" style="padding:0"><input type="checkbox" id="npPub" class="tg" checked><span>Publish to the public map now</span></label>
      <button class="danger" id="npGo" disabled>Create premises and zones</button></div>`);
    let pt = null, boundary = null, farmId = null;
    $("npPick").onclick = () => { $("sheet").hidden = true; toast("Tap the premises (a farm dot or the map)"); picker = async (mp) => {
      $("sheet").hidden = false; pt = mp;
      const rg = ctx.registryAt ? await ctx.registryAt(mp) : null;
      if (rg) {
        boundary = rg.geometry; pt = rg.geometry.centroid; farmId = rg.attributes.farm_id; $("npId").value = rg.attributes.premises_id;
        if (rg.attributes.production_type) { const o = [...$("npFlock").options].find((x) => x.text.toLowerCase().includes(rg.attributes.production_type.toLowerCase().split(" ")[0])); if (o) $("npFlock").value = o.text; }
        if (rg.attributes.current_birds || rg.attributes.capacity) $("npBirds").value = rg.attributes.current_birds || rg.attributes.capacity;
        $("npWhere").textContent = `${rg.attributes.name || rg.attributes.premises_id} · registered boundary${rg.attributes.validation === "Validated" ? " (MDA validated)" : " (not yet validated)"}`;
        preview(); $("npDraw").disabled = false; $("npGo").disabled = false; return;
      }
      try { const r = await farms.queryFeatures({ geometry: mp, distance: 300, units: "meters", outFields: ["farm_id", "houses"], returnGeometry: true, outSpatialReference: { wkid: 102100 } }); if (r.features.length) { pt = r.features[0].geometry; farmId = r.features[0].attributes.farm_id; } } catch (e) {}
      const c = ctx.countyAt(pt); $("npWhere").textContent = `${c ? c.name + " County" : "Marked"}${farmId ? " · farm " + farmId : ""}. Draw the boundary, or keep the default (about 500 ft).`;
      boundary = ge.geodesicBuffer(pt, 0.15, "kilometers"); preview(); $("npDraw").disabled = false; $("npGo").disabled = false; }; };
    $("npDraw").onclick = () => {
      $("sheet").hidden = true; toast("Draw the premises boundary: tap corners, double-tap to finish", 5000);
      if (!svm) svm = new SketchViewModel({ view, layer: marks, polygonSymbol: { type: "simple-fill", color: [122, 15, 15, 0.35], outline: { color: [122, 15, 15, 1], width: 2 } } });
      svm.create("polygon");
      const h = svm.on("create", (e) => { if (e.state === "complete") { h.remove(); boundary = e.graphic.geometry; $("sheet").hidden = false; preview(); } else if (e.state === "cancel") { h.remove(); $("sheet").hidden = false; } });
    };
    function preview() {
      marks.removeAll();
      const ca = ge.geodesicBuffer(boundary, +$("npCA").value, "miles"), sz = ge.difference(ge.geodesicBuffer(boundary, +$("npSZ").value, "miles"), ca);
      marks.addMany([new Graphic({ geometry: sz, symbol: { type: "simple-fill", color: [217, 138, 0, 0.12], outline: { color: [217, 138, 0, 1], width: 1.5, style: "dash" } } }),
        new Graphic({ geometry: ca, symbol: { type: "simple-fill", color: [200, 40, 30, 0.22], outline: { color: [200, 40, 30, 1], width: 2 } } }),
        new Graphic({ geometry: boundary, symbol: { type: "simple-fill", color: [122, 15, 15, 0.6], outline: { color: [122, 15, 15, 1], width: 2 } } })]);
      view.goTo(ca.extent.expand(1.3)).catch(() => {});
    }
    $("npCA").onchange = $("npSZ").onchange = () => boundary && preview();
    $("npGo").onclick = async () => {
      $("npGo").disabled = true; $("npGo").textContent = "Creating…";
      const id = $("npId").value.trim(), when = Date.parse($("npDate").value + "T12:00:00"), c = ctx.countyAt(pt);
      const ca = ge.geodesicBuffer(boundary, +$("npCA").value, "miles"), sz = ge.difference(ge.geodesicBuffer(boundary, +$("npSZ").value, "miles"), ca);
      const g = (x) => x.toJSON();
      try {
        await edit(url.prem(), { adds: JSON.stringify([{ geometry: g(pt.type === "point" ? pt : boundary.centroid), attributes: { premises_id: id, county: c ? c.name : "", flock_type: $("npFlock").value, birds: +$("npBirds").value || null, status: "Active", confirmed_date: when, farm_id: farmId } }]) });
        await edit(url.perim(), { adds: JSON.stringify([{ geometry: g(boundary), attributes: { premises_id: id } }]) }).catch(() => {});
        await edit(url.zones(), { adds: JSON.stringify([
          { geometry: g(ca), attributes: { premises_id: id, zone_type: "Control Area", status: "Active", confirmed_date: when, created_date: Date.now() } },
          { geometry: g(sz), attributes: { premises_id: id, zone_type: "Surveillance Zone", status: "Active", confirmed_date: when, created_date: Date.now() } }]) });
        ctx.audit("premises:create", id, `${c ? c.name : ""} · control area ${$("npCA").value} mi · surveillance ${$("npSZ").value} mi`);
        const pub = $("npPub").checked; closeSheet(); marks.removeAll(); toast("Premises and zones created");
        ctx.buildOutbreakLayers(); loaders.z(); if (pub) publish();
      } catch (e) { $("npGo").disabled = false; $("npGo").textContent = "Create premises and zones"; toast("Couldn't create: " + e.message); }
    };
  }

  async function release(a) {
    if (!confirm(`Release ${a.premises_id}? Its control area and surveillance zone will be lifted.`)) return;
    try {
      const z = await Q(url.zones(), { where: `premises_id = '${a.premises_id.replace(/'/g, "''")}' AND status = 'Active'`, outFields: "OBJECTID" });
      await edit(url.zones(), { updates: JSON.stringify(z.features.map((f) => ({ attributes: { OBJECTID: f.attributes.OBJECTID, status: "Released", released_date: Date.now() } }))) });
      await edit(url.prem(), { updates: JSON.stringify([{ attributes: { OBJECTID: a.OBJECTID, status: "Released", released_date: Date.now() } }]) });
      ctx.audit("premises:release", a.premises_id); toast(a.premises_id + " released");
      ctx.buildOutbreakLayers(); loaders.z(); publish(a);
    } catch (e) { toast("Couldn't release: " + e.message); }
  }

  // county declared by MDA (before zones exist): mild county tint for everyone
  function declare() {
    sheet("Declare a county", `<div class="form"><p class="hint">Use this when MDA announces a detection before the control area is drawn. The county gets a mild tint on the public map.</p>
      <button class="ghost" id="dcPick">Tap the county on the map</button><p class="hint" id="dcWhere">No county yet.</p>
      <label>Announced<input type="date" id="dcDate" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label>Status shown to the public<select id="dcSt"><option>Preliminary positive. USDA confirmation pending.</option><option>Confirmed by USDA.</option><option>Under investigation.</option></select></label>
      <label>MDA announcement link<input id="dcUrl" type="url" placeholder="https://news.maryland.gov/mda/…"></label>
      <button class="danger" id="dcGo" disabled>Declare</button></div>`);
    let cty = null;
    $("dcPick").onclick = () => { $("sheet").hidden = true; picker = (mp) => { $("sheet").hidden = false; cty = ctx.countyAt(mp); $("dcWhere").textContent = cty ? `${cty.name} County, ${cty.state}` : "Not a Delmarva county"; $("dcGo").disabled = !cty; }; };
    $("dcGo").onclick = async () => {
      if (!has(C.core.declarations)) return toast("County declarations are unavailable right now. Try again shortly.");
      try {
        await edit(C.core.declarations, { adds: JSON.stringify([{ geometry: cty.geom.toJSON(), attributes: { county: cty.name, state: cty.state, declared: Date.parse($("dcDate").value + "T12:00:00"), status: "Declared", status_text: $("dcSt").value, source_url: $("dcUrl").value } }]) });
        ctx.audit("declaration:add", cty.name + ", " + cty.state, $("dcSt").value); closeSheet(); toast(cty.name + " County declared"); ctx.buildOutbreakLayers();
      } catch (e) { toast("Couldn't declare: " + e.message); }
    };
  }

  // ---------------- publish the public map (merged areas + approximate markers, with a privacy check) ----------------
  async function publish(released) {
    if (!has(C.core.pubAreas) || !has(C.core.pubMarkers)) return toast("The public map can't be updated right now. Try again shortly.");
    toast("Publishing public map…");
    try {
      const [zr, pr] = await Promise.all([
        Q(url.zones(), { where: "status = 'Active'", returnGeometry: true, outSR: 102100 }),
        Q(url.prem(), { where: "status = 'Active'", returnGeometry: true, outSR: 102100 })]);
      const geom = (f) => Polygon.fromJSON(Object.assign({ spatialReference: { wkid: 102100 } }, f.geometry));
      const caF = zr.features.filter((f) => f.attributes.zone_type === "Control Area"), szF = zr.features.filter((f) => f.attributes.zone_type === "Surveillance Zone");
      const since = {}; pr.features.forEach((f) => (since[f.attributes.premises_id] = f.attributes.confirmed_date));
      const parts = (g) => (g ? g.rings.map((r) => new Polygon({ rings: [r], spatialReference: g.spatialReference })) : []);   // split merged area into pieces (outer rings)
      const caU = caF.length ? ge.union(caF.map(geom)) : null, szU = szF.length ? ge.difference(ge.union(szF.map(geom).concat(caU ? [caU] : [])), caU || new Polygon({ rings: [], spatialReference: { wkid: 102100 } })) : null;
      const pieces = (U, type, src) => (U ? [U] : []).map((g) => {
        const members = src.filter((f) => ge.intersects(g, geom(f))), t = Math.min(...members.map((f) => since[f.attributes.premises_id] || f.attributes.confirmed_date || Date.now()));
        const c = ctx.countyAt(g.centroid || g.extent.center);
        return { geometry: g.toJSON(), attributes: { zone_type: type, status: "Active", since: t, county: c ? c.name : "", premises_count: members.length, sample: members.length && members.every((f) => f.attributes.sample === 1) ? 1 : 0 } };
      });
      const adds = pieces(caU, "Control Area", caF).concat(pieces(szU, "Surveillance Zone", szF));
      // approximate markers + re-identification check
      const P = C.privacy, report = [], markers = [];
      for (const f of pr.features) {
        const p = new Point({ x: f.geometry.x, y: f.geometry.y, spatialReference: { wkid: 102100 } });
        const ca = caF.find((z) => z.attributes.premises_id === f.attributes.premises_id);
        let best = null;
        if (!P.markerShiftKm[1]) best = { m: p, n: await farms.queryFeatureCount({ geometry: p, distance: P.markerRadiusKm, units: "kilometers" }).catch(() => 0) };
        for (let k = 0; k < 12 && P.markerShiftKm[1]; k++) {
          const d = (P.markerShiftKm[0] + Math.random() * (P.markerShiftKm[1] - P.markerShiftKm[0])) * 1000, a = Math.random() * 2 * Math.PI;
          const m = new Point({ x: p.x + d * Math.cos(a) / Math.cos(wmu.webMercatorToGeographic(p).latitude * Math.PI / 180), y: p.y + d * Math.sin(a) / Math.cos(wmu.webMercatorToGeographic(p).latitude * Math.PI / 180), spatialReference: { wkid: 102100 } });
          if (ca && !ge.contains(geom(ca), m)) continue;
          const n = (await farms.queryFeatureCount({ geometry: m, distance: P.markerRadiusKm, units: "kilometers" }).catch(() => null));
          if (!best || (n || 0) > best.n) best = { m, n: n || 0 };
          if ((n || 0) >= P.minFarmsNearMarker) break;
        }
        const solo = ca && caF.filter((z) => ge.intersects(geom(z), geom(ca))).length === 1;
        report.push({ id: f.attributes.premises_id, farms: best ? best.n : 0, ok: best && best.n >= P.minFarmsNearMarker, solo });
        if (best) markers.push({ geometry: best.m.toJSON(), attributes: { status: "Active", since: f.attributes.confirmed_date, county: f.attributes.county, area_km: P.markerRadiusKm, sample: f.attributes.sample === 1 ? 1 : 0 } });
      }
      // replace public features
      const clear = async (u) => { const ids = (await ctx.rest(u + "/query", { where: "status = 'Active'", returnIdsOnly: true })).objectIds || []; if (ids.length) await edit(u, { deletes: ids.join(",") }); };
      await clear(C.core.pubAreas); await clear(C.core.pubMarkers);
      if (adds.length) await edit(C.core.pubAreas, { adds: JSON.stringify(adds) });
      if (markers.length) await edit(C.core.pubMarkers, { adds: JSON.stringify(markers) });
      if (released && has(C.core.history)) {
        const z = await Q(url.zones(), { where: `premises_id = '${released.premises_id.replace(/'/g, "''")}' AND zone_type = 'Control Area'`, returnGeometry: true, outSR: 102100 }).catch(() => ({ features: [] }));
        if (z.features[0]) await edit(C.core.history, { adds: JSON.stringify([{ geometry: z.features[0].geometry, attributes: { start_date: released.confirmed_date, end_date: Date.now(), county: released.county, sample: 0 } }]) }).catch(() => {});
      }
      ctx.audit("public:publish", `${adds.length} areas, ${markers.length} markers`, JSON.stringify(report));
      ctx.buildOutbreakLayers();
      sheet("Public map updated", `<div class="form"><p class="hint">${adds.length} merged area(s) and ${markers.length} approximate marker(s) are live.</p>
        <h4 style="margin:6px 0">Privacy check</h4>${report.map((r) => `<div class="prow"><span class="tx"><b>${esc(r.id)}</b><small>${r.farms} farms inside the marker area${r.solo ? " · single premises in its control area: its center can be estimated" : ""}</small></span><span class="pill ${r.ok && !r.solo ? "green" : "amber"}">${r.ok && !r.solo ? "OK" : "Review"}</span></div>`).join("") || `<p class="hint">No active premises.</p>`}
        <p class="hint">A control area around a single premises can reveal the farm's approximate position. Consider waiting for nearby zones to merge, or tint the county only.</p></div>`);
    } catch (e) { toast("Couldn't publish: " + e.message); }
  }

  // ---------------- premises inside each zone + biosecurity status ----------------
  let bio = {};
  async function loadBio() {
    bio = {};
    if (!has(C.core.biosecurity)) return;
    try { (await Q(C.core.biosecurity, { orderByFields: "audit_date DESC", resultRecordCount: 4000 })).features.forEach((f) => { const a = f.attributes; if (!bio[a.farm_id]) bio[a.farm_id] = a; }); } catch (e) {}
  }
  const bioPill = (fid) => { const b = bio[fid]; if (!b) return `<span class="pill">No audit</span>`; const old = Date.now() - b.audit_date > 365 * DAY; return `<span class="pill ${b.passed ? (old ? "amber" : "green") : "red"}">${b.passed ? (old ? "Audit overdue" : "Passed " + fmtShort(b.audit_date)) : "Failed " + fmtShort(b.audit_date)}</span>`; };
  let prSub = "reg";
  loaders.pr = () => {
    const pane = $("pane-pr");
    pane.innerHTML = `<div class="seg" id="prSeg"><button data-s="reg">Registry</button><button data-s="zones">In zones</button></div><div id="prBody"></div>`;
    pane.querySelectorAll("#prSeg button").forEach((b) => { b.classList.toggle("on", b.dataset.s === prSub); b.onclick = () => { prSub = b.dataset.s; loaders.pr(); }; });
    if (prSub === "reg" && ctx.registryPane) ctx.registryPane($("prBody")); else inZones($("prBody"));
  };
  async function inZones(box) {
    box.innerHTML = `<p class="hint">Counting farms in each zone…</p>`;
    await loadBio();
    try {
      const z = await Q(url.zones(), { where: "status = 'Active'", returnGeometry: true, outSR: 102100 });
      const out = []; let all = [];
      for (const f of z.features) {
        const g = Polygon.fromJSON(Object.assign({ spatialReference: { wkid: 102100 } }, f.geometry));
        const r = await farms.queryFeatures({ geometry: g, outFields: ["*"], returnGeometry: true, outSpatialReference: { wkid: 4326 } }).catch(() => ({ features: [] }));
        const houses = r.features.reduce((s, x) => s + (x.attributes.houses || 0), 0);
        out.push({ a: f.attributes, n: r.features.length, houses, list: r.features });
        all = all.concat(r.features.map((x) => ({ zone: f.attributes.zone_type, premises: f.attributes.premises_id, farm_id: x.attributes.farm_id, houses: x.attributes.houses, lon: x.geometry.x.toFixed(5), lat: x.geometry.y.toFixed(5), audit: bio[x.attributes.farm_id] ? (bio[x.attributes.farm_id].passed ? "passed" : "failed") + " " + new Date(bio[x.attributes.farm_id].audit_date).toISOString().slice(0, 10) : "none" })));
      }
      box.innerHTML = `<div class="qtools"><button class="mini" id="prCsv">Export all (CSV)</button></div>` + (out.length ? out.map((o, i) => `<div class="prow" style="display:block"><div style="display:flex;justify-content:space-between;align-items:center"><span class="tx"><b>${esc(o.a.premises_id)} · ${esc(o.a.zone_type)}</b><small>${o.n} farms · ${o.houses} houses</small></span><button class="mini" data-x="${i}">List</button></div><div id="prl-${i}" hidden></div></div>`).join("") : `<p class="hint">No active zones.</p>`);
      $("prCsv").onclick = () => csv(all, "hpai_premises_in_zones.csv");
      box.querySelectorAll("[data-x]").forEach((b) => (b.onclick = () => {
        const o = out[+b.dataset.x], el = $("prl-" + b.dataset.x); el.hidden = !el.hidden; if (el.hidden) return;
        el.innerHTML = o.list.slice(0, 200).map((x, j) => `<div class="prow" data-j="${j}"><span class="tx"><b>Farm ${esc(x.attributes.farm_id)}</b><small>${x.attributes.houses || "?"} houses</small></span>${bioPill(x.attributes.farm_id)}</div>`).join("");
        el.querySelectorAll(".prow").forEach((r) => (r.onclick = () => { const x = o.list[+r.dataset.j]; view.goTo({ target: x.geometry, zoom: 14 }); }));
      }));
    } catch (e) { box.innerHTML = `<p class="hint">Couldn't count: ${esc(e.message)}</p>`; }
  }

  async function farmCard(g, pt) {
    await loadBio(); const a = g.attributes, b = bio[a.farm_id];
    const z = await ctx.zoneAt(g.geometry), v = await visitsNear(g.geometry, 14);
    const el = ctx.simpleCard(pt, z.zone === "control" ? "ca" : z.zone === "surveillance" ? "sz" : "info", "Poultry farm (estimated)", "Farm " + a.farm_id,
      [["Houses", a.houses], ["Zone", z.zone ? (z.zone === "control" ? "Control area" : "Surveillance zone") : "None"], ["Biosecurity audit", b ? `${b.passed ? "Passed" : "Not passed"} · ${fmtShort(b.audit_date)}` : "None on record"], ["Vehicle visits, 14 d", `${v.all} (${v.zone} from a control area)`]],
      `<button class="cta" id="fcAudit">Record a biosecurity audit</button>`);
    el.querySelector("#fcAudit").onclick = () => auditForm(a.farm_id);
  }
  function auditForm(fid) {
    sheet("Biosecurity audit · farm " + fid, `<div class="form"><div class="two"><label>Date<input type="date" id="baD" value="${new Date().toISOString().slice(0, 10)}"></label><label>Auditor<input id="baBy" value="${esc(S.user.fullName || S.user.username)}"></label></div>
      <div class="seg" id="baR"><button data-v="1" class="on">Passed</button><button data-v="0">Not passed</button></div><label>Notes<textarea id="baN" rows="3"></textarea></label><button class="primary" id="baGo">Save audit</button></div>`);
    let passed = 1; document.querySelectorAll("#baR button").forEach((x) => (x.onclick = () => { passed = +x.dataset.v; document.querySelectorAll("#baR button").forEach((y) => y.classList.toggle("on", y === x)); }));
    $("baGo").onclick = async () => {
      if (!has(C.core.biosecurity)) return toast("Audit records are unavailable right now. Try again shortly.");
      try { await edit(C.core.biosecurity, { adds: JSON.stringify([{ attributes: { farm_id: fid, audit_date: Date.parse($("baD").value + "T12:00:00"), passed, auditor: $("baBy").value, notes: $("baN").value } }]) }); ctx.audit("biosecurity:add", fid, passed ? "passed" : "not passed"); closeSheet(); toast("Audit saved"); }
      catch (e) { toast("Couldn't save: " + e.message); }
    };
  }
  async function premCard(a, pt) {
    ctx.simpleCard(pt, "prem", "Infected premises · MDA only", a.premises_id, [["County", a.county], ["Flock", a.flock_type], ["Birds", a.birds], ["Confirmed", fmtDate(a.confirmed_date)], ["Status", a.status]],
      `<div class="btns"><button class="ghost" id="pcTr" style="flex:1">Trace movements</button></div>`).querySelector("#pcTr").onclick = () => { open("tr"); trace(a); };
  }

  // ---------------- movement tracing ----------------
  async function visitsNear(geom, days, since) {
    if (!has(C.movementMda.visits)) return { all: 0, zone: 0, list: [] };
    const g = geom.spatialReference && geom.spatialReference.isWGS84 ? geom : wmu.webMercatorToGeographic(geom);
    try {
      const r = await ctx.rest(C.movementMda.visits + "/query", { geometry: JSON.stringify({ x: g.x, y: g.y, spatialReference: { wkid: 4326 } }), geometryType: "esriGeometryPoint", distance: 1000, units: "esriSRUnit_Meter",
        where: `visited >= ${since || Date.now() - days * DAY}`, outFields: "*", returnGeometry: true, outSR: 4326 });
      return { all: r.features.length, zone: r.features.filter((f) => f.attributes.from_zone === 1).length, list: r.features };
    } catch (e) { return { all: 0, zone: 0, list: [] }; }
  }
  loaders.tr = async () => {
    const box = $("pane-tr");
    box.innerHTML = `<p class="hint">Pick an infected premises to see every logged visit and permitted trip in the 21 days before confirmation, and where those vehicles went next.</p><label class="form"><select id="trSel"><option>Loading…</option></select></label><div id="trOut"></div>`;
    try {
      const r = await Q(url.prem(), { orderByFields: "confirmed_date DESC", returnGeometry: true, outSR: 4326 });
      $("trSel").innerHTML = `<option value="">Choose premises</option>` + r.features.map((f, i) => `<option value="${i}">${esc(f.attributes.premises_id)} · ${esc(f.attributes.county)} · ${fmtShort(f.attributes.confirmed_date)}</option>`).join("");
      $("trSel").onchange = () => { const f = r.features[+$("trSel").value]; if (f) trace(Object.assign({ _g: f.geometry }, f.attributes)); };
    } catch (e) { $("trSel").innerHTML = `<option>${esc(e.message)}</option>`; }
  };
  async function trace(a) {
    const out = $("trOut") || $("pane-tr"); out.innerHTML = `<p class="hint">Tracing…</p>`;
    let g = a._g; if (!g) { const r = await Q(url.prem(), { where: `premises_id = '${a.premises_id.replace(/'/g, "''")}'`, returnGeometry: true, outSR: 4326 }); g = r.features[0].geometry; }
    const pt = new Point({ longitude: g.x, latitude: g.y }), from = a.confirmed_date - 21 * DAY;
    const v = await visitsNear(pt, 0, from);
    let trips = [];
    if (has(C.movementMda.permits)) {
      try { const r = await ctx.rest(C.movementMda.permits + "/query", { geometry: JSON.stringify({ x: g.x, y: g.y, spatialReference: { wkid: 4326 } }), geometryType: "esriGeometryPoint", distance: 1000, units: "esriSRUnit_Meter", where: `depart >= ${from}`, outFields: "*", returnGeometry: true, outSR: 4326 }); trips = r.features; } catch (e) {}
    }
    // where did those vehicles go next? (later visits by the same accounts)
    const who = [...new Set(v.list.map((f) => f.attributes.Creator).concat(trips.map((f) => f.attributes.Creator)).filter(Boolean))];
    let next = [];
    if (who.length && has(C.movementMda.visits)) {
      try { const r = await ctx.rest(C.movementMda.visits + "/query", { where: `Creator IN (${who.map((w) => `'${w.replace(/'/g, "''")}'`).join(",")}) AND visited >= ${from}`, outFields: "*", returnGeometry: true, outSR: 4326 });
        next = r.features.filter((f) => ge.distance(new Point({ longitude: f.geometry.x, latitude: f.geometry.y }), pt, "kilometers") > 1); } catch (e) {}
    }
    marks.removeAll();
    marks.add(new Graphic({ geometry: pt, symbol: { type: "simple-marker", style: "diamond", size: 18, color: [122, 15, 15, 1], outline: { color: [255, 255, 255, 1], width: 2 } } }));
    trips.forEach((f) => marks.add(new Graphic({ geometry: { type: "polyline", paths: f.geometry.paths, spatialReference: { wkid: 4326 } }, symbol: { type: "simple-line", color: BLUE.concat(0.9), width: 3 } })));
    next.forEach((f) => { const q = new Point({ longitude: f.geometry.x, latitude: f.geometry.y }); marks.addMany([new Graphic({ geometry: { type: "polyline", paths: [[[g.x, g.y], [f.geometry.x, f.geometry.y]]], spatialReference: { wkid: 4326 } }, symbol: { type: "simple-line", color: [230, 90, 30, 0.9], width: 2, style: "dash" } }), new Graphic({ geometry: q, symbol: { type: "simple-marker", size: 11, color: [230, 90, 30, 1], outline: { color: [255, 255, 255, 1], width: 2 } } })]); });
    if (marks.graphics.length) view.goTo(marks.graphics.toArray(), { padding: 60 }).catch(() => {});
    const rows = [];
    v.list.forEach((f) => rows.push({ type: "visit", who: f.attributes.Creator || "", when: f.attributes.visited, commodity: f.attributes.commodity || "", from_zone: f.attributes.from_zone ? "yes" : "no" }));
    trips.forEach((f) => rows.push({ type: "permit", who: f.attributes.Creator || f.attributes.company || "", when: f.attributes.depart, commodity: f.attributes.commodity, id: f.attributes.permit_id, phone: f.attributes.phone }));
    next.forEach((f) => rows.push({ type: "next stop", who: f.attributes.Creator || "", when: f.attributes.visited, lon: f.geometry.x.toFixed(5), lat: f.geometry.y.toFixed(5) }));
    out.innerHTML = `<div class="kv"><div><b>${v.all}</b><span>visits (21 d)</span></div><div><b>${trips.length}</b><span>permitted trips</span></div><div><b>${who.length}</b><span>vehicles / accounts</span></div><div><b>${next.length}</b><span>later stops to check</span></div></div>
      ${rows.map((r) => `<div class="prow"><span class="tx"><b>${esc(r.type)} · ${esc(r.who)}</b><small>${fmtTime(r.when)} ${r.commodity ? "· " + esc(r.commodity) : ""} ${r.phone ? "· " + esc(r.phone) : ""}</small></span></div>`).join("") || `<p class="hint">No logged movements near this premises.</p>`}
      <div class="qtools" style="margin-top:8px"><button class="mini" id="trCsv">Export CSV</button></div>`;
    $("trCsv").onclick = () => csv(rows, `trace_${a.premises_id}.csv`);
    ctx.audit("trace", a.premises_id, `${v.all} visits, ${trips.length} trips, ${next.length} next stops`);
  }

  // ---------------- audit log ----------------
  loaders.au = async () => {
    const box = $("pane-au");
    if (!has(C.core.audit)) { box.innerHTML = `<p class="hint">The audit log is unavailable right now.</p>`; return; }
    try {
      const r = await Q(C.core.audit, { orderByFields: "at DESC", resultRecordCount: 150 });
      box.innerHTML = `<div class="qtools"><button class="mini" id="auCsv">Export CSV</button></div>` + (r.features.map((f) => f.attributes).map((a) => `<div class="prow"><span class="tx"><b>${esc(a.action)} · ${esc(a.target)}</b><small>${fmtTime(a.at)} · ${esc(a.who)}${a.details ? " · " + esc(a.details).slice(0, 140) : ""}</small></span></div>`).join("") || `<p class="hint">No entries yet.</p>`);
      $("auCsv").onclick = () => csv(r.features.map((f) => f.attributes), "hpai_audit_log.csv");
    } catch (e) { box.innerHTML = `<p class="hint">Couldn't load: ${esc(e.message)}</p>`; }
  };

  // ---------------- permit verification (QR scan opens #verify=ID) ----------------
  ctx.actions.verify = async (id) => {
    if (!ctx.isStaff()) return sheet("Permit " + id, `<p class="hint">Sign in as MDA staff to verify this permit.</p>`);
    try {
      const r = await Q(C.movementMda.permits, { where: `permit_id = '${id.replace(/'/g, "''")}'`, returnGeometry: true, outSR: 4326 });
      const p = r.features[0] && r.features[0].attributes; if (!p) return sheet("Permit " + id, `<p class="hint">Not found.</p>`);
      const ok = p.status === "Approved" && p.valid_to >= Date.now();
      sheet("Permit " + id, `<div class="form"><div class="pop"><div class="band ${ok ? "free" : "ca"}"><small>Verification</small><b>${ok ? "Valid" : p.status === "Approved" ? "Expired" : esc(p.status)}</b></div></div>
        <div class="rres" style="margin:0"><div class="rule">${H.icon("a")}<span>${esc(p.origin)}</span></div><div class="rule">${H.icon("b")}<span>${esc(p.destination)}</span></div><div class="rule">${H.icon("date")}<span>${fmtDate(p.depart)} – ${fmtDate(p.valid_to)}</span></div><div class="rule">${H.icon("truck")}<span>${esc(p.company)} · ${esc(p.driver)} · ${esc(p.plate)}</span></div></div></div>`);
      ctx.audit("permit:verify", id, ok ? "valid" : p.status);
      if (r.features[0].geometry) { marks.removeAll(); marks.add(new Graphic({ geometry: { type: "polyline", paths: r.features[0].geometry.paths, spatialReference: { wkid: 4326 } }, symbol: { type: "simple-line", color: BLUE.concat(1), width: 4 } })); }
    } catch (e) { toast("Couldn't verify: " + e.message); }
  };

  // MDA extra in the click card: farms around this spot
  ctx.on("card", ({ pt }) => (ctx.isStaff() ? `<button class="pb" data-act="declareHere">Declare county</button><button class="pb" data-act="newHere">New premises</button>` : ""));
  ctx.actions.declareHere = () => declare();
  ctx.actions.newHere = () => newPremises();
});
