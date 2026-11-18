/* Account button + menu (floating, top-right of the map).
 * Signed out: Sign in (MDA staff / Haulers & industry) and Request access.
 * Signed in: account (view as, sign out) and the tools that fit the current view:
 * MDA staff get every workflow (operations, reviews, premises, movement, data export and backup, administration);
 * haulers and growers get their own short lists.
 */
window.HPAI.modules.push(function (ctx) {
  const { H, C, S } = ctx, { $, esc, fmtTime, toast, sheet, closeSheet, csv } = H;
  const has = ctx.has;
  const I = {
    ov: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
    truck: '<path d="M2 7h11v9H2zM13 10h4l4 3v3h-8"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    barn: '<path d="M3 21V11l3-4 6-4 6 4 3 4v10z"/><path d="M9 21v-5h6v5"/>',
    layers: '<path d="M12 3 2 8l10 5 10-5z"/><path d="M2 13l10 5 10-5"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
    wand: '<path d="M4 20 15 9M14 4v3M19 9h-3M17.5 5.5l-2 2"/>',
    route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h6"/>',
    qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 20h2M20 14v2"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 18v2h16v-2"/>',
    db: '<ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/>',
    pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
    group: '<circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9.5" r="2.5"/><path d="M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5M15.5 14.5c2.5 0 4.5 1.5 5.5 4.5"/>',
    log: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    rules: '<path d="M4 6h10M4 12h16M4 18h7"/><circle cx="17" cy="6" r="2"/><circle cx="14" cy="18" r="2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6v.6M12 17v.5"/>'
  };
  const ic = (n) => `<svg class="li" viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`;

  // ---------------- menu content ----------------
  const later = (fn) => () => { ctx.setWorkspace("regulator"); ctx.sheetHalf(); setTimeout(fn, 60); };
  const clickAfter = (sel) => setTimeout(() => { const b = document.querySelector(sel); if (b) b.click(); }, 500);
  const GROUPS = [
    ["Operations", [
      ["ov", "Overview", "Today's numbers", later(() => ctx.mda.open("ov"))],
      ["doc", "Daily situation summary", "Printable briefing (PDF)", later(() => ctx.mda.summary())],
      ["plus", "New infected premises", "Mark premises, draw zones", later(() => ctx.mda.newPremises())],
      ["flag", "Declare a county", "Before zones are drawn", later(() => ctx.mda.declare())],
      ["layers", "Zones and county declarations", "Confirm, edit, release or delete", later(() => ctx.mda.open("z"))],
      ["globe", "Publish public map", "Update what the public sees", later(() => ctx.mda.publish())]]],
    ["Reviews", [
      ["inbox", "Reports", "Dead wild birds, sick flocks", later(() => ctx.mda.queue("rep"))],
      ["truck", "Movement permits", "Approve or deny", later(() => ctx.mda.queue("per"))],
      ["user", "Access requests", "Haulers and growers", later(() => ctx.mda.queue("acc"))]]],
    ["Premises", [
      ["barn", "Premises registry", "Records, boundaries, validation", later(() => ctx.mda.premises("reg"))],
      ["wand", "Auto-outline farms in view", "From building footprints", later(() => { ctx.mda.premises("reg"); clickAfter("#rgBatch"); })],
      ["upload", "Import premises", "GeoJSON or CSV", later(() => { ctx.mda.premises("reg"); clickAfter("#rgImp"); })],
      ["layers", "Farms in each zone", "Counts, houses, audits", later(() => ctx.mda.premises("zones"))]]],
    ["Movement", [
      ["route", "Trace an outbreak", "Visits and trips, 21 days", later(() => ctx.mda.trace())],
      ["qr", "Verify a permit", "Enter or scan a permit number", () => verifyForm()]]],
    ["Data", [
      ["download", "Export data", "Any table as a spreadsheet", () => exportForm()],
      ["db", "Back up everything", "All layers and photos", () => backup()],
      ["pulse", "Data sources & updates", "Feeds, last update, issues", () => dataStatus()]]],
    ["Administration", [
      ["group", "Users & groups", "Who can sign in", () => usersForm()],
      ["log", "Audit log", "Every staff action", later(() => ctx.mda.audit())],
      ["rules", "Current rules", "Zones, privacy, movement", () => rulesSheet()],
      ["help", "Help", "How the tools work", () => helpSheet()]]]
  ];

  // tools for haulers and growers (their panel already holds these; the menu is a shortcut)
  const go = (sel, fn) => () => { ctx.sheetHalf(); const el = document.querySelector(sel); if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); if (fn) setTimeout(() => fn(el), 350); } };
  const focusIn = (sel) => (el) => { const f = el.querySelector(sel) || document.querySelector(sel); if (f) f.focus(); };
  const ROLE = {
    industry: [["Trips & permits", [
      ["route", "Plan a trip", "Route around control areas", go(".planner", focusIn("#orgBox input"))],
      ["truck", "My permits", "Status and QR codes", go("#hTabs", () => document.querySelector('#hTabs [data-p="permits"]').click())],
      ["layers", "Saved trips", "Plan again in one tap", go("#hTabs", () => document.querySelector('#hTabs [data-p="trips"]').click())],
      ["barn", "Farm check-in", "Log a farm visit", () => ctx.actions.checkin()]]],
      ["My farm & reports", [
      ["barn", "My farms", "Risk score and alerts for each farm", go("#myPlaces")],
      ["plus", "Add a place", "Farm or home, for alerts", () => document.getElementById("addPlace").click()],
      ["layers", "Import farms", "From a spreadsheet (CSV)", () => ctx.actions.importFarms()],
      ["flag", "Report a sick flock", "MDA follows up", () => ctx.actions.flockReport()],
      ["inbox", "Report dead wild birds", "With a photo", () => ctx.actions.wildReport()],
      ["help", "Help", "Trips, permits, farm risk", () => helpSheet("industry")]]]]
  };

  // ---------------- account button + dropdown ----------------
  const host = ctx.acctEl, menu = document.createElement("div");
  menu.className = "mega"; menu.hidden = true; menu.setAttribute("role", "menu"); document.body.appendChild(menu);
  let actions = [];
  const item = (i, t, d, fn) => { actions.push(fn); return `<button class="mi" role="menuitem" data-a="${actions.length - 1}">${ic(i)}<span><b>${esc(t)}</b>${d ? `<small>${esc(d)}</small>` : ""}</span></button>`; };
  function build() {
    actions = [];
    if (!S.user) {
      menu.className = "mega vertical signin";
      menu.innerHTML = `<div class="mg"><h4>Sign in</h4>
        ${item("user", "MDA staff", "Maryland Department of Agriculture account · exact premises, zones, reviews, tracing", () => ctx.signIn("regulator"))}
        ${item("truck", "Industry partners", "Email or text code · trip planning, permits, farm risk, check-ins", () => ctx.signIn("partner"))}
        <div class="msep"></div>${item("plus", "Register as an industry partner", "MDA reviews every request", () => ctx.actions.signup())}
        <p class="mnote">The public map needs no sign-in: control areas, county status, wildlife cases, alerts and reports.</p></div>`;
      return;
    }
    const roleName = S.role === "pending" ? "Not on MDA's staff list" : S.session ? [S.user.company, S.user.expires ? "access until " + H.fmtDate(S.user.expires) : ""].filter(Boolean).join(" · ") || ctx.WS[S.role] : ctx.WS[S.role];
    const acct = `<div class="mg macct"><div class="mwho"><span class="av ${S.ws}">${esc(ini())}</span><span><b>${esc(S.user.fullName || S.user.username)}</b><small>${esc(roleName)}</small></span></div>
      ${S.session && S.user.companyAdmin ? item("group", "My company's people", "Add or remove drivers and staff", () => ctx.actions.companyPeople()) : ""}
      ${C.preview && (S.role === "regulator" || S.previewStaff) ? `<div class="pvseg"><small>View as</small><div class="seg">${[["public", "Public"], ["industry", "Industry"], ["regulator", "MDA staff"]].map(([w, l]) => `<button data-pv="${w}" class="${S.ws === w ? "on" : ""}">${l}</button>`).join("")}</div></div>` : ""}
      <div class="msep"></div>${item("log", "Sign out", "", () => ctx.signOut())}</div>`;
    const groups = S.ws === "regulator" ? GROUPS : ROLE[S.ws] || [];
    // one column: who you are first, then each section; MDA's longer menu folds into sections (remembers which are open)
    const openSet = H.store.get("menuOpen", ["Operations", "Reviews"]), fold = S.ws === "regulator";
    menu.className = "mega vertical";
    menu.innerHTML = acct + groups.map(([g, items]) => fold
      ? `<details class="mg" data-g="${esc(g)}"${openSet.includes(g) ? " open" : ""}><summary><h4>${esc(g)}</h4><svg class="li chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></summary>${items.map(([i, t, d, fn]) => item(i, t, d, fn)).join("")}</details>`
      : `<div class="mg"><h4>${esc(g)}</h4>${items.map(([i, t, d, fn]) => item(i, t, d, fn)).join("")}</div>`).join("");
    menu.querySelectorAll("[data-pv]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); if (b.dataset.pv === S.ws) return; close(); ctx.previewAs(b.dataset.pv); }));
    menu.querySelectorAll("details.mg").forEach((el) => el.addEventListener("toggle", () => H.store.set("menuOpen", [...menu.querySelectorAll("details.mg[open]")].map((x) => x.dataset.g))));
  }
  const firstName = () => { const n = (S.user.fullName || "").trim().split(/\s+/)[0]; return n || S.user.username.split(/[_@.]/)[0]; };
  const ini = () => (S.user.fullName || S.user.username).split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
  function renderBtn() {
    host.innerHTML = S.user
      ? `<button class="acbtn glass" aria-haspopup="true" aria-expanded="false" title="Your menu"><span class="av ${S.ws}">${esc(ini())}</span><span class="acl">${esc(firstName())}</span><svg class="li" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>`
      : `<button class="acbtn glass signin" aria-haspopup="true" aria-expanded="false"><svg class="li" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg><span class="acl">Sign in</span></button>`;
    const b = host.querySelector("button");
    b.onclick = (e) => { e.stopPropagation(); if (!menu.hidden) return close(); build(); place(b); menu.hidden = false; b.setAttribute("aria-expanded", "true"); const f = menu.querySelector(".mi"); if (f) f.focus(); };
  }
  function place(b) { const r = b.getBoundingClientRect(); menu.style.top = r.bottom + 8 + "px"; menu.style.right = Math.max(8, window.innerWidth - r.right) + "px"; }
  const close = () => { menu.hidden = true; const b = host.querySelector("button"); if (b) b.setAttribute("aria-expanded", "false"); };
  menu.addEventListener("click", (e) => { const b = e.target.closest(".mi"); if (!b) return; const fn = actions[+b.dataset.a]; close(); fn(); });
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target) && !host.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { close(); const b = host.querySelector("button"); if (b) b.focus(); } });
  window.addEventListener("resize", close);
  ctx.on("acct", renderBtn); ctx.on("signin", renderBtn); renderBtn();

  // ---------------- View as banner: always clear which audience's view MDA staff are looking at ----------------
  function banner() {
    const b = $("viewBanner"), viewing = (S.role === "regulator" && S.ws !== "regulator") || S.previewStaff;
    document.body.classList.toggle("viewing", !!viewing);
    if (!viewing) { b.hidden = true; return; }
    const who = S.ws === "industry" ? "an industry partner (test grower) · nothing is saved" : "the public";
    b.innerHTML = `<span>Viewing as ${who}</span><button type="button" id="vbBack">Back to MDA staff view</button>`;
    b.hidden = false; $("vbBack").onclick = () => ctx.previewAs("regulator");
  }
  ctx.on("ws", banner); ctx.on("acct", banner); ctx.on("signin", banner);

  // ---------------- data export ----------------
  const TABLES = () => [
    ["Reports (wild birds, sick flocks)", C.submitMda.reports], ["Movement permits", C.movementMda.permits], ["Access requests", C.submitMda.accounts],
    ["Email alert subscriptions", C.submitMda.alerts], ["Premises registry", C.core.registry], ["Premises history", C.core.events],
    ["Biosecurity audits", C.core.biosecurity], ["Infected premises", C.core.premises], ["Zones", C.core.zones],
    ["Trips", C.movementMda.trips], ["Farm visits", C.movementMda.visits], ["Audit log", C.core.audit]
  ].filter(([, u]) => has(u));
  async function fetchAll(u) {
    const out = []; let off = 0;
    for (;;) {
      const r = await ctx.rest(u + "/query", { where: "1=1", outFields: "*", returnGeometry: true, outSR: 4326, resultOffset: off, resultRecordCount: 2000, returnCentroid: false });
      (r.features || []).forEach((f) => {
        const a = Object.assign({}, f.attributes);
        Object.keys(a).forEach((k) => { if (/date|_at$|^at$|created|requested|decided|depart|valid_to|visited|observed|declared|confirmed|released|placement|market|audit/i.test(k) && typeof a[k] === "number") a[k] = new Date(a[k]).toISOString(); });
        if (f.geometry && f.geometry.x != null) { a.longitude = +f.geometry.x.toFixed(6); a.latitude = +f.geometry.y.toFixed(6); }
        out.push(a);
      });
      if (!r.exceededTransferLimit || !(r.features || []).length) break;
      off += r.features.length;
    }
    return out;
  }
  function exportForm() {
    sheet("Export data", `<div class="form"><p class="hint">Download any table as a spreadsheet (CSV). Points include latitude and longitude.</p>
      ${TABLES().map(([t], i) => `<div class="prow"><span class="tx"><b>${esc(t)}</b></span><button class="mini" data-x="${i}">Download</button></div>`).join("")}</div>`);
    document.querySelectorAll("#sheetBody [data-x]").forEach((b) => (b.onclick = async () => {
      const [t, u] = TABLES()[+b.dataset.x]; b.disabled = true; b.textContent = "Preparing…";
      try { const rows = await fetchAll(u); csv(rows, t.toLowerCase().replace(/[^a-z]+/g, "_").replace(/_$/, "") + "_" + new Date().toISOString().slice(0, 10) + ".csv"); ctx.audit("data:export", t, rows.length + " rows"); b.textContent = `Downloaded (${rows.length})`; }
      catch (e) { b.disabled = false; b.textContent = "Download"; toast("Couldn't export: " + e.message); }
    }));
  }

  // ---------------- full backup (File Geodatabase in ArcGIS, includes photos) ----------------
  async function backup() {
    const svcs = [...new Set([C.core.premises, C.movementMda.permits, C.submitMda.reports].filter(has).map((u) => u.replace(/\/\d+$/, "")))];
    sheet("Back up everything", `<div class="form"><p class="hint">Makes a complete copy of all HPAI layers, including report photos, as File Geodatabase files in your ArcGIS content. You can download them from there or keep them as restore points.</p>
      <div id="bkList">${svcs.map((u) => `<div class="prow"><span class="tx"><b>${esc(u.split("/services/")[1].split("/")[0].replace(/_/g, " "))}</b><small class="st">Waiting</small></span></div>`).join("")}</div>
      <button class="primary" id="bkGo">Start backup</button></div>`);
    $("bkGo").onclick = async () => {
      $("bkGo").disabled = true; const rows = document.querySelectorAll("#bkList .st"); let ok = 0;
      for (let i = 0; i < svcs.length; i++) {
        rows[i].textContent = "Copying…";
        try {
          const info = await ctx.rest(svcs[i], {});
          const title = `HPAI backup ${svcs[i].split("/services/")[1].split("/")[0]} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
          await ctx.rest(`${ctx.sharing}/rest/content/users/${encodeURIComponent(S.user.username)}/export`, { itemId: info.serviceItemId, exportFormat: "File Geodatabase", title });
          rows[i].textContent = "Started · will appear in your ArcGIS content"; ok++;
        } catch (e) { rows[i].textContent = "Couldn't copy: " + e.message; }
      }
      ctx.audit("data:backup", `${ok} of ${svcs.length} services`, "");
      if (ok) { const a = document.createElement("a"); a.className = "ghost"; a.style.textAlign = "center"; a.textContent = "Open my ArcGIS content"; a.href = C.portalUrl + "/home/content.html"; a.target = "_blank"; a.rel = "noopener"; $("bkGo").replaceWith(a); }
      else $("bkGo").disabled = false;
    };
  }

  // ---------------- data sources & updates ----------------
  function dataStatus() {
    const L = S.live || {}, B = S.birds;
    const row = (name, src, when, n) => `<div class="prow"><span class="tx"><b>${esc(name)}</b><small>${esc(src)}${when ? " · " + esc(when) : ""}</small></span>${n != null ? `<span class="pill">${esc(n)}</span>` : ""}</div>`;
    const upd = L.updated ? fmtTime(Date.parse(L.updated)) : "not available";
    sheet("Data sources & updates", `<div class="form">
      <p class="hint">Official feeds are checked twice a day (about 6 am and 5 pm Eastern). Last check: <b>${esc(upd)}</b>.</p>
      ${row("HPAI in wild birds", "USDA APHIS", "", (L.wild_all || L.wild_year || []).length + " Delmarva records")}
      ${row("HPAI in mammals", "USDA APHIS", "", (L.mammals || []).length + " Delmarva records")}
      ${row("Detections and notices", "MDA, Delaware and Virginia agriculture departments (read automatically)", "", (L.notices || []).length + " notices")}
      ${row("Commercial-flock detections, last 60 days", "from official releases", "", (L.commercial || []).length)}
      ${row("Waterfowl sightings", "eBird, Cornell Lab", B ? fmtTime(Date.parse(B.updated)) : "not yet connected", B ? B.places.length + " places" : null)}
      ${row("Road closures", "MDOT CHART (live)", "", null)}
      ${row("Wetlands, water, forests, refuges, wildlife areas", "USFWS, USGS, MRLC, Maryland DNR (live map services)", "", null)}
      ${(L.problems || []).length ? `<h4 style="margin:8px 0 2px">Issues at last check</h4>${L.problems.map((p) => `<p class="hint">• ${esc(p)}</p>`).join("")}` : `<p class="hint">No issues at the last check.</p>`}</div>`);
  }

  // ---------------- users & groups ----------------
  async function usersForm() {
    const titles = [[C.regulatorGroup, "MDA staff (ArcGIS accounts)"]];
    sheet("Users & groups", `<div class="form"><p class="hint">MDA staff sign in with ArcGIS accounts in the staff group. Industry partners sign in with an email or text code once MDA approves them (Reviews → Access requests).</p><div id="ugList"><p class="hint">Loading…</p></div>
      <h4>Industry partners</h4><div class="seg" id="ipSeg"><button class="on" data-s="Approved">Active</button><button data-s="soon">Expiring in 30 days</button><button data-s="Revoked,Denied,Expired">Stopped</button></div><input id="ipQ" placeholder="Search name, company, email"><div id="ipList"><p class="hint">Loading…</p></div></div>`);
    industryList();
    const out = await Promise.all(titles.map(async ([t, label]) => {
      try { const r = await ctx.rest(ctx.sharing + "/rest/community/groups", { q: `title:"${t}"`, num: 1 }); const g = r.results && r.results[0];
        if (!g) return `<div class="prow"><span class="tx"><b>${esc(label)}</b><small>Group “${esc(t)}” not found</small></span></div>`;
        const u = await ctx.rest(ctx.sharing + `/rest/community/groups/${g.id}/users`, {}).catch(() => ({}));
        const n = (u.users || []).length + (u.admins || []).length;
        return `<div class="prow"><span class="tx"><b>${esc(label)}</b><small>${n || "–"} members</small></span><a class="mini" href="${C.portalUrl}/home/group.html?id=${g.id}#members" target="_blank" rel="noopener">Manage</a></div>`;
      } catch (e) { return `<div class="prow"><span class="tx"><b>${esc(label)}</b><small>${esc(e.message)}</small></span></div>`; }
    }));
    const el = $("ugList"); if (el) el.innerHTML = out.join("");
  }

  // approved industry partners: renew for a year, or stop access (they're told by email or text)
  function industryList() {
    let mode = "Approved", rows = [];
    const u = C.submitMda.accounts;
    const draw = () => {
      const qq = ($("ipQ").value || "").toLowerCase(), now = Date.now();
      const list = rows.filter((a) => !qq || [a.name, a.org, a.email, a.phone].join(" ").toLowerCase().includes(qq));
      $("ipList").innerHTML = list.length ? list.map((a, i) => `<div class="prow"><span class="tx"><b>${esc(a.name)}${a.company_admin ? " · company admin" : ""}</b><small>${esc(a.org || "")} · ${esc(a.btype || a.role || "")} · ${esc(a.email || a.phone || "")}<br>${a.status === "Approved" ? (a.expires ? (a.expires < now ? "expired " : "until ") + H.fmtDate(a.expires) : "no end date") : esc(a.status)}${a.last_login ? " · last sign-in " + H.fmtDate(a.last_login) : " · never signed in"}${a.sponsor_name ? " · added by " + esc(a.sponsor_name) : ""}</small></span>
        <span style="display:grid;gap:4px"><button class="mini" data-r="${i}">${a.status === "Approved" ? "Renew" : "Open"}</button>${a.status === "Approved" ? `<button class="mini no" data-x="${i}">Stop</button>` : ""}</span></div>`).join("") : `<p class="hint">No one here.</p>`;
      $("ipList").querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => { const a = list[+b.dataset.r]; a.status === "Approved" ? renew(a) : ctx.mda.review(a); }));
      $("ipList").querySelectorAll("[data-x]").forEach((b) => (b.onclick = () => stop(list[+b.dataset.x])));
    };
    const load = async () => {
      const now = Date.now();
      const where = mode === "soon" ? `status = 'Approved' AND expires < ${"timestamp '" + new Date(now + 30 * 864e5).toISOString().slice(0, 19).replace("T", " ") + "'"}` : `status IN (${mode.split(",").map((x) => `'${x}'`).join(",")})`;
      try { rows = (await ctx.rest(u + "/query", { where, outFields: "*", returnGeometry: false, orderByFields: "name", resultRecordCount: 2000 })).features.map((f) => f.attributes); draw(); }
      catch (e) { $("ipList").innerHTML = `<p class="hint">Couldn't load: ${esc(e.message)}</p>`; }
    };
    const notify = (a, kind, message) => C.auth && C.auth.url ? fetch(C.auth.url.replace(/\/$/, "") + "/mda/notify", { method: "POST", headers: { authorization: "Bearer " + ctx.token(), "content-type": "application/json" }, body: JSON.stringify({ id: a.acct_id, kind, message }) }).catch(() => {}) : Promise.resolve();
    async function renew(a) {
      const exp = Math.max(Date.now(), a.expires || 0) + 365 * 864e5;
      if (!confirm(`Renew ${a.name}'s access until ${H.fmtDate(exp)}?`)) return;
      await ctx.rest(u + "/applyEdits", { updates: JSON.stringify([{ attributes: { OBJECTID: a.OBJECTID, expires: exp, decided: Date.now(), decided_by: S.user.username } }]) });
      a.expires = exp; ctx.audit("access:renew", a.email || a.phone, H.fmtDate(exp)); notify(a, "renewed"); toast("Renewed"); load();
    }
    async function stop(a) {
      const reason = prompt(`Stop ${a.name}'s access now? Reason (sent to them):`); if (reason === null) return;
      await ctx.rest(u + "/applyEdits", { updates: JSON.stringify([{ attributes: { OBJECTID: a.OBJECTID, status: "Revoked", reason, decided: Date.now(), decided_by: S.user.username } }]) });
      ctx.audit("access:revoke", a.email || a.phone, reason); notify(a, "revoked", reason); toast("Access stopped. It ends within a minute."); load();
    }
    $("ipSeg").querySelectorAll("button").forEach((b) => (b.onclick = () => { $("ipSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); mode = b.dataset.s; load(); }));
    $("ipQ").oninput = draw; load();
  }

  // ---------------- verify a permit ----------------
  function verifyForm() {
    sheet("Verify a permit", `<div class="form"><label>Permit number<input id="vfId" placeholder="MD-2026-XXXXX" autocapitalize="characters"></label><button class="primary" id="vfGo">Check</button>
      <p class="hint">Scanning a permit's QR code with a phone camera opens this check directly.</p></div>`);
    $("vfGo").onclick = () => { const id = $("vfId").value.trim(); if (!id) return; closeSheet(); ctx.setWorkspace("regulator"); ctx.actions.verify(id); };
  }

  // ---------------- current rules ----------------
  function rulesSheet() {
    const mi = H.mi, P = C.privacy;
    const hrs = Object.values(C.commodities).map((c) => `<div class="prow"><span class="tx"><b>${esc(c.label)}</b><small>${[c.hours ? `allowed ${c.hours[0]}:00–${c.hours[1]}:00` : "any time", c.farmBuffer ? "keeps away from other farms" : "", c.cd === true ? "cleaning & disinfection stop" : c.cd === "leaving" ? "C&D when leaving a zone" : "", c.hazmat ? "avoids hazmat-restricted roads" : ""].filter(Boolean).join(" · ")}</small></span></div>`).join("");
    sheet("Current rules", `<div class="form">
      <div class="prow"><span class="tx"><b>Control area</b><small>${mi(C.zones.controlKm)} miles from the premises boundary</small></span></div>
      <div class="prow"><span class="tx"><b>Surveillance zone</b><small>${mi(C.zones.controlKm)}–${mi(C.zones.surveillanceKm)} miles</small></span></div>
      <div class="prow"><span class="tx"><b>County shading</b><small>${C.tintDays} days after a detection or declaration</small></span></div>
      <div class="prow"><span class="tx"><b>Public premises marker</b><small>${P.markerShiftKm[1] ? `moved ${mi(P.markerShiftKm[0])}–${mi(P.markerShiftKm[1])} miles for privacy` : "barn icon at the premises; boundary shown to MDA only"} · privacy check needs ${P.minFarmsNearMarker}+ farms within ${mi(P.markerRadiusKm)} miles</small></span></div>
      <div class="prow"><span class="tx"><b>Farm spacing on routes</b><small>about ${Math.round(C.farmBufferKm * 3280.84 / 100) * 100} ft from other poultry farms</small></span></div>
      <h4 style="margin:8px 0 2px">Movement types</h4>${hrs}</div>`);
  }

  // ---------------- help ----------------
  function helpSheet(kind) {
    if (kind === "industry") return sheet("Help", `<div class="form help">
      <p><b>Plan a trip.</b> Enter where you start and where you're going, pick the load, check truck height and weight, then Plan route. Routes go around control areas, keep away from other poultry farms and add a cleaning stop when needed.</p>
      <p><b>Permits.</b> If a trip has to enter a control area, tap Request permit. The form is filled in from the route. Approved permits show a QR code to present at checkpoints.</p>
      <p><b>Farm check-in.</b> Log each farm you visit. If a farm later tests positive, MDA can reach the right drivers quickly.</p>
      <p><b>Farm risk.</b> Save your farm under My places. The score adds up nearby control areas, wild-bird detections, vehicle visits from control areas, waterfowl habitat and season. It's a screening aid, not a diagnosis.</p>
      <p><b>Sick birds.</b> If birds are dying now, call MDA at ${esc(C.mdaPhone)}.</p></div>`);
    if (kind === "industry-farm") return sheet("Help", `<div class="form help">
      <p><b>Farm risk.</b> Save your farm under My places. The score adds up nearby control areas, wild-bird detections, vehicle visits from control areas, waterfowl habitat and season. It's a screening aid, not a diagnosis.</p>
      <p><b>Sick birds.</b> If birds are dying now, call MDA at ${esc(C.mdaPhone)}. The Report a sick flock form helps MDA follow up.</p></div>`);
    sheet("Help", `<div class="form help">
      <p><b>New outbreak.</b> MDA menu → New infected premises. Tap the premises (a registered boundary is used if there is one), check the zones, create. Leave "Confirmed by USDA" off for a preliminary positive: the premises is tracked but no zone is drawn until you tap <b>Confirm</b> under Zones.</p>
      <p><b>Corrections.</b> Zones → Edit fixes the ID, date, flock, birds, county or notes, or deletes a premises entered by mistake (type its ID to confirm). Every change is in the audit log.</p>
      <p><b>Announcement before zones.</b> MDA menu → Declare a county. The county gets a mild shade for everyone.</p>
      <p><b>Release.</b> Zones → Release. A confirmed area moves to Past outbreaks on the time slider; a preliminary one that's released doesn't.</p>
      <p><b>View as.</b> Your menu → View as Public or Industry shows exactly what they see. A banner shows while you're viewing as someone else; nothing is saved in the industry view.</p>
      <p><b>Reviews.</b> Reports, permits and access requests each have Approve / Deny (or Confirm / Dismiss). Every decision is in the audit log.</p>
      <p><b>Premises registry.</b> Add or auto-outline farms, fill in birds, history and compliance, then Validate.</p>
      <p><b>Audit log.</b> Search by person, premises or word, filter by kind of action, and load older entries; export to CSV.</p>
      <p><b>Tracing.</b> MDA menu → Trace an outbreak, pick the premises: visits, permitted trips and where those vehicles went next.</p>
      <p><b>Data.</b> Export any table, or back up everything (with photos) to your ArcGIS content.</p></div>`);
  }
});
