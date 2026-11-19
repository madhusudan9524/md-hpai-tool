#!/usr/bin/env python3
"""Send HPAI email alerts to people who subscribed in the map (runs after update_detections.py, twice a day).

Reads subscriptions from the MDA view of the submissions layer, and events from
  * public control areas (public view of the core service),
  * MDA county declarations,
  * data/detections.json (commercial-flock detections by county, wild-bird detections).
Sends one email per subscriber per new event within their radius.

Two early-warning alerts per saved place (tools/risk_model.py, the same model as the map):
  * rising seasonal risk: the place's seasonal risk rises to High or Very high (at most one email a week per place);
  * rising wild-bird detections: HPAI detections in wild birds and mammals within 50 miles are rising fast
    (14 days vs the 6 weeks before, as on the grower's risk card), which often comes before poultry outbreaks
    (at most one email every two weeks per place).
Remembers what was sent in data/alerts_state.json as one-way hashes (no emails or addresses are stored in the repo).

Needs these settings (GitHub repository secrets); without them the script does nothing:
  ARCGIS_PORTAL, ARCGIS_USER, ARCGIS_PASSWORD     an MDA account that can read the subscriptions view
  ALERTS_LAYER, AREAS_LAYER, DECL_LAYER           layer URLs (same as config.js submitMda.alerts, pub.areas, pub.declarations)
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_FROM
  APP_URL                                         public address of the map (for links and unsubscribe)
Standard library only.
"""
import base64, hashlib, json, math, os, smtplib, ssl, sys, time, urllib.parse, urllib.request, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import risk_model as RM
from email.message import EmailMessage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, "data", "alerts_state.json")
DATA = os.path.join(ROOT, "data", "detections.json")
TREND_KM = 80.5        # wild-bird detections within 50 miles count toward the trend
RISK_EVERY, TREND_EVERY = 7, 14   # days between early-warning emails for the same place
POINTS = json.load(open(os.path.join(ROOT, "tools", "county_points.json")))
E = os.environ.get


def post(url, params):
    data = urllib.parse.urlencode(dict(params, f="json")).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=60) as r:
        j = json.loads(r.read().decode())
    if "error" in j:
        raise RuntimeError(j["error"].get("message"))
    return j


def km(a, b):   # (lon, lat)
    r = math.pi / 180
    h = math.sin((b[1] - a[1]) * r / 2) ** 2 + math.cos(a[1] * r) * math.cos(b[1] * r) * math.sin((b[0] - a[0]) * r / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def inside(pt, rings):
    x, y, c = pt[0], pt[1], False
    for ring in rings:
        for i in range(len(ring) - 1):
            (x1, y1), (x2, y2) = ring[i][:2], ring[i + 1][:2]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
    return c


def dist_to_poly(pt, rings):
    return 0 if inside(pt, rings) else min(km(pt, v[:2]) for ring in rings for v in ring)


def place_of(token):
    """The map writes one subscription per saved place; its kind and name ride in the token: "<id>~<farm|home>~<base64url name>".
    Older tokens (no "~") are a home with no name."""
    parts = str(token or "").split("~")
    if len(parts) < 3:
        return "home", "your place"
    try:
        name = base64.urlsafe_b64decode(parts[2] + "=" * (-len(parts[2]) % 4)).decode("utf-8").strip() or "your place"
    except Exception:
        name = "your place"
    return ("farm" if parts[1] == "farm" else "home"), name


ADVICE = {
    "farm": {
        "control": "Your premises is in or near an HPAI control area. Moving poultry, eggs, feed, litter or equipment in or out needs an MDA permit. Keep birds indoors, allow essential visits only, and clean and disinfect every vehicle.",
        "county": "HPAI was reported in a commercial flock in this county. Tighten biosecurity: limit visitors, use dedicated boots and clothing, and check your birds closely.",
        "wild": "HPAI was found in wild birds near your premises. Keep poultry away from wild birds and standing water, and cover feed and water.",
        "risk": "Now is the time to tighten biosecurity: keep birds indoors, keep wild birds away from feed, water and litter, clean and disinfect vehicles and boots at the farm entrance, and limit visitors.",
        "trend": "Detections in wild birds often rise before outbreaks in poultry. Review your biosecurity plan, keep birds indoors and away from wild birds and standing water, and watch your flock closely.",
    },
    "home": {
        "control": "Your home is in or near an HPAI control area. If you keep backyard birds, keep them in, and check with MDA before moving any birds or eggs.",
        "county": "HPAI was reported in a poultry flock in this county. If you keep backyard birds, keep them away from wild birds and watch them closely.",
        "wild": "HPAI was found in wild birds near your home. Don't touch sick or dead wild birds; report them to MDA.",
        "risk": "If you keep backyard birds, keep them in a covered run away from wild birds and standing water, and watch them closely.",
        "trend": "HPAI is being found more often in wild birds in your area. Don't touch sick or dead wild birds; if you keep backyard birds, keep them away from wild birds.",
    },
}


def events(token):
    out = []
    for f in post(E("AREAS_LAYER") + "/query", {"where": "status = 'Active' AND zone_type = 'Control Area'", "outFields": "since,county", "outSR": 4326, "token": token}).get("features", []):
        out.append({"id": f"ca-{f['attributes'].get('county')}-{f['attributes'].get('since')}", "kind": "control", "rings": f["geometry"]["rings"],
                    "text": f"A control area is active in {f['attributes'].get('county')} County."})
    if E("DECL_LAYER"):
        for f in post(E("DECL_LAYER") + "/query", {"where": "status NOT IN ('Withdrawn','Cleared')", "outFields": "county,state,declared,status_text", "outSR": 4326, "token": token}).get("features", []):
            a = f["attributes"]
            out.append({"id": f"decl-{a['state']}-{a['county']}-{a['declared']}", "kind": "county", "rings": f["geometry"]["rings"],
                        "text": f"MDA reports HPAI in {a['county']} County, {a['state']}: {a.get('status_text') or ''}"})
    d = json.load(open(DATA))
    for c in d.get("commercial", []):
        p = POINTS.get(f"{c['state']}|{c['county']}")
        if p:
            out.append({"id": f"com-{c['state']}-{c['county']}-{c['date']}", "kind": "county", "pt": p, "radius_bonus": 25,
                        "text": f"HPAI {c.get('status', 'reported')} in a commercial flock in {c['county']} County, {c['state']} ({c['date']})."})
    today = dt.date.today()
    for w in d.get("wild", []):
        if (today - dt.date.fromisoformat(w["date"])).days <= 3:
            out.append({"id": f"wild-{w['county']}-{w['date']}-{w['species']}", "kind": "wild", "pt": [w["lon"], w["lat"]],
                        "text": f"HPAI found in a wild bird ({w['species']}) in {w['county']} County, {w['state']} ({w['date']})."})
    return out


def load(path, default=None):
    try:
        return json.load(open(os.path.join(ROOT, "data", path)))
    except Exception:
        return default


def risk_inputs():
    """What the alerts need: eBird Status & Trends waterfowl for the seasonal risk, and the wild-bird detections for the trend."""
    d = load("detections.json", {})
    wild = [w for w in (d.get("wild_all") or d.get("wild_year") or d.get("wild") or []) + (d.get("mammals") or []) if w.get("lat") is not None]
    det = [{"lat": w["lat"], "lon": w["lon"], "t": dt.datetime.fromisoformat(w["date"] + "T12:00:00+00:00").timestamp()} for w in wild]
    return {"st": RM.prepare_st(load("waterfowl_st.json")), "det": det}


def early_warnings(subs, state, now):
    """Rising seasonal risk and rising wild-bird detections, per saved place. Returns [(sub, kind, subject_tail, text)]."""
    inp, out, today = risk_inputs(), [], dt.date.fromtimestamp(now).isoformat()
    rs, ts = state.setdefault("risk", {}), state.setdefault("trend", {})
    for s in subs.values():
        h = hashlib.sha256(s["token"].encode()).hexdigest()[:24]
        pt = {"lat": s["pt"][1], "lon": s["pt"][0]}
        r = RM.seasonal_risk(pt, inp["st"], now)
        prev = rs.get(h, {})
        recent = prev.get("sent") and (dt.date.fromisoformat(today) - dt.date.fromisoformat(prev["sent"])).days < RISK_EVERY
        if r["tier"] >= 2 and r["tier"] > prev.get("tier", 0) and not recent:
            out.append((s, "risk", f"seasonal risk now {RM.TIERS[r['tier']]}",
                        f"Seasonal HPAI risk at {s['name']} has risen to {RM.TIERS[r['tier']]}: about {r['value']:.1f} times a typical location in Maryland and Delmarva, "
                        f"because waterfowl numbers nearby usually peak at this time of year. This is an experimental, not yet validated, advisory "
                        f"early warning (adapted from Gonnerman et al. 2025, eBird Status & Trends data), not a control zone."))
            prev = dict(prev, sent=today)
        rs[h] = dict(prev, tier=r["tier"])
        near = [d["t"] for d in inp["det"] if RM.km(pt, d) <= TREND_KM]
        tr = RM.regional_trend(near, now)
        last = ts.get(h)
        if tr["rising"] and not (last and (dt.date.fromisoformat(today) - dt.date.fromisoformat(last)).days < TREND_EVERY):
            rate = "none in the 6 weeks before" if tr["ratio"] == math.inf else f"about {round(tr['ratio'])} times the rate of the 6 weeks before"
            out.append((s, "trend", "wild-bird detections rising nearby",
                        f"HPAI detections in wild birds and mammals within 50 miles of {s['name']} are rising{' fast' if tr['sharp'] else ''}: "
                        f"{tr['recent']} in the last 2 weeks, {rate}. Rising wild-bird detections often come before outbreaks in poultry."))
            ts[h] = today
    return out


def main():
    need = ["ARCGIS_PORTAL", "ARCGIS_USER", "ARCGIS_PASSWORD", "ALERTS_LAYER", "AREAS_LAYER", "SMTP_HOST", "ALERT_FROM", "APP_URL"]
    if any(not E(k) for k in need):
        print("alerts: not configured (missing secrets), skipping"); return 0
    token = post(E("ARCGIS_PORTAL") + "/sharing/rest/generateToken", {"username": E("ARCGIS_USER"), "password": E("ARCGIS_PASSWORD"), "referer": E("APP_URL"), "expiration": 60})["token"]
    subs = {}
    for f in post(E("ALERTS_LAYER") + "/query", {"where": "1=1", "outFields": "email,radius_km,action,token,created", "orderByFields": "created ASC", "outSR": 4326, "token": token}).get("features", []):
        a = f["attributes"]
        if a.get("action") == "unsubscribe":
            subs = {k: v for k, v in subs.items() if v["token"] != a.get("token")}
        elif a.get("email"):
            kind, name = place_of(a["token"])
            subs[a["token"]] = {"email": a["email"], "km": a.get("radius_km") or 10, "pt": [f["geometry"]["x"], f["geometry"]["y"]], "token": a["token"], "kind": kind, "name": name}
    state = json.load(open(STATE)) if os.path.exists(STATE) else {"sent": []}
    sent, ev, mails = set(state["sent"]), events(token), []
    for s in subs.values():
        for e in ev:
            d = dist_to_poly(s["pt"], e["rings"]) if "rings" in e else km(s["pt"], e["pt"]) - e.get("radius_bonus", 0)
            key = hashlib.sha256(f"{s['token']}|{e['id']}".encode()).hexdigest()[:24]
            if d <= s["km"] and key not in sent:
                mails.append((s, e, max(0, d))); sent.add(key)
    letters = []
    for s, e, d in mails:
        what = "farm" if s["kind"] == "farm" else "home"
        kind = e["kind"] if e["kind"] in ("control", "wild") else "county"
        where = "inside it" if d < 0.05 else f"{d * 0.621371:.1f} miles from {s['name']}"
        letters.append((s, f"HPAI alert for {s['name']} ({what})", f"{e['text']}\nWhere: {where}.\n\nWhat to do: {ADVICE[s['kind']][kind]}"))
    warn = early_warnings(subs, state, time.time())
    for s, kind, tail, text in warn:
        letters.append((s, f"HPAI early warning for {s['name']}: {tail}", f"{text}\n\nWhat to do: {ADVICE[s['kind']][kind]}"))
    if letters:
        ctx = ssl.create_default_context()
        with smtplib.SMTP(E("SMTP_HOST"), int(E("SMTP_PORT") or 587), timeout=60) as smtp:
            smtp.starttls(context=ctx)
            if E("SMTP_USER"):
                smtp.login(E("SMTP_USER"), E("SMTP_PASS") or "")
            for s, subject, body in letters:
                m = EmailMessage()
                m["From"], m["To"], m["Subject"] = E("ALERT_FROM"), s["email"], subject
                m.set_content(f"{body}\n\n"
                              f"See the map: {E('APP_URL')}\nSick or dead birds? Call MDA at 410-841-5810.\n\n"
                              f"Turn off alerts for {s['name']}: {E('APP_URL')}#unsub={urllib.parse.quote(s['token'])}\n")
                smtp.send_message(m)
    state["sent"] = sorted(sent)[-20000:]
    json.dump(state, open(STATE, "w"))
    print(f"alerts: {len(subs)} subscribers, {len(ev)} events, {len(mails)} event emails, {len(warn)} early warnings sent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
