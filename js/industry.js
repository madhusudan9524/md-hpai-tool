/* Maryland HPAI map: industry partners (haulers, growers, poultry businesses).
 * Sign-in with a code sent by email or text, registration with the right credential for each type of business,
 * replying when MDA asks for more information, and a company administrator's list of their own people.
 * Talks to the sign-in service in worker/ (address in HPAI_CONFIG.auth.url).
 */
window.HPAI.modules.push(function (ctx) {
  const { H, C, S } = ctx, { $, esc, fmtDate, toast, sheet, closeSheet, DAY } = H;
  const ready = () => !!(C.auth && (C.auth.url || C.auth.demo));
  const demoTip = () => C.auth && C.auth.demo ? `<p class="tip"><b>Demo mode</b> (only on your computer): the code is always 123456 and nothing is emailed. Records are saved with your MDA sign-in.</p>` : "";
  const notReady = () => toast(`Industry sign-in is being set up. For now, call MDA at ${C.mdaPhone}.`, 6000);
  const api = ctx.ind.api;

  // ---------------- what we ask each type of business for ----------------
  const TYPES = [
    ["grower", "Grower / poultry farm", "Your Maryland premises registration number (on your MDA registration card). Every place that keeps poultry in Maryland must be registered."],
    ["breeder", "Breeder, hatchery or live-bird seller", "Your Maryland premises registration number and your NPIP number."],
    ["hauler", "Hauling company", "Your company's USDOT number. We check it against the federal FMCSA records."],
    ["worker", "Driver or farm worker", "Who you work for. The quickest way: ask your company's administrator to add you, then just sign in."],
    ["integrator", "Integrator / poultry company", "A work email at your company, and any MDA licence or registration number you hold."],
    ["feed", "Feed mill", "A work email at your company, and your MDA feed licence number if you have one."],
    ["rendering", "Rendering / disposal", "A work email at your company, and your licence or permit number."],
    ["service", "Service provider (vet, crew, equipment)", "A work email, and your licence number if your work needs one (for example a veterinary licence)."],
    ["other", "Other poultry business", "Anything that shows your connection to the poultry industry."]
  ];
  const DOCS = {
    grower: "A photo of your premises registration card or letter.", breeder: "Photos of your premises registration and NPIP certificate.",
    hauler: "A photo of a truck's cab card or your operating authority.", worker: "A letter from your employer or a photo of your work ID.",
    integrator: "A business card or company letter.", feed: "Your feed licence.", rendering: "Your licence or permit.", service: "Your licence or a company letter.", other: "Anything that helps MDA confirm who you are."
  };
  const COMPANY = ["hauler", "integrator", "grower", "breeder", "feed", "rendering", "service"];

  // ---------------- sign in: email or mobile number → 6-digit code ----------------
  ctx.actions.industrySignIn = () => {
    if (!ready()) return notReady();
    sheet("Industry partner sign-in", `<div class="form">
      ${demoTip()}<p class="hint">For approved haulers, growers and poultry businesses. We'll send you a 6-digit code. No password needed.</p>
      <label>Email or mobile number<input id="inC" autocomplete="username" inputmode="email" placeholder="you@company.com or 410 555 0100"></label>
      <button class="primary" id="inSend">Send code</button>
      <div id="inStep2" hidden><label>Code<input id="inCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 digits"></label>
        <button class="primary" id="inGo">Sign in</button><p class="hint" id="inMsg"></p><button class="linkbtn" id="inAgain">Send a new code</button></div>
      <p class="fine">Not registered yet? <a href="#" id="inReg">Register as an industry partner</a></p></div>`);
    const send = async () => {
      const c = $("inC").value.trim(); if (!c) return toast("Enter your email or mobile number");
      $("inSend").disabled = true;
      try { const r = await api("/code", { contact: c, purpose: "signin" }); $("inStep2").hidden = false; $("inMsg").textContent = r.message + " It works for 10 minutes."; $("inSend").hidden = true; $("inCode").focus(); }
      catch (e) { toast(e.message, 5000); } finally { $("inSend").disabled = false; }
    };
    $("inSend").onclick = send; $("inAgain").onclick = send;
    $("inC").onkeydown = (e) => { if (e.key === "Enter") send(); };
    const go = async () => {
      $("inGo").disabled = true;
      try { const r = await api("/verify", { contact: $("inC").value.trim(), code: $("inCode").value, purpose: "signin" }); closeSheet(); ctx.ind.start(r.token, r.user); toast(`Welcome, ${r.user.name.split(" ")[0]}`); }
      catch (e) { toast(e.message, 5000); $("inGo").disabled = false; }
    };
    $("inGo").onclick = go; $("inCode").oninput = () => { if (/^\d{6}$/.test($("inCode").value)) go(); };
    $("inReg").onclick = (e) => { e.preventDefault(); ctx.actions.signup(); };
  };

  // a "confirm with a code" box under an email or phone field; resolves to a proof token
  function confirmBox(inputId, boxId, label) {
    const st = { proof: null, value: "" }, box = $(boxId);
    const reset = () => { st.proof = null; box.innerHTML = `<button class="mini" type="button" data-s>Send code</button>`; box.querySelector("[data-s]").onclick = start; };
    async function start() {
      const v = $(inputId).value.trim(); if (!v) return toast(`Enter your ${label} first`);
      const b = box.querySelector("[data-s]"); b.disabled = true;
      try {
        await api("/code", { contact: v, purpose: "register" });
        box.innerHTML = `<input class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code"><button class="mini" type="button" data-v>Confirm</button><button class="linkbtn" type="button" data-s>New code</button>`;
        box.querySelector("[data-s]").onclick = start;
        const inp = box.querySelector(".code"); inp.focus();
        const ver = async () => {
          try { st.proof = (await api("/verify", { contact: v, code: inp.value, purpose: "register" })).proof; st.value = v; box.innerHTML = `<span class="okmark">✓ Confirmed</span>`; }
          catch (e) { toast(e.message, 5000); }
        };
        box.querySelector("[data-v]").onclick = ver; inp.oninput = () => { if (/^\d{6}$/.test(inp.value)) ver(); };
      } catch (e) { toast(e.message, 5000); b.disabled = false; }
    }
    $(inputId).addEventListener("input", () => { if (st.proof && $(inputId).value.trim() !== st.value) reset(); });
    reset(); return st;
  }

  // ---------------- registration ----------------
  ctx.actions.signup = () => {
    if (!ready()) return notReady();
    sheet("Register as an industry partner", `<div class="form reg">
      ${demoTip()}<p class="hint">MDA checks every request. Most are decided within two working days; you'll get an email or text.</p>
      <label>Your business<select id="rgT">${TYPES.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
      <p class="tip" id="rgNeed"></p>
      <div class="two"><label>Full name<input id="rgName" autocomplete="name"></label><label>Company or farm name<input id="rgOrg" autocomplete="organization"></label></div>
      <label>Email<input id="rgEmail" type="email" autocomplete="email"></label><div class="confirm" id="rgEmailC"></div>
      <label>Mobile number <small>(optional, for text codes)</small><input id="rgPhone" type="tel" autocomplete="tel"></label><div class="confirm" id="rgPhoneC"></div>
      <label>Business or farm address<input id="rgAddr" autocomplete="street-address" placeholder="Street, town, state"></label>
      <label>County<input id="rgCty"></label>
      <div data-f="md_reg_no"><label>Maryland premises registration number<input id="rg_md_reg_no"></label></div>
      <div data-f="npip_id"><label>NPIP number<input id="rg_npip_id" placeholder="e.g. 51-123"></label></div>
      <div data-f="usdot"><label>USDOT number<input id="rg_usdot" inputmode="numeric"></label></div>
      <div data-f="employer"><label>Employer<input id="rg_employer" placeholder="Company you work for"></label></div>
      <div data-f="licence_no"><label>Licence or registration number <small>(if you have one)</small><input id="rg_licence_no"></label></div>
      <label class="check" data-f="admin"><input type="checkbox" id="rgAdmin"> I'll manage my company's drivers and staff (company administrator)</label>
      <label>Documents <small id="rgDocHint"></small><input id="rgFiles" type="file" accept="image/*,application/pdf" multiple></label>
      <label>Anything MDA should know <small>(optional)</small><textarea id="rgNote" rows="2"></textarea></label>
      <p class="fine">MDA uses this only to confirm who you are and to contact you about avian influenza. Only MDA staff can see it.</p>
      <button class="primary" id="rgGo">Send request</button></div>`);
    const em = confirmBox("rgEmail", "rgEmailC", "email"), ph = confirmBox("rgPhone", "rgPhoneC", "mobile number");
    const show = () => {
      const t = $("rgT").value, info = TYPES.find((x) => x[0] === t);
      $("rgNeed").textContent = "We'll ask for: " + info[2];
      const vis = { md_reg_no: ["grower", "breeder"].includes(t), npip_id: t === "breeder", usdot: t === "hauler", employer: t === "worker", licence_no: !["grower", "breeder", "hauler", "worker"].includes(t), admin: COMPANY.includes(t) };
      document.querySelectorAll(".reg [data-f]").forEach((el) => (el.hidden = !vis[el.dataset.f]));
      $("rgDocHint").textContent = "(" + DOCS[t] + " Photos or PDFs, up to 4)";
    };
    $("rgT").onchange = show; show();
    $("rgGo").onclick = async () => {
      const t = $("rgT").value, v = (id) => ($(id) ? $(id).value.trim() : "");
      if (!v("rgName")) return toast("Enter your full name");
      if (!em.proof) return toast("Confirm your email with the code first");
      if (v("rgPhone") && !ph.proof && !confirm("Your mobile number isn't confirmed. MDA may take longer to check your request. Send it anyway?")) return;
      const need = { grower: ["md_reg_no"], breeder: ["md_reg_no", "npip_id"], hauler: ["usdot"], worker: ["employer"] }[t] || [];
      for (const f of need) if (!v("rg_" + f)) return toast("Fill in " + document.querySelector(`[data-f="${f}"] label`).firstChild.textContent.trim());
      const files = [...$("rgFiles").files].slice(0, 4);
      if (files.some((f) => f.size > 6e6)) return toast("Each document must be smaller than 6 MB");
      const data = { btype: t, name: v("rgName"), company: v("rgOrg"), email: v("rgEmail"), emailProof: em.proof, phone: v("rgPhone"), phoneProof: ph.proof, address: v("rgAddr"), county: v("rgCty"),
        md_reg_no: v("rg_md_reg_no"), npip_id: v("rg_npip_id"), usdot: v("rg_usdot"), employer: v("rg_employer"), licence_no: v("rg_licence_no"), companyAdmin: COMPANY.includes(t) && $("rgAdmin").checked, note: v("rgNote") };
      const fd = new FormData(); fd.append("data", JSON.stringify(data)); files.forEach((f) => fd.append("files", f, f.name));
      $("rgGo").disabled = true; $("rgGo").textContent = "Sending…";
      try { await api("/register", fd); closeSheet(); sheet("Request sent", `<div class="form"><p>Thank you. MDA will check your details and let you know by email${data.phone ? " or text" : ""}.</p><p class="hint">Once you're approved, sign in with the same email or mobile number. Questions? Call MDA at ${esc(C.mdaPhone)}.</p><button class="primary" id="rgOk">OK</button></div>`); $("rgOk").onclick = closeSheet; }
      catch (e) { toast(e.message, 6000); $("rgGo").disabled = false; $("rgGo").textContent = "Send request"; }
    };
  };

  // ---------------- MDA asked for more information (link in the email or text) ----------------
  function moreForm(ticket) {
    if (!ready()) return notReady();
    sheet("MDA asked for more information", `<div class="form">
      <p class="hint">The message from MDA explains what's needed. Answer below and add documents if they asked for them.</p>
      <label>Your answer<textarea id="mrR" rows="4"></textarea></label>
      <details><summary>Correct a number or your address</summary>
        <div class="two"><label>Premises registration no.<input id="mr_md_reg_no"></label><label>NPIP no.<input id="mr_npip_id"></label></div>
        <div class="two"><label>USDOT no.<input id="mr_usdot" inputmode="numeric"></label><label>Licence no.<input id="mr_licence_no"></label></div>
        <label>Employer<input id="mr_employer"></label><label>Address<input id="mr_address"></label></details>
      <label>Documents <small>(photos or PDFs, up to 4)</small><input id="mrF" type="file" accept="image/*,application/pdf" multiple></label>
      <button class="primary" id="mrGo">Send to MDA</button></div>`);
    $("mrGo").onclick = async () => {
      const fd = new FormData(); fd.append("ticket", ticket); fd.append("reply", $("mrR").value.trim());
      ["md_reg_no", "npip_id", "usdot", "licence_no", "employer", "address"].forEach((k) => { const x = $("mr_" + k).value.trim(); if (x) fd.append(k, x); });
      [...$("mrF").files].slice(0, 4).forEach((f) => fd.append("files", f, f.name));
      if (!$("mrR").value.trim() && !$("mrF").files.length) return toast("Write an answer or add a document");
      $("mrGo").disabled = true;
      try { await api("/more", fd); closeSheet(); history.replaceState(null, "", location.pathname + location.search); toast("Sent. MDA will look at it soon.", 5000); }
      catch (e) { toast(e.message, 6000); $("mrGo").disabled = false; }
    };
  }
  if (location.hash.startsWith("#more=")) setTimeout(() => moreForm(decodeURIComponent(location.hash.slice(6))), 600);

  // ---------------- preview: MDA staff look at the tool as each audience ----------------
  // (C.preview only: your computer and the private preview link). The industry view signs in as a built-in
  // test grower, saved with the MDA sign-in, so it shows exactly what a partner sees.
  const PV_EMAIL = "preview.grower@example.org", PV_FLAG = "hpai.previewStaff";
  S.previewStaff = (() => { try { return !!localStorage.getItem(PV_FLAG); } catch (e) { return false; } })();
  ctx.previewAs = async (w) => {
    if (!C.preview) return;
    const leaveIndustry = () => { try { localStorage.removeItem("hpai.session"); localStorage.removeItem(PV_FLAG); } catch (e) {} S.session = null; S.previewStaff = false; };
    if (w === "industry") {
      try {
        if (!ctx.token()) await ctx.esriId.checkSignInStatus(ctx.sharing);
        const U = C.submitMda.accounts;
        const f = (await ctx.restRaw(U + "/query", { where: `LOWER(email) = '${PV_EMAIL}' AND status = 'Approved'`, outFields: "*", returnGeometry: false })).features || [];
        let a = f.length && f[0].attributes;
        if (!a) {
          a = { acct_id: crypto.randomUUID(), btype: "grower", role: "Preview account", name: "Preview Grower", org: "Preview Farms (test)", email: PV_EMAIL, phone: "", county: "Wicomico",
            status: "Approved", created: Date.now(), decided: Date.now(), decided_by: S.user.username, expires: Date.now() + 365 * DAY, scope: "movement,checkins", company_admin: 1, email_ok: 1,
            checks: JSON.stringify([{ k: "demo", label: "Built-in preview account for testing", state: "info", detail: "Used by MDA staff to see the industry partner view." }]) };
          await ctx.restRaw(U + "/applyEdits", { adds: JSON.stringify([{ attributes: a }]) });
        }
        try { localStorage.setItem(PV_FLAG, "1"); } catch (e) {}
        S.previewStaff = true;
        ctx.ind.start("demo." + a.acct_id, { id: a.acct_id, name: a.name, company: a.org, btype: a.btype, email: a.email, county: a.county, expires: a.expires, scope: a.scope, companyAdmin: true });
        toast("Previewing as an industry partner (test grower)", 4000);
      } catch (e) { toast("Couldn't open the industry view: " + e.message, 6000); }
      return;
    }
    if (S.session) { leaveIndustry(); location.hash = ""; return location.reload(); }   // back to the MDA sign-in
    S.role = "regulator"; ctx.setWorkspace(w);
    toast(w === "public" ? "Previewing the public view" : "Back to the MDA staff view", 3000);
  };

  // ---------------- company administrator: my people ----------------
  ctx.actions.companyPeople = async () => {
    sheet("My company's people", `<div class="form"><p class="hint">Add your drivers and staff so they can sign in with their own email or mobile number. Remove anyone who leaves. MDA sees every change.</p>
      <div id="cpList"><p class="hint">Loading…</p></div>
      <h4>Add a person</h4><div class="two"><label>Name<input id="cpN"></label><label>Job<select id="cpR"><option value="driver">Driver</option><option value="worker">Farm or plant worker</option><option value="office">Office or manager</option></select></label></div>
      <div class="two"><label>Email<input id="cpE" type="email"></label><label>Mobile<input id="cpP" type="tel"></label></div>
      <button class="primary" id="cpAdd">Add</button></div>`);
    const load = async () => {
      try {
        const r = await api("/company/list", {});
        $("cpList").innerHTML = r.people.length ? r.people.map((p) => `<div class="prow"><span class="tx"><b>${esc(p.name)}</b><small>${esc(p.email || p.phone)} · ${p.status === "New" ? "waiting for MDA" : esc(p.status)}${p.last_login ? " · last sign-in " + fmtDate(p.last_login) : ""}</small></span>${p.status === "Revoked" ? "" : `<button class="mini no" data-id="${esc(p.id)}">Remove</button>`}</div>`).join("") : `<p class="hint">No one added yet.</p>`;
        $("cpList").querySelectorAll("[data-id]").forEach((b) => (b.onclick = async () => { if (!confirm("Remove this person's access?")) return; try { await api("/company/remove", { id: b.dataset.id }); load(); } catch (e) { toast(e.message); } }));
      } catch (e) { $("cpList").innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
    };
    $("cpAdd").onclick = async () => {
      try { const r = await api("/company/add", { name: $("cpN").value, role: $("cpR").value, email: $("cpE").value, phone: $("cpP").value }); ["cpN", "cpE", "cpP"].forEach((i) => ($(i).value = "")); toast(r.status === "Approved" ? "Added. They can sign in now." : "Added. MDA will confirm, then they can sign in.", 5000); load(); }
      catch (e) { toast(e.message, 5000); }
    };
    load();
  };
});
