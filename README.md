# Maryland HPAI Response Map (prototype)

This is a three-tier web tool for HPAI (highly pathogenic avian influenza) control-area information on the Delmarva Peninsula. It is built on ArcGIS Online and the ArcGIS Maps SDK for JavaScript 4.31.

**The premises and zones in it are sample data. This is not an official MDA product.**

Live site: https://madhusudan9524.github.io/md-hpai-tool/

## Tiers
| Tab | Who | What it shows |
|---|---|---|
| Public | Anyone | Active Control Areas: exact 10 km circles, with no premises IDs. Past control areas are faded by how long ago each was released. Wild-bird HPAI detections by county come from USDA APHIS. An address lookup reports one of three results: Control Area, Surveillance Zone or Free Area. |
| Haulers & industry | Truckers and integrators | A truck route that avoids active Control Areas, using them as polygon barriers. It reports the km driven inside the Control Area and the Surveillance Zone, says whether a permit is needed, and links to a pre-filled Survey123 permit request. |
| Regulators | MDA / USDA | Premises points; Infected, Buffer, Control and Surveillance zones; released zones; wild birds; the premises list; and a link to the submitted permit requests. |

## APHIS zone geometry (per premises)
- Infected Zone: 0–3 km.
- Buffer Zone: 3–10 km.
- Control Area: the Infected Zone plus the Buffer Zone, 0–10 km.
- Surveillance Zone: 10–20 km.

## ArcGIS Online items (uofmd org, owner madhutim_UofMD)
| Item | ID |
|---|---|
| MD_HPAI_Response (layer 0 Infected_Premises, layer 1 Response_Zones) | 0ac62c28b2954e078ac1f63c178a2932 |
| MD_HPAI_WildBirds (layer 0 Wild_Bird_Detections) | a1f7e3b4c0484be3b0911e819d5edaed |
| MD_HPAI_PermitRequests (layer 0 Permit_Requests) | 9df7a5bae8954be89af96c9fbdbee8f9 |
| Survey123 form: HPAI Movement Permit Request | dc58d20686754e49a56f072f382121dd |
| OAuth app (client ID Gju4PCNvp8ugZdZQ) | 2a89951c4b3043598c5c85b5ab7542ba |

All URLs are in `config.js`. To hand the tool over to MDA:
1. Recreate or transfer the items above.
2. Register a new OAuth app.
3. Edit `config.js`.

## Updating data
- **New premises:** add a point to Infected_Premises. Then add its 4 zone rings to Response_Zones (see the notebook / `03_build_premises_and_zones.py`).
- **Releasing a premises:** set `status = 'Released'` and `released_date` on both the premises and its zones. The public map fades released zones automatically over 0, 60, 180 and 365 days.
- **Wild birds:** APHIS blocks cloud servers, so download https://www.aphis.usda.gov/sites/default/files/hpai-wild-birds.csv from a desktop. Then re-run the aggregation in `04_build_wild_birds.py`.

## Cost note
Each route the haulers request runs two route solves (avoiding the Control Areas, and direct). That is about 0.01 ArcGIS credits per request, charged to the signed-in user.
