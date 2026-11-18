/* Maryland HPAI map: public + industry tools.
 * My places with alerts (in the browser, plus optional email alerts), dead wild bird reports with photos,
 * suspected flock reports, access requests, and the grower farm risk score.
 */
window.HPAI.modules.push(function (ctx) {
  const { H, C, R, S, view } = ctx, { $, esc, DAY, fmtDate, fmtShort, toast, store, sheet, closeSheet, shrinkImage } = H;
  const { Graphic, Point, wmu } = ctx.esri;

  // ================= My places + alerts =================
  let places = store.get("places", []);
  const save = () => store.set("places", places);
  const ptOf = (p) => new Point({ longitude: p.lon, latitude: p.lat });

  async function statusOf(p) {
    const pt = ptOf(p), z = await ctx.zoneAt(pt), d = ctx.distToArea(pt);
    const cty = ctx.countyAt(wmu.geographicToWebMercator(pt)), aff = cty && S.affected.find((a) => a.county === cty.name && a.state === cty.state);
    const wild = ctx.wildNear(pt, 10, 28).length;
    const flags = [];
    if (z.zone === "control") flags.push(["red", "In control area"]);
    else if (z.zone === "surveillance") flags.push(["amber", "In surveillance zone"]);
    else if (d != null && d <= 10) flags.push(["amber", `Control area ${H.mi(d, 0)} mi away`]);
    if (aff && !z.zone) flags.push(["red", "HPAI in county"]);
    if (wild) flags.push(["teal", `${wild} wild bird${wild > 1 ? "s" : ""} nearby`]);
    return { zone: z.zone, dist: d, aff: !!aff, wild, flags, key: flags.map((f) => f[1]).join("|") };
  }
  async function renderPlaces() {
    const box = $("places");
    if (!places.length) { box.innerHTML = `<p class="hint">Save your farm or home to get alerts.</p>`; renderRisk(); return; }
    const seen = store.get("placeSeen", {});
    const rows = await Promise.all(places.map(async (p) => ({ p, s: await statusOf(p) })));
    let fresh = 0;
    const many = rows.length > 6 && !S.placesAll;
    box.innerHTML = rows.map(({ p, s }, i) => {
      if (many && i >= 5) { const isNew = s.key && seen[p.id] !== s.key; if (isNew) fresh++; return ""; }
      const isNew = s.key && seen[p.id] !== s.key; if (isNew) fresh++;
      const pill = s.flags.length ? s.flags.map(([c, t]) => `<span class="pill ${c}">${esc(t)}</span>`).join(" ") : `<span class="pill green">All clear</span>`;
      return `<div class="place" data-id="${p.id}"><span class="ic">${H.icon(p.kind === "farm" ? "farm" : "home")}</span><span class="tx"><b>${esc(p.name)}${isNew ? ' <span class="pill red">New</span>' : ""}</b><small>${pill}</small></span><button class="mini" data-del="${p.id}" aria-label="Remove">✕</button></div>`;
    }).join("");
    if (rows.length > 6) {
      box.insertAdjacentHTML("beforeend", `<button class="link" id="plAll" style="font-size:14px;margin-top:6px">${S.placesAll ? "Show fewer" : `Show all ${rows.length} places`}</button>`);
      $("plAll").onclick = () => { S.placesAll = !S.placesAll; renderPlaces(); };
    }
    if (fresh) toast(`Alert: ${fresh} of your places has a new status`, 5000);
    rows.forEach(({ p, s }) => (seen[p.id] = s.key)); store.set("placeSeen", seen);
    box.querySelectorAll(".place").forEach((el) => (el.onclick = (e) => {
      if (e.target.dataset.del) { places = places.filter((x) => x.id !== e.target.dataset.del); save(); renderPlaces(); return; }
      const p = places.find((x) => x.id === el.dataset.id); view.goTo({ target: ptOf(p), zoom: 12 }); ctx.locationCard(ptOf(p), p.name); ctx.sheetPeek();
    }));
    renderRisk();
  }
  ["areas", "affected", "wild", "ws"].forEach((ev) => ctx.on(ev, () => renderPlaces()));

  function addPlace(pt, name) {
    const g = pt ? (pt.spatialReference.isWGS84 ? pt : wmu.webMercatorToGeographic(pt)) : null;
    const body = sheet("Save a place", `<div class="form">
      <label>Address<div id="plSearch"></div></label>
      <label>Name<input id="plName" placeholder="e.g. Home farm" value="${esc(name && name !== "This location" ? name : "")}"></label>
      <div class="seg" id="plKind"><button data-k="farm" class="${S.ws !== "public" ? "on" : ""}">Farm / premises</button><button data-k="home" class="${S.ws === "public" ? "on" : ""}">Home / other</button></div>
      <p class="hint" id="plWhere">${g ? `Location set (${g.latitude.toFixed(4)}, ${g.longitude.toFixed(4)})` : "Type an address, or close this and tap the map."}</p>
      <button class="primary" id="plSave" ${g ? "" : "disabled"}>Save place</button>
      <p class="hint">Saved on this device only. For email alerts use “Email alerts”.</p></div>`);
    let loc = g, kind = S.ws !== "public" ? "farm" : "home";
    ctx.makeSearch("plSearch", "Start typing an address", (geom, nm) => { loc = geom.spatialReference.isWGS84 ? geom : wmu.webMercatorToGeographic(geom); $("plWhere").textContent = nm; if (!$("plName").value) $("plName").value = nm.split(",")[0]; $("plSave").disabled = false; });
    body.querySelectorAll("#plKind button").forEach((b) => (b.onclick = () => { kind = b.dataset.k; body.querySelectorAll("#plKind button").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("plSave").onclick = () => {
      places.push({ id: H.uid("P"), name: $("plName").value.trim() || "My place", lon: +loc.longitude.toFixed(5), lat: +loc.latitude.toFixed(5), kind });
      save(); closeSheet(); renderPlaces(); toast("Saved. You'll see alerts here when its status changes.");
    };
  }
  $("addPlace").onclick = () => addPlace();
  $("importPlaces").onclick = () => importFarms();
  ctx.actions.importFarms = () => importFarms();
  ctx.actions.savePlace = (pt, name) => addPlace(pt, name);
  ctx.on("card", ({ pt }) => S.ws === "regulator" ? "" : `<button class="pb" data-act="savePlace">☆ Save</button>`);

  // ---- email alerts (subscription stored in a create-only layer; emails sent by the twice-daily job) ----
  ctx.actions.alerts = () => {
    const first = places[0];
    sheet("Email alerts", `<div class="form">
      <p class="hint">We'll email you when a control area, an HPAI detection in the county, or a wild-bird detection comes near your place.</p>
      <label>Email<input id="alEmail" type="email" autocomplete="email" placeholder="you@example.com"></label>
      <label>Place<div id="alSearch"></div></label>
      <p class="hint" id="alWhere">${first ? "Using: " + esc(first.name) : "Type your address."}</p>
      <label>Alert me within<select id="alKm"><option value="4.828">3 miles</option><option value="9.656" selected>6 miles</option><option value="19.312">12 miles</option></select></label>
      <button class="primary" id="alGo" ${first ? "" : "disabled"}>Subscribe</button>
      <p class="hint">Only MDA can read your email. Every alert has a link to unsubscribe.</p></div>`);
    let loc = first ? { longitude: first.lon, latitude: first.lat } : null;
    ctx.makeSearch("alSearch", "Your address", (geom, nm) => { loc = geom.spatialReference.isWGS84 ? geom : wmu.webMercatorToGeographic(geom); $("alWhere").textContent = nm; $("alGo").disabled = false; });
    $("alGo").onclick = async () => {
      const email = $("alEmail").value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast("Enter a valid email");
      if (!ctx.has(C.submit.alerts)) return toast(`Email alerts are temporarily unavailable. Call MDA at ${C.mdaPhone}.`);
      $("alGo").disabled = true;
      try {
        await ctx.rest(C.submit.alerts + "/addFeatures", { features: JSON.stringify([{ geometry: { x: loc.longitude, y: loc.latitude, spatialReference: { wkid: 4326 } },
          attributes: { email, radius_km: +$("alKm").value, action: "subscribe", token: H.uid("U"), created: Date.now() } }]) }, { anon: true });
        closeSheet(); toast("Subscribed. Check your inbox for alerts.");
      } catch (e) { $("alGo").disabled = false; toast("Couldn't subscribe: " + e.message); }
    };
  };
  // unsubscribe link from the email: #unsub=<token>
  if (location.hash.startsWith("#unsub=") && ctx.has(C.submit.alerts)) {
    const token = decodeURIComponent(location.hash.slice(7));
    ctx.rest(C.submit.alerts + "/addFeatures", { features: JSON.stringify([{ geometry: { x: -76.6, y: 39, spatialReference: { wkid: 4326 } }, attributes: { action: "unsubscribe", token, created: Date.now() } }]) }, { anon: true })
      .then(() => toast("You're unsubscribed from HPAI email alerts.", 6000)).catch(() => toast("Couldn't unsubscribe. Please contact MDA."));
  }

  // ================= reports (photo) =================
  let picking = null;
  ctx.on("pick", (mp) => { if (!picking) return false; const cb = picking; picking = null; cb(mp); return true; });

  function reportForm(type) {
    const wildR = type === "wild_bird";
    const body = sheet(wildR ? "Report a dead wild bird" : "Report a sick flock", `<div class="form">
      ${wildR ? `<p class="hint">Don't touch the bird. A photo from a distance helps.</p>` : `<p class="hint"><b>If birds are dying now, call MDA: ${esc(C.mdaPhone)}.</b> This form helps MDA follow up.</p>`}
      <label>Where<div id="rpSearch"></div></label>
      <div class="btns" style="margin:0"><button class="ghost" id="rpPick">Pick on map</button><button class="ghost" id="rpHere">Use my location</button></div>
      <p class="hint" id="rpWhere">No location yet.</p>
      ${wildR ? `<div class="two"><label>Kind of bird<select id="rpSp"><option>Duck or goose</option><option>Swan</option><option>Gull</option><option>Hawk, eagle or owl</option><option>Vulture</option><option>Other / not sure</option></select></label>
        <label>How many<input id="rpN" type="number" min="1" value="1"></label></div>`
      : `<div class="two"><label>Flock type<select id="rpSp"><option>Broiler</option><option>Layer</option><option>Turkey</option><option>Breeder</option><option>Duck</option><option>Backyard</option></select></label>
        <label>Birds sick or dead<input id="rpN" type="number" min="1" value="10"></label></div>`}
      <label>When seen<input id="rpWhen" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label>Photo<div class="drop" id="rpDrop">Tap to add a photo</div><input type="file" id="rpFile" accept="image/*" capture="environment" hidden></label>
      <label>Notes<textarea id="rpNote" rows="2" placeholder="${wildR ? "e.g. near the pond, more birds nearby" : "Signs: deaths, drop in eggs or water use, swelling"}"></textarea></label>
      <div class="two"><label>Your name<input id="rpName" autocomplete="name"></label><label>Phone<input id="rpPhone" type="tel" autocomplete="tel"></label></div>
      <button class="primary" id="rpGo" disabled>Send report</button></div>`);
    let loc = null, blob = null;
    const setLoc = (g, label) => { loc = g.spatialReference && !g.spatialReference.isWGS84 ? wmu.webMercatorToGeographic(g) : g; $("rpWhere").textContent = label || `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`; $("rpGo").disabled = false; };
    ctx.makeSearch("rpSearch", "Address or place", (g, nm) => setLoc(g, nm));
    $("rpPick").onclick = () => { $("sheet").hidden = true; toast("Tap the map where you saw it"); picking = (mp) => { $("sheet").hidden = false; setLoc(mp); }; };
    $("rpHere").onclick = () => navigator.geolocation && navigator.geolocation.getCurrentPosition((p) => setLoc(new Point({ longitude: p.coords.longitude, latitude: p.coords.latitude }), "Your location"), () => toast("Location not available"));
    $("rpDrop").onclick = () => $("rpFile").click();
    $("rpFile").onchange = async () => { const f = $("rpFile").files[0]; if (!f) return; try { blob = await shrinkImage(f); $("rpDrop").innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="Photo">`; } catch (e) { toast(e.message); } };
    $("rpGo").onclick = async () => {
      if (!ctx.has(C.submit.reports)) return toast(`Online reporting is temporarily unavailable. Please call MDA at ${C.mdaPhone}.`);
      $("rpGo").disabled = true; $("rpGo").textContent = "Sending…";
      try {
        const r = await ctx.rest(C.submit.reports + "/addFeatures", { features: JSON.stringify([{ geometry: { x: loc.longitude, y: loc.latitude, spatialReference: { wkid: 4326 } }, attributes: {
          report_type: type, species: $("rpSp").value, count: +$("rpN").value || 1, observed: Date.parse($("rpWhen").value + "T12:00:00"), description: $("rpNote").value.slice(0, 1000),
          name: $("rpName").value.slice(0, 100), phone: $("rpPhone").value.slice(0, 40), reporter: S.user ? S.user.username : "", status: "New", created: Date.now() } }]) });
        const res = r.addResults && r.addResults[0]; if (!res || !res.success) throw new Error((res && res.error && res.error.description) || "not saved");
        if (blob) {
          const fd = new FormData(); fd.append("attachment", blob, "photo.jpg"); fd.append("f", "json"); const t = ctx.token(); if (t) fd.append("token", t);
          await fetch(`${C.submit.reports}/${res.objectId}/addAttachment`, { method: "POST", body: fd }).then((x) => x.json()).catch(() => null);
        }
        closeSheet(); toast("Thank you. MDA received your report.", 4500);
      } catch (e) { $("rpGo").disabled = false; $("rpGo").textContent = "Send report"; toast("Couldn't send: " + e.message); }
    };
  }
  ctx.actions.wildReport = () => reportForm("wild_bird");
  ctx.actions.flockReport = () => reportForm("flock");

  // ================= grower farm risk =================
  // all HPAI detections in the region (wild birds, mammals, flocks), for the trend
  function regionEvents() {
    const w = (S.wildPts || []).map((x) => ({ t: x.t }));
    const f = ((S.live && S.live.commercial) || []).map((c) => ({ t: Date.parse(c.date + "T12:00:00Z") }));
    return w.concat(f).filter((e) => e.t);
  }
  // a county and the counties that touch it
  function neighbours(c) { return (S.counties || []).filter((x) => x === c || ctx.esri.geometryEngine.touches(x.geom, c.geom) || ctx.esri.geometryEngine.intersects(x.geom, c.geom)); }

  // ================= grower farm risk =================
  // Works for one farm or dozens: a summary by level, the few highest farms, a full table, dots on the map.
  // Everything is computed and kept on the grower's device; nothing is sent to MDA.
  const TIER_C = ["green", "amber", "red", "dred"], TIER_N = ["Low", "Moderate", "High", "Very high"], TIER_RGB = [[99, 153, 34], [239, 159, 39], [216, 90, 48], [163, 45, 45]];
  const myFarms = new ctx.esri.GraphicsLayer({ title: "My farms", listMode: "hide", visible: false });
  view.map.add(myFarms);
  ctx.on("hitLayers", () => (myFarms.visible ? [myFarms] : []));
  ctx.on("hit", ({ g }) => { if (g.layer !== myFarms) return false; riskDetail(g.attributes.id); return true; });
  let riskRows = [], riskLevel = null, riskQ = "", riskUpOnly = false, riskBusy = 0;

  async function scoreFarm(p, ev) {
    const pt = ptOf(p), z = await ctx.zoneAt(pt), cty = ctx.countyAt(wmu.geographicToWebMercator(pt));
    let visits = 0, zoneVisits = 0;
    if (ctx.has(C.industryVisits) && S.user) {
      try {
        const r = await ctx.rest(C.industryVisits + "/query", { geometry: JSON.stringify({ x: p.lon, y: p.lat, spatialReference: { wkid: 4326 } }), geometryType: "esriGeometryPoint", distance: 500, units: "esriSRUnit_Meter",
          where: `visited >= ${Date.now() - 14 * DAY}`, outFields: "visited,from_zone", returnGeometry: false });
        visits = r.features.length; zoneVisits = r.features.filter((f) => f.attributes.from_zone === 1).length;
      } catch (e) {}
    }
    const here = { lat: p.lat, lon: p.lon }, now = Date.now();
    const outbreaksNear = (S.areas || []).filter((f) => { const c = wmu.webMercatorToGeographic(f.geometry.extent.center), t = f.attributes.since || f.attributes.confirmed_date || f.attributes.created_date;
      return R.km(here, { lat: c.y, lon: c.x }) <= 32.2 && (!t || now - t <= 30 * DAY); }).length;
    const nb = cty ? neighbours(cty) : [];
    const countyOutbreak = !!(cty && ((S.live && S.live.commercial) || []).some((c) => now - Date.parse(c.date + "T12:00:00Z") <= 30 * DAY && nb.some((n) => n.state === c.state && n.name === c.county)));
    const mammalsNear = (S.wildPts || []).filter((w) => w.group === "mammal" && now - w.t <= 56 * DAY && R.km(here, w) <= 16.1).length;
    const inp = { zone: z.zone, kmToArea: ctx.distToArea(pt), wildNear: ctx.wildNear(pt, 10, 28).length, outbreaksNear, countyOutbreak, mammalsNear, trend: R.regionalTrend(ev, now),
      wildCounty: !!(cty && (S.wildPts || []).some((w) => w.county === cty.name && w.state === cty.state && now - w.t <= 28 * DAY)),
      habitatKm: await ctx.habitatKm({ longitude: p.lon, latitude: p.lat }), season: ctx.seasonNow(), zoneVisits, visits, audit: p.audit || null };
    const r = R.farmRisk(inp, now), top = r.reasons.filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
    return { p, r, county: cty ? cty.name : "", main: top[0] ? top[0].why : "No risk factors found", more: Math.max(0, top.length - 1) };
  }

  async function renderRisk() {
    const box = $("riskList");
    if (S.ws !== "industry") { myFarms.removeAll(); myFarms.visible = false; return; }
    const farms = places.filter((p) => p.kind === "farm");
    if (!farms.length) { riskRows = []; myFarms.removeAll(); box.innerHTML = `<p class="hint">Add your premises under My places (choose Farm), or <button class="link" id="rkImp0">import a list of farms</button>.</p>`; $("rkImp0").onclick = importFarms; return; }
    const job = ++riskBusy;
    if (!riskRows.length) box.innerHTML = `<p class="hint">Scoring ${farms.length} farm${farms.length > 1 ? "s" : ""}…</p>`;
    const ev = regionEvents(), out = [];
    for (let i = 0; i < farms.length; i += 6) out.push(...(await Promise.all(farms.slice(i, i + 6).map((p) => scoreFarm(p, ev)))));   // a few at a time
    if (job !== riskBusy) return;
    // "went up": compare with the levels the grower saw at the start of this visit (kept on this device)
    let base = null; try { base = JSON.parse(sessionStorage.getItem("riskBase") || "null"); } catch (e) {}
    if (!base) { base = store.get("riskSeen", {}); try { sessionStorage.setItem("riskBase", JSON.stringify(base)); } catch (e) {} }
    out.forEach((x) => { x.prev = base[x.p.id]; x.up = x.prev != null && x.r.tier > x.prev; });
    store.set("riskSeen", Object.fromEntries(out.map((x) => [x.p.id, x.r.tier])));
    riskRows = out.sort((a, b) => b.r.points - a.r.points || a.p.name.localeCompare(b.p.name));
    paintFarms(); drawRisk();
  }

  const pillOf = (x) => `<span class="pill ${TIER_C[x.r.tier]}">${TIER_N[x.r.tier]} · ${x.r.points}</span>`;
  const shown = () => riskRows.filter((x) => (riskLevel == null || x.r.tier === riskLevel) && (!riskUpOnly || x.up) && (!riskQ || (x.p.name + " " + x.county).toLowerCase().includes(riskQ)));
  function drawRisk() {
    const box = $("riskList"), n = riskRows.length, cnt = [0, 0, 0, 0]; riskRows.forEach((x) => cnt[x.r.tier]++);
    const ups = riskRows.filter((x) => x.up).length, list = shown(), top = list.slice(0, 5);
    box.innerHTML = `
      ${n > 1 ? `<div class="rksum"><span>${n} farms</span><div class="rkbar">${[3, 2, 1, 0].filter((t) => cnt[t]).map((t) => `<i class="t${t}" style="flex:${cnt[t]}"></i>`).join("")}</div>
        <div class="rkchips">${[3, 2, 1, 0].filter((t) => cnt[t]).map((t) => `<button class="pill ${TIER_C[t]}${riskLevel === t ? " on" : ""}" data-lv="${t}">${cnt[t]} ${TIER_N[t].toLowerCase()}</button>`).join("")}</div></div>` : ""}
      ${ups ? `<button class="rkup${riskUpOnly ? " on" : ""}" id="rkUp">${H.icon("warn")}<span>${ups} farm${ups > 1 ? "s" : ""} went up since your last visit</span></button>` : ""}
      ${n > 8 ? `<input id="rkQ" class="rkq" placeholder="Search farms or counties" value="${esc(riskQ)}">` : ""}
      <div class="rklist">${top.map((x) => riskRow(x)).join("") || `<p class="hint">No farms match.</p>`}</div>
      ${list.length > top.length ? `<p class="hint">${list.length - top.length} more farm${list.length - top.length > 1 ? "s" : ""} in the full list.</p>` : ""}
      <div class="btns">${n > 1 ? `<button class="ghost" id="rkAll">See all ${n} farms</button>` : ""}<button class="ghost" id="rkMap">${myFarms.visible ? "Hide from map" : "Show on map"}</button><button class="ghost" id="rkImp">Import farms</button></div>
      <p class="hint" style="margin-top:8px">Screening score, not a diagnosis. Based on <a href="${R.SOURCES.aphis2015.u}" target="_blank" rel="noopener">USDA APHIS</a> data and peer-reviewed studies. Wildlife detections are published by county, so their distances are approximate. Call MDA about any sick birds.</p>
      <p class="hint"><b>Private to you.</b> Your farms and their scores are kept only on this device. MDA doesn't see them.</p>`;
    box.querySelectorAll("[data-lv]").forEach((b) => (b.onclick = () => { const t = +b.dataset.lv; riskLevel = riskLevel === t ? null : t; drawRisk(); }));
    if ($("rkUp")) $("rkUp").onclick = () => { riskUpOnly = !riskUpOnly; drawRisk(); };
    if ($("rkQ")) $("rkQ").oninput = (e) => { riskQ = e.target.value.toLowerCase(); const pos = e.target.selectionStart; drawRisk(); const q = $("rkQ"); q.focus(); q.setSelectionRange(pos, pos); };
    bindRows(box);
    if ($("rkAll")) $("rkAll").onclick = riskTable;
    $("rkMap").onclick = () => { myFarms.visible = !myFarms.visible; if (myFarms.visible && myFarms.graphics.length) view.goTo(myFarms.graphics.toArray(), { padding: 60 }).catch(() => {}); drawRisk(); };
    $("rkImp").onclick = importFarms;
  }
  function riskRow(x) {
    return `<div class="rkrow" data-id="${x.p.id}"><div class="rkt"><b>${esc(x.p.name)}${x.up ? ` <span class="rkarrow t${x.r.tier}" title="Went up">▲</span>` : ""}</b>${pillOf(x)}</div>
      <small>${esc(x.main)}${x.more ? ` · +${x.more} more` : ""}${x.county ? ` · ${esc(x.county)}` : ""}</small></div>`;
  }
  function bindRows(el) { el.querySelectorAll(".rkrow").forEach((r) => (r.onclick = () => riskDetail(r.dataset.id))); }

  // one farm: every reason, the audit, where it is
  function riskDetail(id) {
    const x = riskRows.find((y) => y.p.id === id); if (!x) return;
    const p = x.p;
    sheet(p.name, `<div class="form"><div class="rkt"><span>${x.county ? esc(x.county) + " County" : ""}</span>${pillOf(x)}</div>
      <span class="meter"><i style="left:${Math.min(96, (x.r.points / 14) * 100)}%"></i></span>
      ${x.prev != null && x.prev !== x.r.tier ? `<p class="hint">${x.r.tier > x.prev ? "Up" : "Down"} from ${TIER_N[x.prev].toLowerCase()} since your last visit.</p>` : ""}
      <ul class="why">${x.r.reasons.map((y) => `<li>${y.n > 0 ? "+" : ""}${y.n} ${esc(y.why)} <a href="${R.SOURCES[y.src].u}" target="_blank" rel="noopener" title="${esc(R.SOURCES[y.src].t)}">source</a></li>`).join("") || "<li>No risk factors found</li>"}</ul>
      <div class="btns"><button class="ghost" id="rdMap">Show on map</button><button class="ghost" id="rdAudit">${p.audit ? "Last audit " + fmtShort(p.audit.date) + (p.audit.passed ? " · passed" : " · not passed") : "Add last biosecurity audit"}</button></div></div>`);
    $("rdMap").onclick = () => { closeSheet(); view.goTo({ target: ptOf(p), zoom: 13 }); ctx.locationCard(ptOf(p), p.name); };
    $("rdAudit").onclick = () => auditForm(p);
  }
  function auditForm(p) {
    sheet("Last biosecurity audit", `<div class="form"><p class="hint">${esc(p.name)}</p><label>Date<input type="date" id="auD" value="${p.audit ? new Date(p.audit.date).toISOString().slice(0, 10) : ""}"></label>
      <div class="seg" id="auR"><button data-v="1" class="on">Passed</button><button data-v="0">Not passed</button></div><button class="primary" id="auGo">Save</button></div>`);
    let passed = true; document.querySelectorAll("#auR button").forEach((x) => (x.onclick = () => { passed = x.dataset.v === "1"; document.querySelectorAll("#auR button").forEach((y) => y.classList.toggle("on", y === x)); }));
    $("auGo").onclick = () => { const d = Date.parse($("auD").value + "T12:00:00"); if (!d) return toast("Pick a date"); p.audit = { date: d, passed }; save(); closeSheet(); renderRisk(); };
  }

  // all farms in a sortable, filterable table, with a CSV download
  function riskTable() {
    let sort = "points", dir = -1, lv = null, cty = "", q = "";
    const counties = [...new Set(riskRows.map((x) => x.county).filter(Boolean))].sort();
    const cols = [["name", "Farm"], ["county", "County"], ["points", "Level"], ["main", "Main reason"], ["audit", "Last audit"], ["change", "Change"]];
    const val = (x, k) => k === "name" ? x.p.name.toLowerCase() : k === "county" ? x.county : k === "points" ? x.r.points : k === "main" ? x.main : k === "audit" ? (x.p.audit ? x.p.audit.date : 0) : (x.prev == null ? 0 : x.r.tier - x.prev);
    sheet(`All farms (${riskRows.length})`, `<div class="form rktable">
      <div class="rkfilters"><div class="seg" id="rtLv"><button data-v="" class="on">All</button>${[3, 2, 1, 0].map((t) => `<button data-v="${t}">${TIER_N[t]}</button>`).join("")}</div>
      <select id="rtCty"><option value="">All counties</option>${counties.map((c) => `<option>${esc(c)}</option>`).join("")}</select><input id="rtQ" placeholder="Search farms"></div>
      <div class="rtwrap"><table><thead><tr>${cols.map(([k, l]) => `<th data-k="${k}">${l}<span></span></th>`).join("")}</tr></thead><tbody id="rtBody"></tbody></table></div>
      <div class="btns"><button class="ghost" id="rtCsv">Download CSV</button></div><p class="hint">The download stays on your device; share it only with people you choose.</p></div>`);
    const draw = () => {
      const rows = riskRows.filter((x) => (lv == null || x.r.tier === lv) && (!cty || x.county === cty) && (!q || x.p.name.toLowerCase().includes(q)))
        .sort((a, b) => { const A = val(a, sort), B = val(b, sort); return (A > B ? 1 : A < B ? -1 : 0) * dir; });
      $("rtBody").innerHTML = rows.map((x) => `<tr data-id="${x.p.id}"><td><b>${esc(x.p.name)}</b></td><td>${esc(x.county)}</td><td>${pillOf(x)}</td><td>${esc(x.main)}${x.more ? ` <small>+${x.more}</small>` : ""}</td>
        <td>${x.p.audit ? fmtShort(x.p.audit.date) + (x.p.audit.passed ? "" : " ✗") : "–"}</td><td>${x.prev == null || x.prev === x.r.tier ? "–" : x.r.tier > x.prev ? `<span class="rkarrow t${x.r.tier}">▲</span> from ${TIER_N[x.prev].toLowerCase()}` : `▼ from ${TIER_N[x.prev].toLowerCase()}`}</td></tr>`).join("") || `<tr><td colspan="6" class="hint">No farms match.</td></tr>`;
      document.querySelectorAll(".rktable th").forEach((th) => (th.querySelector("span").textContent = th.dataset.k === sort ? (dir > 0 ? " ▲" : " ▼") : ""));
      $("rtBody").querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => riskDetail(tr.dataset.id)));
    };
    document.querySelectorAll(".rktable th").forEach((th) => (th.onclick = () => { if (sort === th.dataset.k) dir = -dir; else { sort = th.dataset.k; dir = ["points", "audit", "change"].includes(sort) ? -1 : 1; } draw(); }));
    document.querySelectorAll("#rtLv button").forEach((b) => (b.onclick = () => { lv = b.dataset.v === "" ? null : +b.dataset.v; document.querySelectorAll("#rtLv button").forEach((y) => y.classList.toggle("on", y === b)); draw(); }));
    $("rtCty").onchange = (e) => { cty = e.target.value; draw(); };
    $("rtQ").oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
    $("rtCsv").onclick = () => H.csv(riskRows.map((x) => ({ farm: x.p.name, county: x.county, level: TIER_N[x.r.tier], points: x.r.points, reasons: x.r.reasons.map((y) => `${y.n > 0 ? "+" : ""}${y.n} ${y.why}`).join("; "),
      last_audit: x.p.audit ? new Date(x.p.audit.date).toISOString().slice(0, 10) : "", audit_passed: x.p.audit ? (x.p.audit.passed ? "yes" : "no") : "", latitude: x.p.lat, longitude: x.p.lon })), `farm-risk-${new Date().toISOString().slice(0, 10)}.csv`);
    draw();
  }

  // dots on the map, colored by level (only on this device)
  function paintFarms() {
    myFarms.removeAll();
    riskRows.forEach((x) => myFarms.add(new Graphic({ geometry: ptOf(x.p), attributes: { id: x.p.id },
      symbol: { type: "simple-marker", style: "circle", size: 13, color: TIER_RGB[x.r.tier].concat(1), outline: { color: [255, 255, 255, 1], width: 2 } } })));
  }

  // import many farms from a spreadsheet: name + address, or name + latitude + longitude
  function parseCsv(text) {
    const rows = [], re = /("([^"]|"")*"|[^,\r\n]*)(,|\r?\n|$)/g; let row = [], m;
    while ((m = re.exec(text)) && m[0] !== "") { let v = m[1]; if (v.startsWith('"')) v = v.slice(1, -1).replace(/""/g, '"'); row.push(v.trim()); if (m[3] !== ",") { if (row.some(Boolean)) rows.push(row); row = []; } }
    return rows;
  }
  function importFarms() {
    sheet("Import farms", `<div class="form"><p class="hint">Choose a spreadsheet saved as CSV with a column for the farm <b>name</b> and either an <b>address</b> column or <b>latitude</b> and <b>longitude</b> columns. Up to 200 farms.</p>
      <input type="file" id="imF" accept=".csv,text/csv"><div id="imOut"></div><p class="hint">Farms are saved only on this device.</p></div>`);
    $("imF").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rows = parseCsv(await f.text()); if (rows.length < 2) return ($("imOut").innerHTML = `<p class="hint">The file looks empty.</p>`);
      const head = rows[0].map((h) => h.toLowerCase()), col = (...names) => head.findIndex((h) => names.some((n) => h.includes(n)));
      const iN = col("name", "farm"), iA = col("address", "location"), iLat = col("lat"), iLon = col("lon", "lng");
      if (iN < 0 || (iA < 0 && (iLat < 0 || iLon < 0))) return ($("imOut").innerHTML = `<p class="hint">Couldn't find a name column and an address (or latitude and longitude) column.</p>`);
      const list = rows.slice(1, 201), added = [], failed = [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i], name = r[iN] || `Farm ${i + 1}`;
        $("imOut").innerHTML = `<p class="hint">Finding ${i + 1} of ${list.length}: ${esc(name)}…</p>`;
        let lat = iLat >= 0 ? parseFloat(r[iLat]) : NaN, lon = iLon >= 0 ? parseFloat(r[iLon]) : NaN;
        if ((isNaN(lat) || isNaN(lon)) && iA >= 0 && r[iA]) {
          try { const g = await fetch("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?" + new URLSearchParams({ f: "json", SingleLine: r[iA], maxLocations: "1", sourceCountry: "USA" })).then((x) => x.json());
            const c = g.candidates && g.candidates[0]; if (c && c.score >= 80) { lat = c.location.y; lon = c.location.x; } } catch (err) {}
        }
        if (isNaN(lat) || isNaN(lon) || !ctx.inArea(wmu.geographicToWebMercator(new Point({ longitude: lon, latitude: lat })))) { failed.push(name); continue; }
        added.push({ id: H.uid("P"), name, lon: +lon.toFixed(5), lat: +lat.toFixed(5), kind: "farm" });
      }
      places = places.concat(added); save();
      $("imOut").innerHTML = `<p><b>${added.length} farm${added.length === 1 ? "" : "s"} added.</b></p>${failed.length ? `<p class="hint">Not found or outside the region (${failed.length}): ${failed.slice(0, 15).map(esc).join(", ")}${failed.length > 15 ? "…" : ""}</p>` : ""}<button class="primary" id="imDone">Done</button>`;
      $("imDone").onclick = closeSheet; renderPlaces();
    };
  }
});
