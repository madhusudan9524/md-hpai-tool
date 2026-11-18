/* Demo sign-in for testing on your own computer (http://localhost:8080/?demo).
 * Pretends to be the industry sign-in service (worker/): the code is always 123456, and records are read and saved
 * with your own ArcGIS sign-in (sign in as MDA staff first). Checks are a lighter version of the service's.
 * Never active anywhere except localhost.
 */
(function (H) {
  const CODE = "123456", DAY = 864e5;
  const q = (s) => String(s == null ? "" : s).replace(/'/g, "''");
  const clip = (s, n) => String(s == null ? "" : s).trim().slice(0, n);
  const fail = (m) => { throw new Error(m); };
  function norm(c) {
    c = String(c || "").trim();
    if (c.includes("@")) return { kind: "email", v: c.toLowerCase() };
    let d = c.replace(/\D/g, ""); if (d.length === 10) d = "1" + d;
    if (d.length < 11) fail("Enter a valid email address or mobile number."); return { kind: "phone", v: "+" + d };
  }
  const TYPES = { grower: ["Grower / poultry farm", ["md_reg_no"]], breeder: ["Breeder, hatchery or seller", ["md_reg_no", "npip_id"]], hauler: ["Hauling company", ["usdot"]], worker: ["Driver or farm worker", ["employer"]],
    integrator: ["Integrator / poultry company", []], feed: ["Feed mill", []], rendering: ["Rendering / disposal", []], service: ["Service provider", []], other: ["Other poultry business", []] };
  const active = (a) => a && a.status === "Approved" && (!a.expires || a.expires > Date.now());
  const userOf = (a) => ({ id: a.acct_id, name: a.name, company: a.org, btype: a.btype, email: a.email, phone: a.phone, county: a.county, expires: a.expires, scope: a.scope || "", companyAdmin: !!a.company_admin });

  H.demoApi = async function (path, body, ctx) {
    const { C } = ctx, U = C.submitMda.accounts;
    // borrow the ArcGIS sign-in of whoever is testing (MDA staff)
    if (!ctx.token()) { try { await ctx.esriId.checkSignInStatus(ctx.sharing); } catch (e) { fail("Demo: sign in as MDA staff first (Sign in → MDA staff). The demo uses that sign-in to save records."); } }
    const R = (u, p) => ctx.restRaw(u, p);
    const rows = async (where, extra) => ((await R(U + "/query", Object.assign({ where, outFields: "*", returnGeometry: false }, extra || {}))).features || []).map((f) => f.attributes);
    const byContact = async (c) => { const l = await rows(c.kind === "email" ? `LOWER(email) = '${q(c.v)}'` : `phone = '${q(c.v)}'`, { orderByFields: "created DESC" }); return l.find((a) => a.status === "Approved") || l[0] || null; };
    const byId = async (id) => (await rows(`acct_id = '${q(id)}'`))[0] || null;
    const me = async () => { const t = ctx.ind.token() || ""; if (!t.startsWith("demo.")) fail("Please sign in again."); const a = await byId(t.slice(5)); if (!active(a)) fail("Your access isn't active."); return a; };
    const save = (adds, updates) => R(U + "/applyEdits", Object.assign({}, adds ? { adds: JSON.stringify(adds.map((a) => ({ attributes: a }))) } : {}, updates ? { updates: JSON.stringify(updates.map((a) => ({ attributes: a }))) } : {}));
    const attach = async (oid, files) => { for (const f of files) { const fd = new FormData(); fd.append("f", "json"); fd.append("token", ctx.token()); fd.append("attachment", f, f.name); await fetch(`${U}/${oid}/addAttachment`, { method: "POST", body: fd }).catch(() => {}); } };

    if (path === "/code") {
      const c = norm(body.contact);
      if (body.purpose === "signin") {
        const a = await byContact(c);
        if (!active(a)) return { ok: true, message: a ? `Demo: no code, because this request is "${a.status}". Approve it under MDA menu → Reviews → Access requests first.` : "Demo: no one registered with this email or number." };
      }
      return { ok: true, message: `Demo mode: your code is ${CODE}.` };
    }
    if (path === "/verify") {
      if (String(body.code).trim() !== CODE) fail(`That code isn't right. In the demo it's always ${CODE}.`);
      const c = norm(body.contact);
      if (body.purpose === "register") return { proof: "demo:" + c.v };
      const a = await byContact(c); if (!active(a)) fail("Your access isn't active.");
      await save(null, [{ OBJECTID: a.OBJECTID, last_login: Date.now() }]).catch(() => {});
      return { token: "demo." + a.acct_id, user: userOf(a) };
    }
    if (path === "/me") return { user: userOf(await me()) };
    if (path === "/register") {
      const d = JSON.parse(body.get("data")), t = TYPES[d.btype] || fail("Choose your type of business.");
      const email = norm(d.email); if (d.emailProof !== "demo:" + email.v) fail("Confirm your email with the code first.");
      const phone = d.phone ? norm(d.phone) : null;
      for (const f of t[1]) if (!clip(d[f], 60)) fail("Fill in all the required numbers.");
      const a = { acct_id: crypto.randomUUID(), btype: d.btype, role: t[0].slice(0, 20), name: clip(d.name, 100), email: email.v, phone: phone ? phone.v : "", org: clip(d.company, 120), county: clip(d.county, 60), address: clip(d.address, 255),
        md_reg_no: clip(d.md_reg_no, 40), npip_id: clip(d.npip_id, 40), usdot: clip(d.usdot, 20).replace(/\D/g, ""), licence_no: clip(d.licence_no, 60), employer: clip(d.employer, 120),
        email_ok: 1, phone_ok: phone && d.phoneProof === "demo:" + phone.v ? 1 : 0, status: "New", created: Date.now(), company_admin: 0, info_reply: clip(d.note, 4000) };
      const checks = await H.demoChecks(a, ctx, rows);
      if (d.companyAdmin) checks.push({ k: "admin", label: "Wants to be the company administrator", state: "manual", detail: "They'd add and remove their own drivers and staff." });
      a.checks = JSON.stringify(checks).slice(0, 8000);
      const r = await save([a]); const oid = r.addResults && r.addResults[0].objectId; if (!oid) fail("Couldn't save the request.");
      await attach(oid, body.getAll("files").filter((f) => f && f.size));
      ctx.audit("access:request", a.email, "demo registration");
      return { ok: true, id: a.acct_id };
    }
    if (path === "/more") fail("Demo: answering MDA's question works only with the real sign-in service.");
    if (path === "/arcgis") {
      const a = await me(), T = {
        trips: { url: C.movementMda.trips, own: 1, ops: ["query", "addFeatures"] }, visits: { url: C.movementMda.visits, own: 1, ops: ["query", "addFeatures"] },
        permits: { url: C.movementMda.permits, own: 1, ops: ["query", "addFeatures"], force: { status: "Pending" } },
        farms: { url: C.farmsUrl, ops: ["query"], fields: "OBJECTID" }, industryVisits: { url: C.industryVisits, ops: ["query"] }, route: { url: C.routeUrl, ops: ["", "solve"] } }[body.target];
      if (!T || !T.ops.includes(body.op)) fail("Not allowed.");
      const p = Object.assign({}, body.params || {});
      if (body.op === "query") { if (T.own) p.where = `(${p.where || "1=1"}) AND acct_id = '${q(a.acct_id)}'`; if (T.fields) p.outFields = T.fields; }
      if (body.op === "addFeatures") { const fs = JSON.parse(p.features || "[]"); fs.forEach((f) => { f.attributes = Object.assign({}, f.attributes, T.force || {}, { acct_id: a.acct_id }); }); p.features = JSON.stringify(fs); }
      return R(body.op ? T.url + "/" + body.op : T.url, p);
    }
    if (path.startsWith("/company/")) {
      const a = await me(); if (!a.company_admin) fail("Only your company's administrator can do this.");
      const mine = () => rows(`sponsor_id = '${q(a.acct_id)}'`, { orderByFields: "created DESC" });
      if (path === "/company/list") return { people: (await mine()).map((x) => ({ id: x.acct_id, name: x.name, email: x.email, phone: x.phone, role: x.btype, status: x.status, last_login: x.last_login })) };
      if (path === "/company/add") {
        const e = body.email ? norm(body.email) : null, ph = body.phone ? norm(body.phone) : null; if (!clip(body.name, 100) || (!e && !ph)) fail("Enter a name and an email or mobile number.");
        const n = { acct_id: crypto.randomUUID(), btype: "worker", role: "Sponsored staff", name: clip(body.name, 100), email: e ? e.v : "", phone: ph ? ph.v : "", org: a.org, county: a.county, employer: a.org, sponsor_id: a.acct_id, sponsor_name: a.name, email_ok: 0, phone_ok: 0, created: Date.now(), status: "New", company_admin: 0 };
        n.checks = JSON.stringify([{ k: "sponsor", label: `Added by ${a.org || "their company"}`, state: "ok", detail: `${a.name}, the company's approved administrator, added this person.` }, { k: "email", label: "Email or number confirmed at first sign-in", state: "info", detail: n.email || n.phone }]);
        await save([n]); return { ok: true, status: "New" };
      }
      if (path === "/company/remove") { const x = (await mine()).find((p) => p.acct_id === body.id) || fail("Not one of your people."); await save(null, [{ OBJECTID: x.OBJECTID, status: "Revoked", decided: Date.now(), decided_by: "company:" + a.name, reason: "Removed by company administrator" }]); return { ok: true }; }
    }
    if (path === "/mda/recheck") { const a = await byId(body.id); const c = await H.demoChecks(a, ctx, rows); await save(null, [{ OBJECTID: a.OBJECTID, checks: JSON.stringify(c).slice(0, 8000) }]); return { checks: c }; }
    if (path === "/mda/notify") return { ok: true, sent: [] };   // the demo doesn't send messages
    fail("Not available in the demo.");
  };

  // lighter version of the service's automatic checks (no FMCSA key, no phone line lookup)
  H.demoChecks = async function (a, ctx, rows) {
    const out = [], C = ctx.C;
    out.push(a.email_ok ? { k: "email", label: "Email confirmed with a code", state: "ok", detail: a.email } : { k: "email", label: "Email not confirmed", state: a.sponsor_id ? "info" : "fail", detail: a.email || a.phone });
    out.push(a.phone ? { k: "phone", label: a.phone_ok ? "Mobile number confirmed with a code" : "Mobile number not confirmed", state: a.phone_ok ? "ok" : "warn", detail: a.phone } : { k: "phone", label: "No phone number given", state: "warn", detail: "" });
    if (a.address) {
      try {
        const r = await fetch("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?" + new URLSearchParams({ f: "json", SingleLine: a.address, maxLocations: "1", outFields: "Subregion,RegionAbbr" })).then((x) => x.json());
        const c = r.candidates && r.candidates[0];
        out.push(c ? { k: "address", label: c.score >= 85 ? `Address found · ${c.attributes.Subregion || ""}, ${c.attributes.RegionAbbr || ""}` : "Address only roughly matched", state: c.score >= 85 ? "ok" : "warn", detail: c.address, data: { x: c.location.x, y: c.location.y } } : { k: "address", label: "Address not found", state: "warn", detail: a.address });
      } catch (e) {}
    } else out.push({ k: "address", label: "No business or farm address given", state: "warn", detail: "" });
    for (const [f, what] of [["md_reg_no", "Maryland premises registration"], ["npip_id", "NPIP number"]]) {
      if (!a[f]) { if (f === "md_reg_no" && (a.btype === "grower" || a.btype === "breeder")) out.push({ k: f, label: "No premises registration number", state: "fail", detail: "" }); continue; }
      try {
        const r = await ctx.restRaw(C.core.registry + "/query", { where: `${f} = '${q(a[f])}'`, outFields: "*", returnGeometry: false, returnCentroid: true, outSR: 4326 });
        const ft = (r.features || [])[0];
        if (!ft) { out.push({ k: f, label: `${what} ${a[f]} not in MDA's registry`, state: "warn", detail: "Check MDA's registration list; the registry may not include every farm yet." }); continue; }
        const p = ft.attributes, ctr = ft.centroid;
        out.push({ k: f, label: `${what} found`, state: "ok", detail: `${p.name || "-"}${p.operator ? " · " + p.operator : ""} · ${p.address || ""} ${p.county || ""}`,
          data: { premises_id: p.premises_id, name: p.name, operator: p.operator, phone: p.phone, address: p.address, county: p.county, production: p.production_type, species: p.species, houses: p.houses, capacity: p.capacity, npip: p.npip_id, npip_status: p.npip_status, status: p.status, validation: p.validation, x: ctr && ctr.x, y: ctr && ctr.y } });
      } catch (e) { out.push({ k: f, label: `${what} ${a[f]}: couldn't check`, state: "manual", detail: "" }); }
    }
    if (a.usdot) out.push({ k: "usdot", label: `USDOT ${a.usdot}: check by hand`, state: "manual", detail: "Open the FMCSA record and compare the company name and status.", data: { link: `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${a.usdot}` } });
    else if (a.btype === "hauler") out.push({ k: "usdot", label: "No USDOT number", state: "fail", detail: "" });
    try {
      const ors = [a.email && `LOWER(email) = '${q(a.email)}'`, a.phone && `phone = '${q(a.phone)}'`, a.usdot && `usdot = '${q(a.usdot)}'`, a.md_reg_no && `md_reg_no = '${q(a.md_reg_no)}'`].filter(Boolean);
      const f = ors.length ? (await rows(`(${ors.join(" OR ")}) AND (acct_id IS NULL OR acct_id <> '${q(a.acct_id)}')`)) : [];
      const bad = f.filter((x) => x.status === "Denied" || x.status === "Revoked");
      if (bad.length) out.push({ k: "history", label: `Earlier request ${bad[0].status.toLowerCase()}`, state: "fail", detail: bad.map((x) => `${x.name} · ${x.status}${x.reason ? " · " + x.reason : ""}`).join("; ") });
      if (f.length > bad.length) out.push({ k: "dup", label: `Same details used in ${f.length - bad.length} other request(s)`, state: "info", detail: f.filter((x) => !bad.includes(x)).slice(0, 5).map((x) => `${x.name} · ${x.status}`).join("; ") });
    } catch (e) {}
    if (a.btype === "worker" && !a.sponsor_id) out.push({ k: "employer", label: `Employer: ${a.employer || "not given"}`, state: "manual", detail: "Confirm with the employer." });
    if (a.licence_no) out.push({ k: "licence", label: `Licence or registration no. ${a.licence_no}`, state: "manual", detail: "Confirm against MDA's licence records." });
    out.push({ k: "demo", label: "Demo mode: no FMCSA or phone-line checks", state: "info", detail: "The real sign-in service adds these." });
    return out;
  };
})(window.HPAI);
