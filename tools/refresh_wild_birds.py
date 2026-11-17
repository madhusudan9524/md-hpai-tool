"""Refresh the wild-bird layer: keep only USDA APHIS detections from the last 28 days.

Run from a desktop (APHIS blocks cloud servers) or from an ArcGIS Online notebook if it can reach APHIS.
APHIS publishes county only, so each point is placed at an interior point of the county
(county_points.json). Add counties to that file as new ones appear.
  pip install arcgis pandas
  python refresh_wild_birds.py
"""
import io, json, sys, datetime as dt, urllib.request
import pandas as pd
from arcgis.gis import GIS

PORTAL = "https://uofmd.maps.arcgis.com"
LAYER_ITEM = "a1f7e3b4c0484be3b0911e819d5edaed"   # MD_HPAI_WildBirds
CSV = "https://www.aphis.usda.gov/sites/default/files/hpai-wild-birds.csv"
STATES = {"Maryland", "Delaware", "Virginia", "Pennsylvania", "New Jersey"}
DAYS = 28

pts = json.load(open(__file__.replace("refresh_wild_birds.py", "county_points.json")))
raw = urllib.request.urlopen(urllib.request.Request(CSV, headers={"User-Agent": "Mozilla/5.0"})).read().decode("utf-8-sig")
df = pd.read_csv(io.StringIO(raw))
df["det"] = pd.to_datetime(df["Date Detected"], errors="coerce")
df["col"] = pd.to_datetime(df["Collection Date"], errors="coerce")
df = df[df["State"].isin(STATES) & (df["det"] >= pd.Timestamp.utcnow().tz_localize(None) - pd.Timedelta(days=DAYS))]

feats, missing = [], set()
for _, r in df.iterrows():
    key = f'{r["State"]}|{r["County"]}'.replace(" County", "")
    if key not in pts:
        missing.add(key); continue
    x, y = pts[key]
    feats.append({"geometry": {"x": x, "y": y, "spatialReference": {"wkid": 4326}},
                  "attributes": {"state": r["State"], "county": r["County"], "species": r["Bird Species"], "strain": r["HPAI Strain"],
                                 "last_detected": int(r["det"].timestamp() * 1000),
                                 "collection_date": None if pd.isna(r["col"]) else int(r["col"].timestamp() * 1000),
                                 "source": f"USDA APHIS, retrieved {dt.date.today()}"}})
if missing: print("No point for:", sorted(missing), "- add to county_points.json")

lyr = GIS(PORTAL, input("ArcGIS username: "), __import__("getpass").getpass()).content.get(LAYER_ITEM).layers[0]
lyr.delete_features(where="1=1")
if feats: lyr.edit_features(adds=feats)
print(f"Layer now holds {len(feats)} detections from the last {DAYS} days.")
