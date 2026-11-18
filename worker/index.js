// Industry partner sign-in and verification service (Cloudflare Worker)
//
// What it does
//  - Email or text sign-in with a 6-digit code (no ArcGIS account needed for industry partners)
//  - Registration: confirms the email (and phone) with a code, stores the request with documents,
//    and runs automatic checks (USDOT via FMCSA, Maryland premises registration and NPIP numbers
//    against MDA's registry, address, phone line type, duplicates, earlier denials)
//  - Passes industry partners' map requests to ArcGIS with a service account, and only ever lets
//    them see and add their own trips, visits and permits
//  - Lets company administrators add and remove their own drivers and staff
//  - Tells applicants when MDA approves, denies or asks for more information
//
// Endpoints (JSON unless noted)
//  POST /code            {contact, purpose: "signin"|"register"}
//  POST /verify          {contact, code, purpose}          → signin: {token, user} · register: {proof}
//  POST /register        multipart: data (JSON) + files     → {ok, id}
//  POST /more            multipart: ticket, reply, files    → {ok}
//  GET  /me              Bearer session                     → {user}
//  POST /arcgis          Bearer session {target, op, params}
//  POST /company/list    Bearer session (company admin)
//  POST /company/add     Bearer session (company admin) {name, email, phone, role}
//  POST /company/remove  Bearer session (company admin) {id}
//  POST /mda/recheck     Bearer ArcGIS token (MDA staff) {id}
//  POST /mda/notify      Bearer ArcGIS token (MDA staff) {id, kind: ask|approved|denied|revoked|renewed, message}
//
// Settings: see wrangler.toml and worker/README.md

const DAY = 86400000;
const PERSONAL = /(^|\.)(gmail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|comcast|verizon|att|sbcglobal|protonmail|proton|gmx|mail|zoho)\.(com|net|me)$/i;
const DELMARVA = ["MD", "DE", "VA", "PA", "WV"];

export default {
  async fetch(req, env, cx) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "");
    try {
      let out;
      if (p === "/code") out = await sendCode(await req.json(), env, req);
      else if (p === "/verify") out = await verifyCode(await req.json(), env);
      else if (p === "/register") out = await register(await req.formData(), env, cx);
      else if (p === "/more") out = await moreInfo(await req.formData(), env);
      else if (p === "/me") out = { user: publicUser(await session(req, env)) };
      else if (p === "/arcgis") out = await proxy(await session(req, env), await req.json(), env);
      else if (p.startsWith("/company/")) out = await company(p.slice(9), await session(req, env), await req.json(), env);
      else if (p === "/mda/recheck") out = await mdaRecheck(await mdaUser(req, env), await req.json(), env);
      else if (p === "/mda/notify") out = await mdaNotify(await mdaUser(req, env), await req.json(), env);
      else if (p === "/health/arcgis") out = await healthArcgis(env);
      else if (p === "" || p === "/health") out = { ok: true, email: !!env.RESEND_API_KEY, sms: !!env.TWILIO_SID, usdot: !!env.FMCSA_WEBKEY, arcgis: !!(env.ARCGIS_TOKEN || env.ARCGIS_USERNAME || env.ARCGIS_CLIENT_ID) };
      else throw err(404, "Not found");
      return json(out, 200, cors);
    } catch (e) {
      return json({ error: e.public || (e.status ? e.message : "Something went wrong. Please try again.") }, e.status || 500, cors);
    }
  }
};

// can the service read and write the layers it needs? (open http://localhost:8787/health/arcgis)
async function healthArcgis(env) {
  const out = {};
  for (const [k, u] of [["accounts", env.ACCOUNTS_URL], ["registry", env.REGISTRY_URL], ["movement", env.MOVEMENT_URL + "/2"], ["farms", env.FARMS_URL]]) {
    try { const r = await ago(env, u + "/query", { where: "1=1", returnCountOnly: true }); out[k] = "ok (" + r.count + " records)"; } catch (e) { out[k] = "NO ACCESS: " + (e.public || e.message); }
  }
  return out;
}

// ---------------------------------------------------------------- helpers
function err(status, message) { const e = new Error(message); e.status = status; e.public = message; return e; }
function json(o, status, headers) { return new Response(JSON.stringify(o), { status, headers: Object.assign({ "content-type": "application/json" }, headers) }); }
function corsHeaders(req, env) {
  const origin = req.headers.get("origin") || "", allowed = String(env.APP_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes("*") || allowed.includes(origin);
  return ok ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", vary: "origin" } : {};
}
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function hmac(env, data) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw err(500, "The sign-in service isn't set up yet.");
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
async function sign(env, payload) { const body = b64u(new TextEncoder().encode(JSON.stringify(payload))); return body + "." + (await hmac(env, body)); }
async function unsign(env, token, kind) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || sig !== (await hmac(env, body))) throw err(401, "Please sign in again.");
  const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
  if (p.k !== kind || p.exp < Date.now()) throw err(401, kind === "s" ? "Your sign-in has expired. Please sign in again." : "This link or code has expired.");
  return p;
}
async function sha(s) { return b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
const q = (s) => String(s == null ? "" : s).replace(/'/g, "''");
const clip = (s, n) => String(s == null ? "" : s).trim().slice(0, n);

// email or phone → normalized form
export function normContact(c) {
  c = String(c || "").trim();
  if (c.includes("@")) { c = c.toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c)) throw err(400, "Enter a valid email address."); return { kind: "email", v: c }; }
  let d = c.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = "+" + d.slice(1).replace(/\D/g, ""); else { d = d.replace(/\D/g, ""); if (d.length === 10) d = "+1" + d; else if (d.length === 11 && d[0] === "1") d = "+" + d; }
  if (!/^\+\d{10,15}$/.test(d)) throw err(400, "Enter a valid email address or mobile number.");
  return { kind: "phone", v: d };
}

// simple rate limit in KV (per key, per hour)
async function limit(env, key, max) {
  if (!env.KV) return;
  const k = "rl:" + key + ":" + Math.floor(Date.now() / 3600000), n = +(await env.KV.get(k)) || 0;
  if (n >= max) throw err(429, "Too many tries. Please wait an hour or call MDA.");
  await env.KV.put(k, String(n + 1), { expirationTtl: 3700 });
}

// ---------------------------------------------------------------- ArcGIS (service account)
let tok = null;
async function agoToken(env) {
  if (env.ARCGIS_TOKEN) return env.ARCGIS_TOKEN;
  if (tok && tok.exp > Date.now() + 120000) return tok.t;
  if (env.ARCGIS_CLIENT_ID) {   // the map's app registration (Client ID + secret) — works with university (SSO) logins
    const r = await fetch((env.PORTAL_URL || "https://www.arcgis.com") + "/sharing/rest/oauth2/token", { method: "POST", body: new URLSearchParams({ client_id: env.ARCGIS_CLIENT_ID, client_secret: env.ARCGIS_CLIENT_SECRET, grant_type: "client_credentials", expiration: "120", f: "json" }) }).then((x) => x.json());
    if (!r.access_token) throw err(500, "The sign-in service couldn't reach the map data (check the client ID and secret).");
    tok = { t: r.access_token, exp: Date.now() + (r.expires_in || 7200) * 1000 }; return r.access_token;
  }
  if (!env.ARCGIS_USERNAME) throw err(500, "The sign-in service isn't connected to the map data yet.");
  const r = await fetch((env.PORTAL_URL || "https://www.arcgis.com") + "/sharing/rest/generateToken", { method: "POST", body: new URLSearchParams({ username: env.ARCGIS_USERNAME, password: env.ARCGIS_PASSWORD, client: "referer", referer: env.APP_URL || "https://localhost", expiration: "120", f: "json" }) }).then((x) => x.json());
  if (!r.token) throw err(500, "The sign-in service couldn't reach the map data.");
  tok = { t: r.token, exp: r.expires }; return r.token;
}
async function ago(env, url, params, opts) {
  const body = new URLSearchParams(Object.assign({ f: "json" }, params || {}));
  body.set("token", await agoToken(env));
  if (opts && opts.referer) body.set("referer", opts.referer);
  const r = await fetch(url, { method: "POST", body, headers: { referer: env.APP_URL || "https://localhost" } });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message); e.status = 502; e.public = "The map data service returned an error: " + j.error.message; throw e; }
  return j;
}
const rows = async (env, url, where, extra) => (await ago(env, url + "/query", Object.assign({ where, outFields: "*", returnGeometry: false }, extra || {}))).features || [];
async function audit(env, who, action, target, details) {
  if (!env.AUDIT_URL) return;
  try { await ago(env, env.AUDIT_URL + "/applyEdits", { adds: JSON.stringify([{ attributes: { at: Date.now(), who: clip(who, 80), action, target: clip(target, 250), details: clip(details, 1000) } }]) }); } catch (e) {}
}

// ---------------------------------------------------------------- sending
async function sendEmail(env, to, subject, text) {
  if (!env.RESEND_API_KEY) throw err(503, "Email codes aren't set up yet. Try a mobile number, or call MDA.");
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }) });
  if (!r.ok) throw err(502, "We couldn't send the email. Please try again.");
}
async function sendSms(env, to, text) {
  if (!env.TWILIO_SID) throw err(503, "Text messages aren't set up yet. Use your email address, or call MDA.");
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, { method: "POST", headers: { authorization: "Basic " + btoa(env.TWILIO_SID + ":" + env.TWILIO_TOKEN) }, body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: text }) });
  if (!r.ok) throw err(502, "We couldn't send the text. Please try again.");
}
const send = (env, c, subject, text) => c.kind === "email" ? sendEmail(env, c.v, subject, text) : sendSms(env, c.v, text);
async function notifyAccount(env, a, subject, text) {   // email first, text as well when there's a mobile number
  const done = [];
  if (a.email) try { await sendEmail(env, a.email, subject, text); done.push("email"); } catch (e) {}
  if (a.phone && /^\+\d{10,15}$/.test(a.phone) && env.TWILIO_SID) try { await sendSms(env, a.phone, text.split("\n\n")[0].slice(0, 300)); done.push("text"); } catch (e) {}
  return done;
}

// ---------------------------------------------------------------- accounts
async function accountByContact(env, c) {
  const where = c.kind === "email" ? `LOWER(email) = '${q(c.v)}'` : `phone = '${q(c.v)}'`;
  const f = await rows(env, env.ACCOUNTS_URL, where, { orderByFields: "created DESC" });
  const list = f.map((x) => x.attributes);
  return list.find((a) => a.status === "Approved") || list[0] || null;
}
async function accountById(env, id) {
  const f = await rows(env, env.ACCOUNTS_URL, `acct_id = '${q(id)}'`);
  return f.length ? f[0].attributes : null;
}
const isActive = (a) => a && a.status === "Approved" && (!a.expires || a.expires > Date.now());
const publicUser = (a) => ({ id: a.acct_id, name: a.name, company: a.org, btype: a.btype || a.role, email: a.email, phone: a.phone, county: a.county, expires: a.expires, scope: a.scope || "", companyAdmin: !!a.company_admin });

// ---------------------------------------------------------------- /code and /verify
async function sendCode(b, env, req) {
  const c = normContact(b.contact), purpose = b.purpose === "register" ? "register" : "signin";
  await limit(env, "c:" + c.v, 5); await limit(env, "ip:" + (req.headers.get("cf-connecting-ip") || "?"), 30);
  const generic = { ok: true, message: purpose === "signin" ? "If this email or number belongs to an approved industry partner, a code is on its way." : "A code is on its way." };
  if (purpose === "signin") {
    const a = await accountByContact(env, c);
    if (!isActive(a)) {
      // tell the person (privately, in their own inbox) why there's no code
      if (a) {
        const why = a.status === "Approved" ? "Your access has expired. Ask MDA to renew it." : a.status === "Denied" || a.status === "Revoked" ? "Your access isn't active. Contact MDA if you think this is a mistake." : "Your request is still waiting for MDA review. We'll tell you as soon as it's decided.";
        await send(env, c, "Maryland avian influenza map: sign-in", why).catch(() => {});
      }
      return generic;
    }
  }
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  if (!env.KV) throw err(500, "The sign-in service isn't set up yet.");
  await env.KV.put("code:" + c.v, JSON.stringify({ h: await sha(code + env.SESSION_SECRET), p: purpose, n: 0 }), { expirationTtl: 600 });
  await send(env, c, `Your sign-in code: ${code}`, `Your code for the Maryland avian influenza map is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this message.`);
  return generic;
}
async function verifyCode(b, env) {
  const c = normContact(b.contact), purpose = b.purpose === "register" ? "register" : "signin";
  const raw = env.KV && (await env.KV.get("code:" + c.v)); if (!raw) throw err(400, "That code has expired. Ask for a new one.");
  const s = JSON.parse(raw);
  if (s.p !== purpose) throw err(400, "Ask for a new code.");
  if (s.n >= 5) { await env.KV.delete("code:" + c.v); throw err(429, "Too many wrong codes. Ask for a new one."); }
  if ((await sha(String(b.code || "").trim() + env.SESSION_SECRET)) !== s.h) { s.n++; await env.KV.put("code:" + c.v, JSON.stringify(s), { expirationTtl: 600 }); throw err(400, "That code isn't right. Check it and try again."); }
  await env.KV.delete("code:" + c.v);
  if (purpose === "register") return { proof: await sign(env, { k: "p", c: c.v, exp: Date.now() + 2 * 3600000 }) };
  const a = await accountByContact(env, c);
  if (!isActive(a)) throw err(403, "Your access isn't active.");
  await ago(env, env.ACCOUNTS_URL + "/applyEdits", { updates: JSON.stringify([{ attributes: { OBJECTID: a.OBJECTID, last_login: Date.now() } }]) }).catch(() => {});
  await audit(env, "industry:" + a.acct_id, "industry:signin", a.email || a.phone, c.kind);
  const days = +(env.SESSION_DAYS || 30), exp = Math.min(Date.now() + days * DAY, a.expires || Infinity);
  return { token: await sign(env, { k: "s", id: a.acct_id, exp }), user: publicUser(a) };
}

// session: signature + account still approved (checked at most once a minute per account)
const live = new Map();
async function session(req, env) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const p = await unsign(env, t, "s");
  const hit = live.get(p.id);
  if (hit && hit.at > Date.now() - 60000) { if (!isActive(hit.a)) throw err(401, "Your access isn't active."); return hit.a; }
  const a = await accountById(env, p.id);
  live.set(p.id, { a, at: Date.now() });
  if (!isActive(a)) throw err(401, "Your access isn't active. Contact MDA.");
  return a;
}

// ---------------------------------------------------------------- registration
export const TYPES = {
  grower: { label: "Grower / poultry farm", need: ["md_reg_no"] },
  breeder: { label: "Breeder, hatchery or live-bird seller", need: ["md_reg_no", "npip_id"] },
  hauler: { label: "Hauling company", need: ["usdot"] },
  worker: { label: "Driver or farm worker", need: ["employer"] },
  integrator: { label: "Integrator / poultry company", need: [] },
  feed: { label: "Feed mill", need: [] },
  rendering: { label: "Rendering / disposal", need: [] },
  service: { label: "Service provider (vet, crew, equipment)", need: [] },
  other: { label: "Other poultry business", need: [] }
};
const FIELD_NAMES = { md_reg_no: "Maryland premises registration number", npip_id: "NPIP number", usdot: "USDOT number", employer: "employer" };

async function register(fd, env, cx) {
  const d = JSON.parse(fd.get("data") || "{}");
  const t = TYPES[d.btype]; if (!t) throw err(400, "Choose your type of business.");
  const proof = await unsign(env, d.emailProof, "p");
  const email = normContact(d.email); if (email.kind !== "email" || proof.c !== email.v) throw err(400, "Confirm your email with the code first.");
  let phone = null, phoneOk = 0;
  if (d.phone) { phone = normContact(d.phone); if (d.phoneProof) { const pp = await unsign(env, d.phoneProof, "p"); phoneOk = pp.c === phone.v ? 1 : 0; } }
  if (!clip(d.name, 100)) throw err(400, "Enter your full name.");
  for (const f of t.need) if (!clip(d[f], 60)) throw err(400, `Enter your ${FIELD_NAMES[f]}.`);
  await limit(env, "reg:" + email.v, 3);
  const files = fd.getAll("files").filter((f) => f && f.size).slice(0, 4);
  for (const f of files) { if (f.size > 6e6) throw err(400, "Each document must be smaller than 6 MB."); if (!/^(image\/|application\/pdf)/.test(f.type)) throw err(400, "Documents must be photos or PDFs."); }
  const a = {
    acct_id: crypto.randomUUID(), btype: d.btype, role: t.label.slice(0, 20), name: clip(d.name, 100), email: email.v, phone: phone ? phone.v : "",
    org: clip(d.company, 120), county: clip(d.county, 60), address: clip(d.address, 255), md_reg_no: clip(d.md_reg_no, 40), npip_id: clip(d.npip_id, 40),
    usdot: clip(d.usdot, 20).replace(/\D/g, ""), licence_no: clip(d.licence_no, 60), employer: clip(d.employer, 120),
    email_ok: 1, phone_ok: phoneOk, status: "New", created: Date.now(), company_admin: 0, info_reply: clip(d.note, 4000)
  };
  a.company_admin_request = !!d.companyAdmin;
  const checks = await runChecks(env, a);
  if (a.company_admin_request) checks.push({ k: "admin", label: "Wants to be the company administrator", state: "manual", detail: "They'd add and remove their own drivers and staff. Approve only if they can speak for the company." });
  delete a.company_admin_request;
  a.checks = JSON.stringify(checks).slice(0, 8000);
  const r = await ago(env, env.ACCOUNTS_URL + "/applyEdits", { adds: JSON.stringify([{ attributes: a }]) });
  const oid = r.addResults && r.addResults[0] && r.addResults[0].objectId; if (!oid) throw err(502, "We couldn't save your request. Please try again.");
  await attach(env, oid, files);
  await audit(env, "industry:" + a.acct_id, "access:request", a.email, `${t.label} · ${files.length} document(s)`);
  if (env.MDA_NOTIFY_EMAIL) cx && cx.waitUntil && cx.waitUntil(sendEmail(env, env.MDA_NOTIFY_EMAIL, "New industry partner request", `${a.name} (${t.label}, ${a.org || "no company"}) asked for access. Review it in the map: MDA menu → Reviews → Access requests.`).catch(() => {}));
  return { ok: true, id: a.acct_id };
}
async function attach(env, oid, files) {
  for (const f of files) {
    const body = new FormData(); body.append("f", "json"); body.append("token", await agoToken(env));
    body.append("attachment", f, (f.name || "document").replace(/[^\w.\- ]/g, "_").slice(0, 80));
    await fetch(`${env.ACCOUNTS_URL}/${oid}/addAttachment`, { method: "POST", body }).catch(() => {});
  }
}

// applicant answers MDA's question (link from the "more information" message)
async function moreInfo(fd, env) {
  const p = await unsign(env, fd.get("ticket"), "m");
  const a = await accountById(env, p.id); if (!a || a.status !== "Info requested") throw err(400, "This request doesn't need more information right now.");
  const files = fd.getAll("files").filter((f) => f && f.size).slice(0, 4);
  for (const f of files) { if (f.size > 6e6) throw err(400, "Each document must be smaller than 6 MB."); if (!/^(image\/|application\/pdf)/.test(f.type)) throw err(400, "Documents must be photos or PDFs."); }
  const reply = clip(fd.get("reply"), 3000);
  const upd = { OBJECTID: a.OBJECTID, status: "Replied", info_reply: clip(((a.info_reply ? a.info_reply + "\n\n" : "") + `[${new Date().toISOString().slice(0, 10)}] ${reply}`), 4000) };
  for (const k of ["md_reg_no", "npip_id", "usdot", "licence_no", "employer", "address"]) if (fd.get(k)) upd[k] = clip(fd.get(k), k === "address" ? 255 : 60);
  if (upd.usdot) upd.usdot = upd.usdot.replace(/\D/g, "");
  const next = Object.assign({}, a, upd); upd.checks = JSON.stringify(await runChecks(env, next)).slice(0, 8000);
  await ago(env, env.ACCOUNTS_URL + "/applyEdits", { updates: JSON.stringify([{ attributes: upd }]) });
  await attach(env, a.OBJECTID, files);
  await audit(env, "industry:" + a.acct_id, "access:reply", a.email, `${files.length} document(s)`);
  return { ok: true };
}

// ---------------------------------------------------------------- automatic checks
// each check: {k, label, state: ok|warn|fail|manual|info, detail, data?}
export function similar(a, b) {
  const w = (s) => new Set(String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((x) => x && !["llc", "inc", "co", "corp", "corporation", "company", "ltd", "the", "and", "of", "farm", "farms", "trucking", "transport", "services"].includes(x)));
  const A = w(a), B = w(b); if (!A.size || !B.size) return 0;
  let n = 0; A.forEach((x) => B.has(x) && n++); return n / Math.min(A.size, B.size);
}
// "shorepoultry.com" ↔ "Shore Poultry LLC", "spt.com" ↔ "Shore Poultry Trucking"
export function domainMatch(dom, org) {
  const stem = String(dom || "").toLowerCase().split(".").slice(0, -1).join("").replace(/[^a-z0-9]/g, "");
  const words = String(org || "").toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((x) => x && !["llc", "inc", "co", "corp", "ltd", "the", "and", "of"].includes(x));
  if (!stem || !words.length) return false;
  const core = words.filter((x) => !["farm", "farms", "trucking", "transport", "services", "company"].includes(x));
  return (core.length && core.every((x) => stem.includes(x))) || stem === words.map((x) => x[0]).join("") || similar(stem, org) >= 0.5;
}
export async function runChecks(env, a) {
  const out = [], t = TYPES[a.btype] || TYPES.other;
  out.push(a.email_ok ? { k: "email", label: "Email confirmed with a code", state: "ok", detail: a.email } : { k: "email", label: a.sponsor_id ? "Email or number confirmed at first sign-in" : "Email not confirmed", state: a.sponsor_id ? "info" : "fail", detail: a.email || a.phone });
  out.push(a.phone ? { k: "phone", label: a.phone_ok ? "Mobile number confirmed with a code" : "Mobile number not confirmed", state: a.phone_ok ? "ok" : "warn", detail: a.phone } : { k: "phone", label: "No phone number given", state: "warn", detail: "" });
  const dom = ((a.email || "").split("@")[1] || "");
  const dm = domainMatch(dom, a.org);
  out.push(!dom ? null : PERSONAL.test(dom) ? { k: "domain", label: "Personal email address", state: "info", detail: `${dom}: normal for family farms and drivers; for a company, ask for a work email.` }
    : { k: "domain", label: dm ? "Work email matches the company" : "Work email domain doesn't match the company name", state: dm ? "ok" : "info", detail: dom });
  if (!out[out.length - 1]) out.pop();
  await Promise.all([
    a.phone && env.TWILIO_SID ? phoneType(env, a.phone).then((c) => c && out.push(c)) : null,
    a.address ? addressCheck(a.address).then((c) => c && out.push(c)) : out.push({ k: "address", label: "No business or farm address given", state: "warn", detail: "" }),
    duplicates(env, a).then((c) => out.push(...c)),
    a.usdot ? usdot(env, a).then((c) => out.push(c)) : a.btype === "hauler" ? out.push({ k: "usdot", label: "No USDOT number", state: "fail", detail: "Hauling companies need one." }) : null,
    a.md_reg_no ? registry(env, a, "md_reg_no", a.md_reg_no, "Maryland premises registration").then((c) => out.push(c)) : (a.btype === "grower" || a.btype === "breeder") ? out.push({ k: "md_reg_no", label: "No premises registration number", state: "fail", detail: "Required for anyone keeping poultry in Maryland (Agric. Art. § 3-804)." }) : null,
    a.npip_id ? registry(env, a, "npip_id", a.npip_id, "NPIP number").then((c) => out.push(c)) : null,
    a.sponsor_id ? accountById(env, a.sponsor_id).then((s) => out.push(isActive(s) && s.company_admin ? { k: "sponsor", label: `Added by ${s.org || "their company"}`, state: "ok", detail: `${s.name}, the company's approved administrator, added this person.` } : { k: "sponsor", label: "Sponsor isn't an active company administrator", state: "fail", detail: "" })) : null
  ].filter(Boolean));
  if (a.btype === "worker" && !a.sponsor_id) out.push({ k: "employer", label: `Employer: ${a.employer || "not given"}`, state: "manual", detail: "Confirm with the employer, or ask the company's administrator to add this person." });
  if (a.licence_no) out.push({ k: "licence", label: `Licence or registration no. ${a.licence_no}`, state: "manual", detail: "Confirm against MDA's licence records." });
  if (!t.need.length && !a.licence_no && !["worker"].includes(a.btype)) out.push({ k: "licence", label: "No licence or registration number", state: "info", detail: "Ask for one if this kind of business needs it." });
  const order = ["email", "phone", "phonetype", "sponsor", "md_reg_no", "npip_id", "usdot", "employer", "licence", "address", "domain", "dup", "history"];
  return out.sort((x, y) => order.indexOf(x.k) - order.indexOf(y.k));
}
async function phoneType(env, n) {
  try {
    const r = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(n)}?Fields=line_type_intelligence`, { headers: { authorization: "Basic " + btoa(env.TWILIO_SID + ":" + env.TWILIO_TOKEN) } }).then((x) => x.json());
    const lt = r.line_type_intelligence || {}, type = lt.type || "unknown";
    return { k: "phonetype", label: `Phone line: ${type}${lt.carrier_name ? " · " + lt.carrier_name : ""}`, state: /voip/i.test(type) ? "warn" : type === "unknown" ? "info" : "ok", detail: /voip/i.test(type) ? "Internet numbers are easy to create; confirm by calling an official number." : "" };
  } catch (e) { return null; }
}
async function addressCheck(addr) {
  try {
    const r = await fetch("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?" + new URLSearchParams({ f: "json", SingleLine: addr, maxLocations: "1", outFields: "Region,RegionAbbr,Subregion,Addr_type" })).then((x) => x.json());
    const c = r.candidates && r.candidates[0]; if (!c) return { k: "address", label: "Address not found", state: "warn", detail: addr };
    const st = c.attributes.RegionAbbr || "", good = c.score >= 85;
    return { k: "address", label: good ? `Address found · ${c.attributes.Subregion || ""}${st ? ", " + st : ""}` : "Address only roughly matched", state: !good ? "warn" : DELMARVA.includes(st) ? "ok" : "info", detail: c.address + (DELMARVA.includes(st) ? "" : " (outside the region)"), data: { x: c.location.x, y: c.location.y } };
  } catch (e) { return null; }
}
async function duplicates(env, a) {
  const ors = a.email ? [`LOWER(email) = '${q(a.email)}'`] : []; if (a.phone) ors.push(`phone = '${q(a.phone)}'`);
  if (a.usdot) ors.push(`usdot = '${q(a.usdot)}'`); if (a.md_reg_no) ors.push(`md_reg_no = '${q(a.md_reg_no)}'`);
  if (!ors.length) return [];
  let f = []; try { f = (await rows(env, env.ACCOUNTS_URL, `(${ors.join(" OR ")})${a.acct_id ? ` AND (acct_id IS NULL OR acct_id <> '${q(a.acct_id)}')` : ""}`)).map((x) => x.attributes); } catch (e) { return []; }
  const out = [], bad = f.filter((x) => x.status === "Denied" || x.status === "Revoked");
  if (bad.length) out.push({ k: "history", label: `Earlier request ${bad[0].status.toLowerCase()}`, state: "fail", detail: bad.map((x) => `${x.name} · ${x.status} ${x.decided ? new Date(x.decided).toISOString().slice(0, 10) : ""}${x.reason ? " · " + x.reason : ""}`).join("; ") });
  const others = f.filter((x) => !bad.includes(x));
  if (others.length) out.push({ k: "dup", label: `Same email, phone or number used in ${others.length} other request${others.length > 1 ? "s" : ""}`, state: "info", detail: others.slice(0, 5).map((x) => `${x.name} (${x.org || "-"}) · ${x.status}`).join("; ") });
  return out;
}
async function usdot(env, a) {
  const link = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${a.usdot}`;
  if (!env.FMCSA_WEBKEY) return { k: "usdot", label: `USDOT ${a.usdot}: check by hand`, state: "manual", detail: "Open the FMCSA SAFER record and compare the company name and status.", data: { link } };
  try {
    const r = await fetch(`https://mobile.fmcsa.dot.gov/qc/services/carriers/${a.usdot}?webKey=${env.FMCSA_WEBKEY}`).then((x) => x.json());
    const c = r.content && (r.content.carrier || r.content);
    if (!c || !c.legalName) return { k: "usdot", label: `USDOT ${a.usdot} not found`, state: "fail", detail: "No carrier with this number in the federal database.", data: { link } };
    const name = Math.max(similar(c.legalName, a.org), similar(c.dbaName, a.org)), ok = c.allowedToOperate === "Y";
    const data = { link, legalName: c.legalName, dbaName: c.dbaName || "", status: c.statusCode, allowed: c.allowedToOperate, address: [c.phyStreet, c.phyCity, c.phyState, c.phyZipcode].filter(Boolean).join(", "), powerUnits: c.totalPowerUnits, drivers: c.totalDrivers, oosDate: c.oosDate || "", rating: c.safetyRating || "" };
    return { k: "usdot", label: !ok ? `USDOT ${a.usdot}: not allowed to operate` : name >= 0.5 ? `USDOT ${a.usdot} active · name matches` : `USDOT ${a.usdot} active · name differs`, state: !ok ? "fail" : name >= 0.5 ? "ok" : "warn", detail: `${c.legalName}${c.dbaName ? " (dba " + c.dbaName + ")" : ""} · ${data.address}`, data };
  } catch (e) { return { k: "usdot", label: `USDOT ${a.usdot}: couldn't reach FMCSA`, state: "manual", detail: "Check by hand.", data: { link } }; }
}
async function registry(env, a, field, value, what) {
  if (!env.REGISTRY_URL) return { k: field, label: `${what} ${value}: check by hand`, state: "manual", detail: "" };
  try {
    const f = await rows(env, env.REGISTRY_URL, `${field} = '${q(value)}'`, { returnGeometry: true, returnCentroid: true, outSR: 4326 });
    if (!f.length) return { k: field, label: `${what} ${value} not in MDA's registry`, state: "warn", detail: "Check MDA's registration list; the registry may not include every farm yet." };
    const p = f[0].attributes, name = Math.max(similar(p.name, a.org), similar(p.operator, a.name), similar(p.operator, a.org), similar(p.name, a.name));
    const cty = !a.county || !p.county || similar(p.county, a.county) > 0;
    const ctr = f[0].centroid || (f[0].geometry && f[0].geometry.rings && { x: f[0].geometry.rings[0][0][0], y: f[0].geometry.rings[0][0][1] });
    const data = { premises_id: p.premises_id, name: p.name, operator: p.operator, phone: p.phone, address: p.address, county: p.county, production: p.production_type, species: p.species, houses: p.houses, capacity: p.capacity, npip: p.npip_id, npip_status: p.npip_status, status: p.status, validation: p.validation, x: ctr && ctr.x, y: ctr && ctr.y };
    return { k: field, label: name >= 0.5 && cty ? `${what} found · name matches` : `${what} found · name or county differs`, state: name >= 0.5 && cty ? "ok" : "warn", detail: `${p.name || "-"}${p.operator ? " · " + p.operator : ""} · ${p.address || ""} ${p.county || ""}`.trim(), data };
  } catch (e) { return { k: field, label: `${what} ${value}: couldn't check`, state: "manual", detail: "" }; }
}

// ---------------------------------------------------------------- map data for industry partners
// only these layers and operations; trips, visits and permits are limited to the person's own records
function targets(env) {
  const mv = env.MOVEMENT_URL;
  return {
    trips: { url: mv + "/0", own: true, ops: ["query", "addFeatures"], scope: "movement" },
    visits: { url: mv + "/1", own: true, ops: ["query", "addFeatures"], scope: "checkins" },
    permits: { url: mv + "/2", own: true, ops: ["query", "addFeatures"], scope: "movement", force: { status: "Pending" } },
    farms: { url: env.FARMS_URL, ops: ["query"], fields: "OBJECTID" },            // locations only, for keeping routes away from farms
    industryVisits: { url: env.INDUSTRY_VISITS_URL, ops: ["query"] },           // date + from-zone flag only (view)
    route: { url: env.ROUTE_URL, ops: ["", "solve"], scope: "movement" }
  };
}
async function proxy(a, b, env) {
  const T = targets(env)[b.target]; if (!T || !T.url) throw err(403, "Not available.");
  const op = String(b.op || "").replace(/^\//, ""); if (!T.ops.includes(op)) throw err(403, "Not allowed.");
  if (T.scope && a.scope && !a.scope.split(",").includes(T.scope)) throw err(403, "Your access doesn't include this. Contact MDA.");
  const p = Object.assign({}, b.params || {}); delete p.token; delete p.f;
  if (op === "query") {
    if (T.own) p.where = `(${p.where || "1=1"}) AND acct_id = '${q(a.acct_id)}'`;
    if (T.fields) p.outFields = T.fields;
    p.resultRecordCount = String(Math.min(+p.resultRecordCount || 1000, 2000));
    for (const k of ["returnIdsOnly", "outStatistics", "groupByFieldsForStatistics", "having", "sqlFormat"]) if (T.fields || T.own) delete p[k];
  }
  if (op === "addFeatures") {
    const feats = JSON.parse(p.features || "[]").slice(0, 20);
    feats.forEach((f) => { f.attributes = Object.assign({}, f.attributes || {}, T.force || {}, { acct_id: a.acct_id }); delete f.attributes.OBJECTID; delete f.attributes.GlobalID; });
    p.features = JSON.stringify(feats);
    await audit(env, "industry:" + a.acct_id, "industry:add:" + b.target, a.email, `${feats.length} record(s)`);
  }
  return ago(env, op ? T.url + "/" + op : T.url, p);
}

// ---------------------------------------------------------------- company administrators
async function company(action, me, b, env) {
  if (!me.company_admin) throw err(403, "Only your company's administrator can do this.");
  const mine = async () => (await rows(env, env.ACCOUNTS_URL, `sponsor_id = '${q(me.acct_id)}'`, { orderByFields: "created DESC" })).map((x) => x.attributes);
  if (action === "list") return { people: (await mine()).map((x) => ({ id: x.acct_id, name: x.name, email: x.email, phone: x.phone, role: x.btype, status: x.status, last_login: x.last_login, expires: x.expires })) };
  if (action === "add") {
    const email = b.email ? normContact(b.email) : null, phone = b.phone ? normContact(b.phone) : null;
    if (!clip(b.name, 100) || (!email && !phone)) throw err(400, "Enter a name and an email or mobile number.");
    await limit(env, "sponsor:" + me.acct_id, 40);
    const auto = String(env.SPONSOR_AUTO_APPROVE || "false") === "true";
    const n = { acct_id: crypto.randomUUID(), btype: "worker", role: "Sponsored staff", name: clip(b.name, 100), email: email ? email.v : "", phone: phone ? phone.v : "",
      org: me.org, county: me.county, employer: me.org, sponsor_id: me.acct_id, sponsor_name: me.name, email_ok: 0, phone_ok: 0, created: Date.now(), company_admin: 0,
      status: auto ? "Approved" : "New", scope: me.scope || "", expires: auto ? Math.min(me.expires || Infinity, Date.now() + 365 * DAY) : null, decided: auto ? Date.now() : null, decided_by: auto ? "company:" + me.name : null };
    n.checks = JSON.stringify(await runChecks(env, n)).slice(0, 8000);
    await ago(env, env.ACCOUNTS_URL + "/applyEdits", { adds: JSON.stringify([{ attributes: n }]) });
    await audit(env, "industry:" + me.acct_id, "company:add", n.email || n.phone, n.name + (auto ? " (approved by company)" : " (waiting for MDA)"));
    if (auto) await notifyAccount(env, n, "You can now use the Maryland avian influenza map", `${me.name} at ${me.org} gave you access to the Maryland avian influenza map. Sign in with this email or number: ${env.APP_URL || ""}`);
    return { ok: true, status: n.status };
  }
  if (action === "remove") {
    const x = (await mine()).find((p) => p.acct_id === b.id); if (!x) throw err(404, "Not one of your people.");
    await ago(env, env.ACCOUNTS_URL + "/applyEdits", { updates: JSON.stringify([{ attributes: { OBJECTID: x.OBJECTID, status: "Revoked", decided: Date.now(), decided_by: "company:" + me.name, reason: "Removed by company administrator" } }]) });
    live.delete(x.acct_id);
    await audit(env, "industry:" + me.acct_id, "company:remove", x.email || x.phone, x.name);
    return { ok: true };
  }
  throw err(404, "Not found");
}

// ---------------------------------------------------------------- MDA staff (their own ArcGIS sign-in)
async function mdaUser(req, env) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""); if (!t) throw err(401, "Sign in as MDA staff.");
  const me = await fetch((env.PORTAL_URL || "https://www.arcgis.com") + "/sharing/rest/community/self?" + new URLSearchParams({ f: "json", token: t })).then((x) => x.json()).catch(() => ({}));
  if (!me.username || !(me.groups || []).some((g) => g.title === env.REGULATOR_GROUP)) throw err(403, "Only MDA staff can do this.");
  return me.username;
}
async function mdaRecheck(who, b, env) {
  const a = await accountById(env, b.id); if (!a) throw err(404, "Request not found.");
  const checks = await runChecks(env, a);
  await ago(env, env.ACCOUNTS_URL + "/applyEdits", { updates: JSON.stringify([{ attributes: { OBJECTID: a.OBJECTID, checks: JSON.stringify(checks).slice(0, 8000) } }]) });
  await audit(env, who, "access:recheck", a.email, "");
  return { checks };
}
async function mdaNotify(who, b, env) {
  const a = await accountById(env, b.id); if (!a) throw err(404, "Request not found.");
  live.delete(a.acct_id);
  const app = env.APP_URL || "", msg = clip(b.message, 1500);
  let subject, text;
  if (b.kind === "ask") {
    const ticket = await sign(env, { k: "m", id: a.acct_id, exp: Date.now() + 14 * DAY });
    subject = "MDA needs a little more information";
    text = `MDA is reviewing your request to use the Maryland avian influenza map and needs a little more information:\n\n${msg}\n\nReply and add documents here (link works for 14 days): ${app}#more=${ticket}`;
  } else if (b.kind === "approved" || b.kind === "renewed") {
    subject = b.kind === "renewed" ? "Your access was renewed" : "You're approved";
    text = `${b.kind === "renewed" ? "MDA renewed your access" : "MDA approved your access"} to the Maryland avian influenza map${a.expires ? " until " + new Date(a.expires).toISOString().slice(0, 10) : ""}. Sign in with this email or mobile number: ${app}${msg ? "\n\n" + msg : ""}`;
  } else if (b.kind === "denied") {
    subject = "About your request"; text = `MDA couldn't approve your request to use the Maryland avian influenza map.${msg ? "\n\nReason: " + msg : ""}\n\nQuestions? Call MDA Animal Health${env.MDA_PHONE ? " at " + env.MDA_PHONE : ""}.`;
  } else if (b.kind === "revoked") {
    subject = "Your access was stopped"; text = `Your access to the Maryland avian influenza map was stopped.${msg ? "\n\nReason: " + msg : ""}\n\nQuestions? Call MDA Animal Health${env.MDA_PHONE ? " at " + env.MDA_PHONE : ""}.`;
  } else throw err(400, "Unknown message.");
  const sent = await notifyAccount(env, a, subject, text);
  await audit(env, who, "access:notify:" + b.kind, a.email || a.phone, sent.join("+") || "not sent");
  return { ok: true, sent };
}
