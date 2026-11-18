/* "View as": lets signed-in MDA staff see the tool exactly as an industry partner does, without a separate account.
 * The industry view normally talks to the sign-in service (worker/). In View as, those calls are answered here instead,
 * using the staff member's own ArcGIS sign-in and a built-in test grower record (preview.grower@example.org).
 * Only what the industry view needs to *show* is allowed: reading its own records and planning trips. Sign-in,
 * registration, messages and adding or removing people always go to the real service, never through here.
 */
(function (H) {
  const q = (s) => String(s == null ? "" : s).replace(/'/g, "''");
  const fail = (m) => { throw new Error(m); };
  const active = (a) => a && a.status === "Approved" && (!a.expires || a.expires > Date.now());
  const userOf = (a) => ({ id: a.acct_id, name: a.name, company: a.org, btype: a.btype, email: a.email, phone: a.phone, county: a.county, expires: a.expires, scope: a.scope || "", companyAdmin: !!a.company_admin });
  H.PREVIEW_PREFIX = "preview.";

  H.previewApi = async function (path, body, ctx) {
    const { C } = ctx, U = C.submitMda.accounts;
    if (!ctx.token()) { try { await ctx.esriId.checkSignInStatus(ctx.sharing); } catch (e) { fail("View as needs an MDA staff sign-in. Sign in again."); } }
    const R = (u, p) => ctx.restRaw(u, p);
    const me = async () => {
      const t = ctx.ind.token() || ""; if (!t.startsWith(H.PREVIEW_PREFIX)) fail("Please sign in again.");
      const a = ((await R(U + "/query", { where: `acct_id = '${q(t.slice(H.PREVIEW_PREFIX.length))}'`, outFields: "*", returnGeometry: false })).features || [])[0];
      if (!a || !active(a.attributes)) fail("The preview account isn't active."); return a.attributes;
    };
    if (path === "/me") return { user: userOf(await me()) };
    if (path === "/arcgis") {
      const a = await me(), T = {
        trips: { url: C.movementMda.trips, own: 1, ops: ["query"] }, visits: { url: C.movementMda.visits, own: 1, ops: ["query"] },
        permits: { url: C.movementMda.permits, own: 1, ops: ["query"] },
        farms: { url: C.farmsUrl, ops: ["query"], fields: "OBJECTID" }, industryVisits: { url: C.industryVisits, ops: ["query"] }, route: { url: C.routeUrl, ops: ["", "solve"] } }[body.target];
      if (!T) fail("Not available in View as.");
      if (!T.ops.includes(body.op)) fail("View as only shows what an industry partner sees. Saving trips, permits or check-ins is turned off so no test records are created.");
      const p = Object.assign({}, body.params || {});
      if (body.op === "query") { if (T.own) p.where = `(${p.where || "1=1"}) AND acct_id = '${q(a.acct_id)}'`; if (T.fields) p.outFields = T.fields; }
      return R(body.op ? T.url + "/" + body.op : T.url, p);
    }
    if (path === "/company/list") { await me(); return { people: [] }; }
    if (path === "/places") return {};   // View as keeps places on this device only
    fail("Not available in View as. Industry partners do this with their own sign-in.");
  };
})(window.HPAI);
