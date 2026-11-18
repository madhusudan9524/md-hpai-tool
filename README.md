# Maryland HPAI Map (v2)

One map for three audiences, each with its own panel:

| Who | Signs in? | What they get |
|---|---|---|
| **Public** | No | Control areas and surveillance zones, approximate infected-premises markers, affected counties, wild-bird detections, address check with autocomplete, a click card for any place, saved places with alerts (in the browser and by email), dead-wild-bird reports with photos, official notices |
| **Haulers & industry** | Yes (request access in the app; MDA approves) | Truck route planner that avoids control areas, saved trips, permit requests filled in from the route, permit status with QR code (Apple Wallet once a certificate exists), trip sheet, farm check-ins; growers get a farm risk score and can report a sick flock |
| **MDA staff** | Yes (MD HPAI Regulators group) | Exact premises, zones drawn outward from the premises boundary, release, county declarations, publishing the public map with a privacy check, review queues (reports with photos, permits, access requests), premises inside each zone with biosecurity audit status, movement tracing, daily situation summary, audit log, QR permit verification |

The prototype is kept as `v1.html`.

## Files

- `index.html`, `css/app.css`: layout and styling (solid panel; frosted glass only over the map; dark mode follows the device; bottom sheet on phones)
- `js/config.js`: every layer address and rule (zone distances, privacy settings, movement rules by commodity)
- `js/app.js`: map, layers panel, click card, time slider, seasonal risk, sign-in
- `js/public.js`, `js/hauler.js`, `js/mda.js`: tools for each audience
- `js/risk.js`: risk models (tested with `node tests/risk.test.js`)
- `tools/update_detections.py`: twice-daily update from official sources → `data/detections.json`
- `tools/send_alerts.py`: email alerts (runs after the update when its secrets are set)
- `tools/make_wallet_pass.py`: Apple Wallet permit pass (needs an Apple pass certificate)
- `data/curated_detections.json`: detections entered by MDA staff (always override automatic ones)
- `data/sample_history.json`, `data/cd_stations.json`: **SAMPLE** data for testing (past zone shapes, C&D stations)

## ArcGIS layers (UMD org, owner madhutim_UofMD)

| Service | Shared with | Contains |
|---|---|---|
| MD_HPAI_Core | MDA staff | Premises, Perimeters, Zones, PublicAreas, PublicMarkers, Declarations, History, AuditLog, Biosecurity |
| MD_HPAI_Public (view, query only) | Everyone | PublicAreas, PublicMarkers, Declarations, History |
| MD_HPAI_Movement | MDA staff | Trips, Visits, Permits |
| MD_HPAI_Movement_Haulers (view) | Haulers, Industry | Same layers; each person sees only their own records |
| MD_HPAI_Visits_Industry (view) | Industry | Visit date and "came from a control area" flag only, for the farm risk score |
| MD_HPAI_Submissions | MDA staff | Reports (with photo attachments), Alerts, Accounts |
| MD_HPAI_Submit (view, create only) | Everyone | Anyone can submit; nobody but MDA can read |

The current zones are the prototype's **sample** data, migrated and labeled as samples ("Sample zones" badge in the header). Release them from the MDA panel before real use.

## MDA premises registry

MDA staff → Premises → Registry:
- **Add premises**: tap a farm; the boundary is suggested from FEMA/ORNL USA Structures building footprints (buildings ≥ 800 m² and ≥ 3.5× longer than wide are treated as poultry houses; houses within 100 m of each other form one premises; boundary = outline around them + 40 m).
- **Auto-outline farms in view**: batch version for every estimated farm in view (up to 200 at a time, with progress and Stop).
- **Import file**: GeoJSON (polygons or points) or CSV with latitude/longitude; known columns (name, operator, npip_id, capacity…) are filled in.
- **Each premises**: Overview (operator, integrator, contacts, USDA PIN, NPIP no., status), Birds (production type, species, size/age class, capacity, birds on site, placement and market dates, houses and floor area), History (HPAI records at the site plus inspections, tests, quarantine, depopulation, C&D, restocking), Compliance (biosecurity plan, NPIP status, audits), Outline (suggest from buildings, edit, redraw).
- Everything starts as **Needs review**; only **Validate** marks it as MDA validated. Every change goes to the audit log.
- Creating an infected premises inside a registered boundary uses that boundary for the zones.
- Layers: MD_HPAI_Core 9 Registry, 10 Houses, 11 PremisesEvents (MDA only).

## Privacy (Dr. Ghanem's requirement)

- The public never receives exact premises. MDA's "Publish public map" builds merged control-area and surveillance-zone shapes and **approximate markers** moved 1.5–3 km in a random direction (kept inside the control area).
- A re-identification check counts poultry farms inside each marker area (at least 5 by default) and flags any control area that surrounds a single premises, since its center can be estimated.
- The poultry farm layer is shown only to MDA staff (haulers' routes use it in the background to keep distance from farms).

## Data sources (official only)

- HPAI in wild birds and the monthly Atlantic Flyway pattern: USDA APHIS
- Detections and notices: Maryland Department of Agriculture, Delaware Department of Agriculture, Virginia Department of Agriculture and Consumer Services, plus MDA-entered declarations
- Wetlands: USFWS National Wetlands Inventory · Forests & land cover: USGS/MRLC NLCD 2021 · Lakes, rivers: USGS NHD · Watersheds: USGS WBD HUC-12
- Wildlife management areas and waterfowl concentration areas: Maryland DNR (MD iMAP) · Wildlife refuges: USFWS
- Road closures: MDOT CHART via Maryland Open Data · Truck routing and traffic: Esri World Route (truck travel mode)

## Risk models (screening aids, not predictions)

**Seasonal risk layer** = season × (0.55 wild-bird pressure + 0.45 waterfowl habitat), on ~6 km hexagons.
Season comes from APHIS monthly wild-bird detections in Atlantic Flyway states. Wild-bird pressure fades with distance (10 km) and age (28-day half-life). Habitat is the distance to MD DNR waterfowl areas, wildlife management areas and USFWS refuges.

**Farm risk score** (growers), in points:
inside a control area +4 / surveillance zone +2 / control area within 10 km +1; visits by vehicles that came from a control area in 14 days +3 (or 5+ visits +1); wild-bird detection within 10 km in 4 weeks +2 (same county +1); waterfowl habitat within 1 km +1; peak season +1; biosecurity audit passed in the last year −1 (not passed or none +1).
Low 0–2 · Moderate 3–4 · High 5–7 · Very high 8+.
Sources: USDA APHIS 2015 case-control findings (control-area location OR 28.8; rendering trucks near barns OR 21.4; service visits OR 4.3; protective effect of C&D entry pads); Schreuder et al. 2022 (*Pathogens*); USGS 2025 (*One Health* 21:101172).

## Routing rules by movement type

| Movement | Avoid control areas | Distance from other farms | C&D stop | Allowed hours | Hazmat roads |
|---|---|---|---|---|---|
| Live birds | ✓ | ✓ | ✓ | 5:00–20:00 | – |
| Eggs | ✓ | ✓ | ✓ | – | – |
| Feed | ✓ | – | leaving a zone | – | – |
| Litter / manure | ✓ | ✓ | ✓ | 6:00–18:00 | – |
| Dead birds | ✓ | ✓ | ✓ | 6:00–18:00 | ✓ |
| Service / crew | ✓ | – | ✓ | – | – |

All trips also use truck height and weight limits, MDOT CHART closures and traffic at the departure time. **The hours and C&D stations are placeholders for MDA to confirm.**

## How detections get into the map (automatic)

Twice a day `tools/update_detections.py`:
1. scrapes MDA press releases (plus Delaware and Virginia agriculture news) and keeps those mentioning avian influenza / HPAI / H5N1;
2. has Claude read each release and return county, flock type, status (preliminary / confirmed), birds affected, date and a one-line summary (needs the `ANTHROPIC_API_KEY` repository secret; without it, keyword rules are used);
3. checks the AI answer (county must be a real Delmarva county, dates must be real) and drops anything it can't verify;
4. writes the result to `data/detections.json`: the county is tinted and the notice is listed, with a link to the original release as the source.
Zones and exact premises are only added later by MDA staff in the MDA panel.

## Still to set up

0. **AI reading of releases**: add the repository secret `ANTHROPIC_API_KEY` (an Anthropic API key).
1. **Email alerts**: add repository secrets `ARCGIS_PORTAL`, `ARCGIS_USER`, `ARCGIS_PASSWORD`, `ALERTS_LAYER` (MD_HPAI_Submissions/1), `AREAS_LAYER` (MD_HPAI_Public/0), `DECL_LAYER` (MD_HPAI_Public/2), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_FROM`, `APP_URL`.
2. **Apple Wallet**: an Apple Developer pass certificate (ideally MDA's), then set `walletPassUrl` in `js/config.js`.
3. **Access requests**: approving one opens the ArcGIS group page so MDA can send the invite.
4. Placeholders to fill in later: real C&D stations and allowed movement hours (MDA), the contact email (`accessEmail` in `js/config.js`), and the press-release link for the Worcester entry in `data/curated_detections.json`.

## Run locally

```
python3 -m http.server 8080
```
Open http://localhost:8080 (this address is registered for ArcGIS sign-in).
