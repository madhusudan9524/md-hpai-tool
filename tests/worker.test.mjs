// node tests/worker.test.mjs — sign-in service flow with fake ArcGIS, email, FMCSA and geocoder
import assert from "node:assert/strict";
import W, { normContact, similar } from "../worker/index.js";

const kv = new Map();
const KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) };
const env = { KV, SESSION_SECRET: "x".repeat(40), ARCGIS_TOKEN: "svc", RESEND_API_KEY: "re", MAIL_FROM: "a@b.c", FMCSA_WEBKEY: "fk", APP_ORIGINS: "https://app.test", APP_URL: "https://app.test/",
  ACCOUNTS_URL: "https://ago/acc", REGISTRY_URL: "https://ago/reg", AUDIT_URL: "https://ago/audit", MOVEMENT_URL: "https://ago/mv", FARMS_URL: "https://ago/farms", ROUTE_URL: "https://ago/route", REGULATOR_GROUP: "MD HPAI Regulators", PORTAL_URL: "https://portal" };

const accounts = []; let oid = 0; const mails = []; const agoCalls = [];
const where = (w, a) => {   // tiny evaluator for the WHERE clauses the worker uses
  return w.split(" OR ").some((part) => {
    let m;
    if ((m = /LOWER\(email\) = '([^']*)'/.exec(part))) return (a.email || "").toLowerCase() === m[1];
    if ((m = /phone = '([^']*)'/.exec(part))) return a.phone === m[1];
    if ((m = /usdot = '([^']*)'/.exec(part))) return a.usdot === m[1];
    if ((m = /md_reg_no = '([^']*)'/.exec(part))) return a.md_reg_no === m[1];
    if ((m = /acct_id = '([^']*)'/.exec(part))) return a.acct_id === m[1];
    if ((m = /sponsor_id = '([^']*)'/.exec(part))) return a.sponsor_id === m[1];
    return false;
  }) && (!/acct_id <> '([^']*)'/.test(w) || a.acct_id !== /acct_id <> '([^']*)'/.exec(w)[1]);
};
globalThis.fetch = async (u, o = {}) => {
  u = String(u); const body = o.body instanceof URLSearchParams ? Object.fromEntries(o.body) : null;
  const J = (x) => new Response(JSON.stringify(x), { headers: { "content-type": "application/json" } });
  if (u.startsWith("https://api.resend.com")) { mails.push(JSON.parse(o.body)); return J({ id: 1 }); }
  if (u.startsWith("https://mobile.fmcsa.dot.gov")) return J({ content: { carrier: { legalName: "SHORE POULTRY TRUCKING LLC", allowedToOperate: "Y", statusCode: "A", phyCity: "SALISBURY", phyState: "MD", totalPowerUnits: 12 } } });
  if (u.startsWith("https://geocode.arcgis.com")) return J({ candidates: [{ address: "100 Main St, Salisbury, Maryland", score: 98, location: { x: -75.6, y: 38.36 }, attributes: { RegionAbbr: "MD", Subregion: "Wicomico County" } }] });
  if (u.startsWith("https://portal/sharing/rest/community/self")) return J(u.includes("token=mda") ? { username: "mda1", groups: [{ title: "MD HPAI Regulators" }] } : { username: "x", groups: [] });
  if (u.startsWith("https://ago/")) {
    agoCalls.push({ u, body });
    if (u === "https://ago/acc/query") return J({ features: accounts.filter((a) => where(body.where, a)).map((a) => ({ attributes: a })) });
    if (u === "https://ago/acc/applyEdits") {
      if (body.adds) { const r = JSON.parse(body.adds).map((f) => { accounts.push(Object.assign({ OBJECTID: ++oid }, f.attributes)); return { objectId: oid, success: true }; }); return J({ addResults: r }); }
      JSON.parse(body.updates).forEach((f) => Object.assign(accounts.find((a) => a.OBJECTID === f.attributes.OBJECTID), f.attributes)); return J({ updateResults: [{ success: true }] });
    }
    if (u === "https://ago/reg/query") return J({ features: body.where.includes("MD-1234") ? [{ attributes: { premises_id: "P1", name: "Green Acres", operator: "Ann Grower", county: "Wicomico", houses: 4 }, centroid: { x: -75.5, y: 38.4 } }] : [] });
    if (u.endsWith("/addAttachment")) return J({ addAttachmentResult: { success: true } });
    return J({ ok: true, features: [], addResults: [{ success: true }] });
  }
  throw new Error("unexpected fetch " + u);
};

const call = async (path, b, headers = {}) => {
  const isForm = b instanceof FormData;
  const r = await W.fetch(new Request("https://w.test" + path, { method: b === undefined ? "GET" : "POST", headers: Object.assign({ origin: "https://app.test" }, isForm ? {} : { "content-type": "application/json" }, headers), body: b === undefined ? undefined : isForm ? b : JSON.stringify(b) }), env, { waitUntil() {} });
  return { status: r.status, j: await r.json(), cors: r.headers.get("access-control-allow-origin") };
};
const lastCode = () => /\b(\d{6})\b/.exec(mails[mails.length - 1].text)[1];

// contact normalisation and name matching
assert.equal(normContact("(410) 555-0100").v, "+14105550100");
assert.equal(normContact(" Ann@Farm.COM ").v, "ann@farm.com");
assert.ok(similar("Shore Poultry Trucking LLC", "Shore Poultry") >= 0.5);

// 1. register: confirm the email with a code
let r = await call("/code", { contact: "ann@farm.com", purpose: "register" });
assert.equal(r.status, 200); assert.equal(r.cors, "https://app.test");
r = await call("/verify", { contact: "ann@farm.com", code: "000000", purpose: "register" });
assert.equal(r.status, 400, "wrong code rejected");
r = await call("/verify", { contact: "ann@farm.com", code: lastCode(), purpose: "register" });
assert.ok(r.j.proof, "proof issued");
const proof = r.j.proof;

// missing credential is refused
let fd = new FormData(); fd.append("data", JSON.stringify({ btype: "grower", emailProof: proof, email: "ann@farm.com", name: "Ann Grower", company: "Green Acres" }));
r = await call("/register", fd); assert.equal(r.status, 400); assert.match(r.j.error, /registration number/);

fd = new FormData(); fd.append("data", JSON.stringify({ btype: "grower", emailProof: proof, email: "ann@farm.com", name: "Ann Grower", company: "Green Acres", county: "Wicomico", address: "100 Main St Salisbury MD", md_reg_no: "MD-1234", phone: "410-555-0100" }));
fd.append("files", new Blob(["%PDF-1.4"], { type: "application/pdf" }), "registration.pdf");
r = await call("/register", fd); assert.equal(r.status, 200, JSON.stringify(r.j));
const ann = accounts[0];
assert.equal(ann.status, "New"); assert.equal(ann.phone, "+14105550100");
const checks = JSON.parse(ann.checks), byK = Object.fromEntries(checks.map((c) => [c.k, c]));
assert.equal(byK.email.state, "ok"); assert.equal(byK.md_reg_no.state, "ok"); assert.equal(byK.md_reg_no.data.premises_id, "P1"); assert.equal(byK.address.state, "ok"); assert.equal(byK.phone.state, "warn");
assert.ok(agoCalls.some((c) => c.u.endsWith("/addAttachment")), "document attached");

// 2. not approved yet → no code, a private explanation instead
mails.length = 0;
r = await call("/code", { contact: "ann@farm.com", purpose: "signin" });
assert.equal(r.status, 200); assert.match(mails[0].text, /waiting for MDA review/);

// 3. unknown person → same answer, nothing sent
mails.length = 0;
r = await call("/code", { contact: "nobody@x.com", purpose: "signin" }); assert.equal(r.status, 200); assert.equal(mails.length, 0);

// 4. MDA approves (the app writes the record; the worker sends the message)
Object.assign(ann, { status: "Approved", expires: Date.now() + 365 * 864e5, scope: "movement,checkins", company_admin: 1 });
r = await call("/mda/notify", { id: ann.acct_id, kind: "approved" }, { authorization: "Bearer nope" }); assert.equal(r.status, 403, "non-MDA refused");
r = await call("/mda/notify", { id: ann.acct_id, kind: "approved" }, { authorization: "Bearer mda" }); assert.equal(r.status, 200); assert.deepEqual(r.j.sent, ["email"]);
r = await call("/mda/notify", { id: ann.acct_id, kind: "ask", message: "Send a photo of your registration card." }, { authorization: "Bearer mda" });
assert.match(mails[mails.length - 1].text, /#more=/);

// 5. sign in
mails.length = 0;
await call("/code", { contact: "ann@farm.com", purpose: "signin" });
r = await call("/verify", { contact: "ann@farm.com", code: lastCode(), purpose: "signin" });
assert.ok(r.j.token); assert.equal(r.j.user.name, "Ann Grower");
const auth = { authorization: "Bearer " + r.j.token };
r = await call("/me", undefined, auth); assert.equal(r.j.user.company, "Green Acres");

// 6. map data: own records only, owner stamped on adds, nothing else allowed
agoCalls.length = 0;
await call("/arcgis", { target: "permits", op: "query", params: { where: "1=1", outFields: "*" } }, auth);
assert.match(agoCalls[0].body.where, new RegExp(`acct_id = '${ann.acct_id}'`));
await call("/arcgis", { target: "permits", op: "addFeatures", params: { features: JSON.stringify([{ attributes: { status: "Approved", acct_id: "someone-else" } }]) } }, auth);
const added = JSON.parse(agoCalls.find((c) => c.u === "https://ago/mv/2/addFeatures").body.features)[0].attributes;
assert.equal(added.acct_id, ann.acct_id); assert.equal(added.status, "Pending", "can't self-approve a permit");
r = await call("/arcgis", { target: "permits", op: "deleteFeatures", params: {} }, auth); assert.equal(r.status, 403);
r = await call("/arcgis", { target: "accounts", op: "query", params: {} }, auth); assert.equal(r.status, 403);
agoCalls.length = 0; await call("/arcgis", { target: "farms", op: "query", params: { where: "1=1", outFields: "*" } }, auth);
assert.equal(agoCalls[0].body.outFields, "OBJECTID", "farm details hidden");

// 7. company administrator adds and removes a driver
r = await call("/company/add", { name: "Bob Driver", phone: "4105550199" }, auth); assert.equal(r.status, 200); assert.equal(r.j.status, "New");
const bob = accounts.find((a) => a.name === "Bob Driver"); assert.equal(bob.sponsor_id, ann.acct_id);
assert.equal(Object.fromEntries(JSON.parse(bob.checks).map((c) => [c.k, c])).sponsor.state, "ok");
r = await call("/company/list", {}, auth); assert.equal(r.j.people.length, 1);
r = await call("/company/remove", { id: bob.acct_id }, auth); assert.equal(bob.status, "Revoked");

// 8. revoked → session stops working (after the 1-minute cache)
ann.status = "Revoked";
r = await call("/mda/notify", { id: ann.acct_id, kind: "revoked" }, { authorization: "Bearer mda" });   // also clears the cache
r = await call("/me", undefined, auth); assert.equal(r.status, 401);

// 9. hauler: USDOT checked against FMCSA
mails.length = 0;
await call("/code", { contact: "ops@shorepoultry.com", purpose: "register" });
const p2 = (await call("/verify", { contact: "ops@shorepoultry.com", code: lastCode(), purpose: "register" })).j.proof;
fd = new FormData(); fd.append("data", JSON.stringify({ btype: "hauler", emailProof: p2, email: "ops@shorepoultry.com", name: "Cal Hauler", company: "Shore Poultry", usdot: "1234567", address: "100 Main St Salisbury MD" }));
r = await call("/register", fd); assert.equal(r.status, 200);
const cal = accounts.find((a) => a.name === "Cal Hauler"), ck = Object.fromEntries(JSON.parse(cal.checks).map((c) => [c.k, c]));
assert.equal(ck.usdot.state, "ok"); assert.equal(ck.usdot.data.legalName, "SHORE POULTRY TRUCKING LLC"); assert.equal(ck.domain.state, "ok");

// 10. member of the public: email code only, no approval, saved places kept and deletable
mails.length = 0;
r = await call("/code", { contact: "+14105550123", purpose: "user" }); assert.equal(r.status, 400, "members sign in with email only");
r = await call("/code", { contact: "Dee@Home.org", purpose: "user" }); assert.equal(r.status, 200);
r = await call("/verify", { contact: "dee@home.org", code: lastCode(), purpose: "user" }); assert.equal(r.status, 200); assert.equal(r.j.user.email, "dee@home.org");
const mem = { authorization: "Bearer " + r.j.token };
assert.equal(accounts.filter((a) => a.email === "dee@home.org").length, 0, "no account record, nothing else stored");
r = await call("/places", undefined, mem); assert.equal(r.j.places, null);
r = await call("/places", { places: [{ id: "P1", name: "Home", kind: "home", lon: -76.5, lat: 38.9, alert: { email: "dee@home.org", token: "U1", km: 9.656 } }, { id: "", name: "bad", lon: 1, lat: 1 }] }, mem);
assert.equal(r.j.n, 1, "invalid places dropped");
r = await call("/places", undefined, mem); assert.equal(r.j.places[0].name, "Home"); assert.equal(r.j.places[0].alert.token, "U1");
r = await call("/me", undefined, mem); assert.equal(r.status, 401, "a member token isn't an industry session");
r = await call("/u/delete", {}, mem); r = await call("/places", undefined, mem); assert.equal(r.j.places, null);

console.log("worker: all checks passed");
