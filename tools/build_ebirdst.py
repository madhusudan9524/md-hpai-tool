#!/usr/bin/env python3
"""Weekly waterfowl abundance for Maryland / Delmarva from eBird Status & Trends -> data/waterfowl_st.json

Why: raw eBird sightings show where birders go, not where birds are, and the saved archive is only a few weeks long.
eBird Status & Trends is modelled weekly relative abundance (3 km) for all 52 weeks of a typical year, and is the
waterfowl input used by Prosser et al. 2024 and Gonnerman et al. 2025.

Run it on a computer with internet access (not needed more than about once a year):

    pip install numpy rasterio requests
    set EBIRDST_KEY=your-key            (Windows)     export EBIRDST_KEY=your-key   (Mac / Linux)
    python tools/build_ebirdst.py

The key comes from https://ebird.org/st/request. It is read from the environment and never written to a file.
Each species is downloaded, cut to the Maryland box, added to the total and deleted again.
Species codes that eBird does not recognise are reported and skipped; edit SPECIES or pass --species to change the list.
Standard output lists every species used, so the list can be compared with the one in Prosser et al. 2024.
"""
import argparse, json, os, sys, tempfile

BBOX = (-79.6, 37.0, -75.0, 39.8)   # lon min, lat min, lon max, lat max: Maryland, Delmarva, the Chesapeake
STEP_LON, STEP_LAT = 0.04, 0.03     # about 3.4 km x 3.3 km at this latitude
BASE = "https://st-download.ebird.org/v1"

# Gonnerman et al. 2025 (One Health 21:101172, section 2.2) used eBird Status & Trends for 13 genera: Alopochen, Anas, Anser,
# Aythya, Branta, Chloephaga, Coscoroba, Cyanochen, Cygnus, Dendrocygna, Lophonetta, Neochen, Tadorna. Goose = Anser, Branta,
# Coscoroba, Cygnus; duck = the rest (that is how the paper's grouping reads; it does not list the duck genera); all waterfowl = both.
# Below are the species in those genera that occur in Maryland, with their eBird codes (each is checked at run time and skipped
# if eBird does not know it). Sea ducks, mergansers, Bufflehead, Wood Duck and Ruddy Duck belong to other genera and are NOT used.
# Open choice: current eBird taxonomy puts Gadwall and American Wigeon in Mareca, and Northern Shoveler and Blue-winged Teal in
# Spatula, which are not on the paper's list. They are kept here as dabbling ducks, which the paper calls Anas, because the
# paper does not say which taxonomy year it used. Remove them from this list to be stricter.
SPECIES = {   # code: (name, genus)
    "cangoo": ("Canada Goose", "Branta"), "cacgoo1": ("Cackling Goose", "Branta"), "brant": ("Brant", "Branta"),
    "snogoo": ("Snow Goose", "Anser"), "rosgoo": ("Ross's Goose", "Anser"), "gwfgoo": ("Greater White-fronted Goose", "Anser"),
    "mutswa": ("Mute Swan", "Cygnus"), "tunswa": ("Tundra Swan", "Cygnus"), "truswa": ("Trumpeter Swan", "Cygnus"),
    "mallar3": ("Mallard", "Anas"), "ambduc": ("American Black Duck", "Anas"), "norpin": ("Northern Pintail", "Anas"),
    "gnwtea": ("Green-winged Teal", "Anas"), "gadwal": ("Gadwall", "Anas"), "amewig": ("American Wigeon", "Anas"),
    "buwtea": ("Blue-winged Teal", "Anas"), "norsho": ("Northern Shoveler", "Anas"),
    "canvas": ("Canvasback", "Aythya"), "redhea": ("Redhead", "Aythya"), "rinduc": ("Ring-necked Duck", "Aythya"),
    "gresca": ("Greater Scaup", "Aythya"), "lessca": ("Lesser Scaup", "Aythya"), "tufduc": ("Tufted Duck", "Aythya"),
    "bbwduc": ("Black-bellied Whistling-Duck", "Dendrocygna"), "fuwduc": ("Fulvous Whistling-Duck", "Dendrocygna"),
    "egygoo": ("Egyptian Goose", "Alopochen"),
}
GOOSE_GENERA = {"Anser", "Branta", "Coscoroba", "Cygnus"}


def group_of(code):
    return "goose" if SPECIES[code][1] in GOOSE_GENERA else "duck"


def grid():
    """Cell centres (lon list, lat list) of the output grid, north to south."""
    nx = int(round((BBOX[2] - BBOX[0]) / STEP_LON)); ny = int(round((BBOX[3] - BBOX[1]) / STEP_LAT))
    lons = [BBOX[0] + (i + 0.5) * STEP_LON for i in range(nx)]
    lats = [BBOX[3] - (j + 0.5) * STEP_LAT for j in range(ny)]
    return lons, lats


def sample_weekly(path, lons, lats):
    """Weekly values of one species' GeoTIFF at every grid cell: float32 array [weeks, ny, nx]. NaN / nodata -> 0."""
    import numpy as np, rasterio
    from rasterio.warp import transform
    with rasterio.open(path) as ds:
        xs, ys = np.meshgrid(lons, lats)
        px, py = transform("EPSG:4326", ds.crs, xs.ravel().tolist(), ys.ravel().tolist())
        rows, cols = rasterio.transform.rowcol(ds.transform, px, py)
        rows, cols = np.array(rows), np.array(cols)
        inside = (rows >= 0) & (rows < ds.height) & (cols >= 0) & (cols < ds.width)
        r0, r1 = (rows[inside].min(), rows[inside].max() + 1) if inside.any() else (0, 1)
        c0, c1 = (cols[inside].min(), cols[inside].max() + 1) if inside.any() else (0, 1)
        block = ds.read(window=((int(r0), int(r1)), (int(c0), int(c1))), masked=True).astype("float32").filled(0)
        block = np.nan_to_num(block, nan=0.0, posinf=0.0, neginf=0.0)
        out = np.zeros((block.shape[0], rows.size), dtype="float32")
        out[:, inside] = block[:, rows[inside] - r0, cols[inside] - c0]
        return out.reshape(block.shape[0], len(lats), len(lons))


def download(requests, key, year, code, res, dest):
    obj = f"{year}/{code}/weekly/{code}_abundance_median_{res}_{year}.tif"
    r = requests.get(f"{BASE}/fetch", params={"objKey": obj, "key": key}, stream=True, timeout=600)
    r.raise_for_status()
    with open(dest, "wb") as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)


def summarize(total, scale=1000):
    """Integers for the JSON file plus the yardstick for 'a typical place': mean and SD of ln(abundance) over the
    cell-weeks that have waterfowl (Gonnerman et al. used the natural log). Cell-weeks with none are left out of the
    yardstick, because ln(0) would stretch the spread; the risk code gives those a capped low z-score."""
    import numpy as np
    pos = total[total > 0]
    ref = {"mu": float(np.log(pos).mean()), "sd": float(np.log(pos).std()), "cellweeks": int(pos.size),
           "share_zero": float(1 - pos.size / total.size), "weeks": int(total.shape[0])}
    return np.rint(total * scale).astype("int32"), ref


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--year", type=int, default=2023, help="Status & Trends version year (2023 at the time of writing)")
    ap.add_argument("--res", default="3km", choices=["3km", "9km", "27km"])
    ap.add_argument("--species", nargs="*", help="eBird species codes (default: the list in this file)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "waterfowl_st.json"))
    a = ap.parse_args()
    key = os.environ.get("EBIRDST_KEY")
    if not key:
        sys.exit("Set the EBIRDST_KEY environment variable (key from https://ebird.org/st/request).")
    import numpy as np, requests
    lons, lats = grid()
    codes = a.species or list(SPECIES)
    parts, used, skipped = {"goose": None, "duck": None}, [], []
    for code in codes:
        lst = requests.get(f"{BASE}/list-obj/{a.year}/{code}", params={"key": key}, timeout=60)
        if lst.status_code in (401, 403):
            sys.exit(f"eBird refused the key (HTTP {lst.status_code}). Check EBIRDST_KEY and that access was granted.")
        files = lst.json() if lst.ok else []
        if not any(f.endswith(f"weekly/{code}_abundance_median_{a.res}_{a.year}.tif") for f in files):
            skipped.append(code); print(f"  skipped {code}: not available"); continue
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, f"{code}.tif")
            print(f"  {code} ({SPECIES.get(code, ('?',))[0]}) downloading ...", flush=True)
            download(requests, key, a.year, code, a.res, path)
            arr = sample_weekly(path, lons, lats)
        g = group_of(code) if code in SPECIES else "duck"
        parts[g] = arr if parts[g] is None else parts[g] + arr
        used.append(code)
    have = [v for v in parts.values() if v is not None]
    if not have:
        sys.exit("No species could be downloaded.")
    zero = np.zeros_like(have[0])
    goose = parts["goose"] if parts["goose"] is not None else zero
    duck = parts["duck"] if parts["duck"] is not None else zero
    ints_g, ref_g = summarize(goose); ints_d, ref_d = summarize(duck); ints_a, ref_a = summarize(goose + duck)
    doc = {"source": "eBird Status and Trends relative abundance (weekly, median), Cornell Lab of Ornithology; species in the "
                     "genera used by Gonnerman et al. 2025; goose = Anser, Branta, Coscoroba, Cygnus; duck = the other genera; "
                     "sampled to a regular grid",
           "year": a.year, "resolution": a.res, "species": used, "skipped": skipped,
           "goose_species": [c for c in used if c in SPECIES and group_of(c) == "goose"],
           "duck_species": [c for c in used if not (c in SPECIES and group_of(c) == "goose")],
           "bbox": list(BBOX), "step": [STEP_LON, STEP_LAT], "nx": len(lons), "ny": len(lats), "scale": 1000,
           "ref": ref_a, "ref_goose": ref_g, "ref_duck": ref_d,
           "order": "week 1..52, then rows north to south, then columns west to east; all waterfowl = goose + duck",
           "data_goose": ints_g.reshape(ints_g.shape[0], -1).tolist(),
           "data_duck": ints_d.reshape(ints_d.shape[0], -1).tolist()}
    with open(a.out, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print("used:", ", ".join(used))
    print(f"wrote {os.path.abspath(a.out)}: {len(used)} species, {ints_a.shape[0]} weeks, {len(lons)}x{len(lats)} cells, "
          f"all-waterfowl reference mean {ref_a['mu']:.2f} sd {ref_a['sd']:.2f}")
    if skipped:
        print("skipped (check the codes):", ", ".join(skipped))


if __name__ == "__main__":
    main()
