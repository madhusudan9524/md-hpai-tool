#!/usr/bin/env python3
"""Build an Apple Wallet pass (.pkpass) for an approved HPAI movement permit.

Apple only accepts passes signed with a Pass Type ID certificate from an Apple Developer account
(ideally MDA's). Until one exists, the map shows the QR code and a printable permit instead.

Usage (on an MDA server that holds the certificate):
  python3 make_wallet_pass.py --permit permit.json --cert pass.pem --key pass.key --wwdr AppleWWDRCAG4.pem \
      --team TEAMID --pass-type pass.gov.maryland.mda.hpai --verify-url "https://<map>/#verify={id}" --out MD-2026-ABCDE.pkpass
permit.json holds the permit attributes as stored in the permits layer (permit_id, origin, destination, depart, valid_to, company, driver, plate, commodity).
Then set walletPassUrl in js/config.js to the address that serves these files, e.g. https://mda-server/pass?permit={id}.
Requires: openssl on the PATH. Standard library only.
"""
import argparse, datetime as dt, hashlib, io, json, os, subprocess, tempfile, zipfile

ICON_PNG = bytes.fromhex(  # 29x29 plain red square (replace with MDA artwork: icon.png, icon@2x.png, logo.png)
    "89504e470d0a1a0a0000000d494844520000001d0000001d0806000000f2e3e3b80000001c49444154789cedc1010d000000c2a0f74f6d0e37a00000000000000000be0d2e1c00012d9d4e6a0000000049454e44ae426082")


def iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat()


def build(p, a):
    return {
        "formatVersion": 1, "passTypeIdentifier": a.pass_type, "teamIdentifier": a.team, "serialNumber": p["permit_id"],
        "organizationName": "Maryland Department of Agriculture", "description": "HPAI movement permit",
        "logoText": "MDA movement permit", "foregroundColor": "rgb(255,255,255)", "backgroundColor": "rgb(122,15,15)", "labelColor": "rgb(255,210,205)",
        "expirationDate": iso(p["valid_to"]), "relevantDate": iso(p["depart"]),
        "barcodes": [{ "format": "PKBarcodeFormatQR", "message": a.verify_url.replace("{id}", p["permit_id"]), "messageEncoding": "iso-8859-1", "altText": p["permit_id"] }],
        "generic": {
            "primaryFields": [{ "key": "id", "label": "PERMIT", "value": p["permit_id"] }],
            "secondaryFields": [{ "key": "from", "label": "FROM", "value": p.get("origin", "").split(",")[0] }, { "key": "to", "label": "TO", "value": p.get("destination", "").split(",")[0] }],
            "auxiliaryFields": [{ "key": "valid", "label": "VALID", "value": f"{iso(p['depart'])[:10]} to {iso(p['valid_to'])[:10]}" }, { "key": "load", "label": "LOAD", "value": p.get("commodity", "") }],
            "backFields": [{ "key": "co", "label": "Company", "value": p.get("company", "") }, { "key": "drv", "label": "Driver", "value": p.get("driver", "") },
                           { "key": "plate", "label": "Plate", "value": p.get("plate", "") }, { "key": "help", "label": "Questions", "value": "MDA Animal Health 410-841-5810" }]
        }
    }


def main():
    ap = argparse.ArgumentParser()
    for k in ("permit", "cert", "key", "wwdr", "team", "pass-type", "verify-url", "out"):
        ap.add_argument("--" + k, required=True)
    ap.add_argument("--key-pass", default="")
    a = ap.parse_args()
    p = json.load(open(a.permit))
    files = {"pass.json": json.dumps(build(p, a), indent=1).encode(), "icon.png": ICON_PNG, "icon@2x.png": ICON_PNG}
    manifest = json.dumps({n: hashlib.sha1(b).hexdigest() for n, b in files.items()}).encode()
    with tempfile.TemporaryDirectory() as d:
        mf, sig = os.path.join(d, "manifest.json"), os.path.join(d, "signature")
        open(mf, "wb").write(manifest)
        cmd = ["openssl", "smime", "-binary", "-sign", "-certfile", a.wwdr, "-signer", a.cert, "-inkey", a.key, "-in", mf, "-out", sig, "-outform", "DER"]
        if a.key_pass:
            cmd += ["-passin", "pass:" + a.key_pass]
        subprocess.run(cmd, check=True)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for n, b in files.items():
                z.writestr(n, b)
            z.writestr("manifest.json", manifest)
            z.writestr("signature", open(sig, "rb").read())
    open(a.out, "wb").write(buf.getvalue())
    print("wrote", a.out)


if __name__ == "__main__":
    main()
