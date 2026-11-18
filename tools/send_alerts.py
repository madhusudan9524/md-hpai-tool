#!/usr/bin/env python3
"""Send HPAI email alerts to people who subscribed in the map (runs after update_detections.py, twice a day).

Reads subscriptions from the MDA view of the submissions layer, and events from
  * public control areas (public view of the core service),
  * MDA county declarations,
  * data/detections.json (commercial-flock detections by county, wild-bird detections).
Sends one email per subscriber per new event within their radius. Remembers what was sent in
data/alerts_state.json as one-way hashes (no emails or addresses are stored in the repo).

Needs these settings (GitHub repository secrets); without them the script does nothing:
  ARCGIS_PORTAL, ARCGIS_USER, ARCGIS_PASSWORD     an MDA account that can read the subscriptions view
  ALERTS_LAYER, AREAS_LAYER, DECL_LAYER           layer URLs (same as config.js submitMda.alerts, pub.areas, pub.declarations)
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_FROM
  APP_URL                                         public address of the map (for links and unsubscribe)
Standard library only.
"""
import hashlib, json, math, os, smtplib, ssl, sys, urllib.parse, urllib.request, datetime as dt
from email.message import EmailMessage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, "data", "alerts_state.json")
DATA = os.path.join(ROOT, "data", "detections.json")
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
            subs[a["token"]] = {"email": a["email"], "km": a.get("radius_km") or 10, "pt": [f["geometry"]["x"], f["geometry"]["y"]], "token": a["token"]}
    state = json.load(open(STATE)) if os.path.exists(STATE) else {"sent": []}
    sent, ev, mails = set(state["sent"]), events(token), []
    for s in subs.values():
        for e in ev:
            d = dist_to_poly(s["pt"], e["rings"]) if "rings" in e else km(s["pt"], e["pt"]) - e.get("radius_bonus", 0)
            key = hashlib.sha256(f"{s['token']}|{e['id']}".encode()).hexdigest()[:24]
            if d <= s["km"] and key not in sent:
                mails.append((s, e, max(0, d))); sent.add(key)
    if mails:
        ctx = ssl.create_default_context()
        with smtplib.SMTP(E("SMTP_HOST"), int(E("SMTP_PORT") or 587), timeout=60) as smtp:
            smtp.starttls(context=ctx)
            if E("SMTP_USER"):
                smtp.login(E("SMTP_USER"), E("SMTP_PASS") or "")
            for s, e, d in mails:
                m = EmailMessage()
                m["From"], m["To"], m["Subject"] = E("ALERT_FROM"), s["email"], "Maryland HPAI alert near your place"
                m.set_content(f"{e['text']}\nDistance from your place: {d:.0f} km.\n\nSee the map: {E('APP_URL')}\n"
                              f"Sick or dead birds? Call MDA at 410-841-5810.\n\nUnsubscribe: {E('APP_URL')}#unsub={s['token']}\n")
                smtp.send_message(m)
    state["sent"] = sorted(sent)[-20000:]
    json.dump(state, open(STATE, "w"))
    print(f"alerts: {len(subs)} subscribers, {len(ev)} events, {len(mails)} emails sent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
