# Maryland HPAI Map (v2)

One map for three audiences, each with its own panel:

| Who | Signs in? | What they get |
|---|---|---|
| **Public** | No | Control areas and surveillance zones, affected counties (commercial-flock detections), wild-bird detections, address check with autocomplete, a click card for any place, saved places with alerts (in the browser and by email), dead-wild-bird reports with photos, official notices |
| **Haulers & industry** | Yes (request access in the app; MDA approves) | Infected-premises markers, truck route planner that avoids control areas, saved trips, permit requests filled in from the route, permit status with QR code (Apple Wallet once a certificate exists), trip sheet, farm check-ins; growers get a farm risk score and can report a sick flock |
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
- `tools/update_weather.py`: statewide winter weather for the seasonal risk (Open-Meteo, no key)
- `tools/risk_model.py`: Python copy of the seasonal risk model for the email alerts (kept in step by `tests/test_risk_model.py`)
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

## Who signs in

- **Members of the public (optional)**: "Save my places" with just an email code, no approval and nothing else asked. Their saved homes and farms and alert choices are kept in the sign-in service (KV, keyed by email) and can be deleted from the menu. Industry partners' saved places sync the same way. Without signing in, places stay on the device.
- **Email alerts**: one subscription per saved place (Email alerts → tick places, pick a distance). The place's type and name ride in the alert token (`<id>~farm|home~<base64url name>`), so `tools/send_alerts.py` words each email for a farm or a home without a change to the alerts layer.
- **Early-warning emails** (same subscription, no extra setting): **rising seasonal risk**, when a saved place's seasonal risk rises to High or Very high (at most one a week per place; it can alert again after the level has dropped and risen again); **rising wild-bird detections**, when HPAI detections in wild birds and mammals within 50 miles rise (at least 3 in 14 days and at least twice the rate of the 6 weeks before; "fast" at 5 and 3×), at most one every two weeks per place. Both use `tools/risk_model.py` with the same inputs and "typical place" reference as the map (the reference is written to `data/birds_weeks.json` by `tools/update_birds.py`). Only one-way hashes of tokens, the last level and the send date are kept in `data/alerts_state.json`.
- **Export map data** (industry partners and MDA staff, account menu): seasonal risk hexagons with the parts of each multiple, wild-bird and mammal detections, the user's saved places with zone, seasonal risk and farm risk, and the waterfowl sightings for the week on the map, as CSV or GeoJSON. MDA staff exports are written to the audit log.

- **View as** (MDA staff): your menu → View as Public / Industry / MDA staff shows each audience's version. A banner shows while you're viewing as someone else. The industry view uses a built-in test grower record and saves nothing (`js/preview.js`).

- **Public**: no sign-in.
- **MDA staff**: ArcGIS account in the "MD HPAI Regulators" group.
- **Industry partners** (haulers, growers, poultry businesses, their drivers and staff): email or text code. They register with the credential for their type of business: premises registration, NPIP, USDOT or employer. Automatic checks run, then MDA reviews the request with documents, evidence and a checklist (Reviews → Access requests). Access lasts one year by default. Company administrators add and remove their own people. Setup: [worker/README.md](worker/README.md).

## Preliminary vs confirmed premises

A premises created with "Confirmed by USDA" off has its zones stored with status **Pending**: it's tracked in the MDA panel but no circle is drawn or published, and no marker is shown, until MDA taps **Confirm**. Releasing a preliminary premises doesn't add it to Past outbreaks; it withdraws the county's declarations and adds a **Cleared** declaration, which ends the county's tint (and is skipped by email alerts).

Releasing a confirmed premises ends its county's tint; the area shows in light grey under Past outbreaks for 28 days (two 14-day flock incubation periods, the WOAH recovery period).

**Past outbreaks slider** (Layers & key): weekly steps back to January 2022. On any date, areas in force that day are red, areas released in the 28 days before it are grey, and today's live areas are hidden until you go back to today. Clicking the map while looking back describes that date.

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

- The public never receives premises locations. MDA's "Publish public map" builds merged control-area and surveillance-zone shapes (each separate area kept as its own feature) and premises markers. Markers are shown only to signed-in industry partners, never to the public, and MDA staff see the exact boundary instead. `privacy.markerShiftKm` in `js/config.js` is currently `[0, 0]` (marker on the premises); set e.g. `[1.5, 3]` to move it off-centre.
- A re-identification check counts poultry farms inside each marker area (at least 5 by default) and flags any control area that surrounds a single premises, since its center can be estimated.
- The poultry farm layer is shown only to MDA staff (haulers' routes use it in the background to keep distance from farms).

## Data sources (official only)

- HPAI in wild birds and the monthly Atlantic Flyway pattern: USDA APHIS
- Detections and notices: Maryland Department of Agriculture, Delaware Department of Agriculture, Virginia Department of Agriculture and Consumer Services, plus MDA-entered declarations
- Wetlands: USFWS National Wetlands Inventory · Forests & land cover: USGS/MRLC NLCD 2021 · Lakes, rivers: USGS NHD · Watersheds: USGS WBD HUC-12
- Wildlife management areas and waterfowl concentration areas: Maryland DNR (MD iMAP) · Wildlife refuges: USFWS
- Road closures: MDOT CHART via Maryland Open Data · Truck routing and traffic: Esri World Route (truck travel mode)

## Risk models (screening aids, not predictions)

**Seasonal risk layer** (~6 km hexagons, the "Seasonal risk" line on the address card, and the early-warning emails). **Experimental, not yet validated; advisory only.** Adapted from Gonnerman et al. 2025 (*One Health* 21:101172):

relative risk = exp(0.422 × zA)

- **Waterfowl abundance:** eBird Status & Trends modelled weekly relative abundance (2023 version, ~3 km), summed over the Maryland species in the 13 genera the paper used (geese, swans, dabbling and diving ducks; no sea ducks, mergansers, Bufflehead, Wood Duck or Ruddy Duck). Built once a year with `tools/build_ebirdst.py` → `data/waterfowl_st.json` (needs an eBird Status & Trends access key in `EBIRDST_KEY`; never commit the key). A hexagon averages the grid cells within 3.5 km.
- **zA:** natural log of the two-week mean abundance (this week and the one before), as a z-score against every grid cell and week of a typical year in Maryland / Delmarva, capped at ±3 (no waterfowl at all: −3). 0.422 is the paper's coefficient per SD.
- **Tiers:** set by rank in that typical year, not by chosen multiples: Moderate = top 25%, High = top 10%, Very high = top 2.5% of place-weeks.
- **Not included:** winter weather (the paper compares places across the US, which this regional reference cannot reproduce), wild-bird detections (not in the paper; they have their own layer and the rising-detection email), and the paper's spatial and temporal random effects and farm-type terms.

Limits: the paper standardized across its US study locations, which are confidential, so 1 SD here is a regional SD; the coefficient is the paper's but the score has not been tested against Maryland outbreaks. It describes a typical year's waterfowl pattern, not this year's birds or current infection.

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
