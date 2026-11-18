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
    box.innerHTML = rows.map(({ p, s }) => {
      const isNew = s.key && seen[p.id] !== s.key; if (isNew) fresh++;
      const pill = s.flags.length ? s.flags.map(([c, t]) => `<span class="pill ${c}">${esc(t)}</span>`).join(" ") : `<span class="pill green">All clear</span>`;
      return `<div class="place" data-id="${p.id}"><span class="ic">${p.kind === "farm" ? "🐔" : "🏠"}</span><span class="tx"><b>${esc(p.name)}${isNew ? ' <span class="pill red">New</span>' : ""}</b><small>${pill}</small></span><button class="mini" data-del="${p.id}" aria-label="Remove">✕</button></div>`;
    }).join("");
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

  // ================= access requests (self sign-up; MDA approves) =================
  ctx.actions.signup = () => {
    sheet("Request access", `<div class="form">
      <div class="seg" id="suRole"><button data-r="hauler" class="on">Hauler / transporter</button><button data-r="industry">Grower / poultry staff</button></div>
      <div class="two"><label>Full name<input id="suName" autocomplete="name"></label><label>Phone<input id="suPhone" type="tel" autocomplete="tel"></label></div>
      <label>Email<input id="suEmail" type="email" autocomplete="email"></label>
      <div class="two"><label>Company<input id="suOrg" autocomplete="organization"></label><label>County<input id="suCty"></label></div>
      <label>Truck or premises ID (optional)<input id="suId" placeholder="USDOT no., NPIP no., or premises ID"></label>
      <button class="primary" id="suGo">Send request</button>
      <p class="hint">MDA reviews each request. Once approved, you'll get an email invite to sign in.</p></div>`);
    let role = "hauler";
    document.querySelectorAll("#suRole button").forEach((b) => (b.onclick = () => { role = b.dataset.r; document.querySelectorAll("#suRole button").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("suGo").onclick = async () => {
      const email = $("suEmail").value.trim(), name = $("suName").value.trim();
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast("Enter your name and a valid email");
      if (!ctx.has(C.submit.accounts)) return toast(`Requests are temporarily unavailable. Call MDA at ${C.mdaPhone}.`);
      $("suGo").disabled = true;
      try {
        await ctx.rest(C.submit.accounts + "/addFeatures", { features: JSON.stringify([{ attributes: { name, email, phone: $("suPhone").value, org: $("suOrg").value, county: $("suCty").value, role, ref_id: $("suId").value, status: "New", created: Date.now() } }]) }, { anon: true });
        closeSheet(); toast("Request sent. MDA will email you.", 4500);
      } catch (e) { $("suGo").disabled = false; toast("Couldn't send: " + e.message); }
    };
  };

  // ================= grower farm risk =================
  async function renderRisk() {
    if (S.ws !== "industry") return;
    const farms = places.filter((p) => p.kind === "farm"), box = $("riskList");
    if (!farms.length) { box.innerHTML = `<p class="hint">Add your premises under My places (choose Farm).</p>`; return; }
    const out = await Promise.all(farms.map(async (p) => {
      const pt = ptOf(p), z = await ctx.zoneAt(pt), cty = ctx.countyAt(wmu.geographicToWebMercator(pt));
      let visits = 0, zoneVisits = 0;
      if (ctx.has(C.industryVisits) && S.user) {
        try {
          const r = await ctx.rest(C.industryVisits + "/query", { geometry: JSON.stringify({ x: p.lon, y: p.lat, spatialReference: { wkid: 4326 } }), geometryType: "esriGeometryPoint", distance: 500, units: "esriSRUnit_Meter",
            where: `visited >= ${Date.now() - 14 * DAY}`, outFields: "visited,from_zone", returnGeometry: false });
          visits = r.features.length; zoneVisits = r.features.filter((f) => f.attributes.from_zone === 1).length;
        } catch (e) {}
      }
      const inp = { zone: z.zone, kmToArea: ctx.distToArea(pt), wildNear: ctx.wildNear(pt, 10, 28).length,
        wildCounty: !!(cty && (S.wildPts || []).some((w) => w.county === cty.name && w.state === cty.state && Date.now() - w.t <= 28 * DAY)),
        habitatKm: await ctx.habitatKm({ longitude: p.lon, latitude: p.lat }), season: ctx.seasonNow(), zoneVisits, visits, audit: p.audit || null };
      return { p, r: R.farmRisk(inp, Date.now()) };
    }));
    const col = ["green", "amber", "red", "dred"];
    box.innerHTML = out.map(({ p, r }) => `<div class="prow" data-id="${p.id}" style="display:block">
      <div class="risk"><b style="flex:none;min-width:0">${esc(p.name)}</b><span class="meter"><i style="left:${Math.min(96, (r.points / 12) * 100)}%"></i></span><span class="pill ${col[r.tier]}">${r.label}</span></div>
      <ul class="why">${r.reasons.map((x) => `<li>${x.n > 0 ? "+" : ""}${x.n} ${esc(x.why)}</li>`).join("") || "<li>No risk factors found</li>"}</ul>
      <button class="link" data-audit="${p.id}" style="font-size:13px;margin-top:6px">${p.audit ? "Last audit " + fmtShort(p.audit.date) + (p.audit.passed ? " · passed" : " · not passed") : "Add last biosecurity audit"}</button></div>`).join("") +
      `<p class="hint" style="margin-top:8px">Screening score, not a diagnosis. Based on <a href="${R.SOURCES.aphis2015.u}" target="_blank" rel="noopener">USDA APHIS</a> and peer-reviewed studies. Call MDA about any sick birds.</p>`;
    box.querySelectorAll("[data-audit]").forEach((b) => (b.onclick = () => {
      const p = places.find((x) => x.id === b.dataset.audit);
      sheet("Last biosecurity audit", `<div class="form"><label>Date<input type="date" id="auD" value="${p.audit ? new Date(p.audit.date).toISOString().slice(0, 10) : ""}"></label>
        <div class="seg" id="auR"><button data-v="1" class="on">Passed</button><button data-v="0">Not passed</button></div><button class="primary" id="auGo">Save</button></div>`);
      let passed = true; document.querySelectorAll("#auR button").forEach((x) => (x.onclick = () => { passed = x.dataset.v === "1"; document.querySelectorAll("#auR button").forEach((y) => y.classList.toggle("on", y === x)); }));
      $("auGo").onclick = () => { const d = Date.parse($("auD").value + "T12:00:00"); if (!d) return toast("Pick a date"); p.audit = { date: d, passed }; save(); closeSheet(); renderRisk(); };
    }));
  }
});
