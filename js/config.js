// Maryland HPAI map: configuration. Change these when the tool moves to MDA's ArcGIS organization.
window.HPAI_CONFIG = {
  portalUrl: "https://uofmd.maps.arcgis.com",
  appId: "Gju4PCNvp8ugZdZQ",                       // OAuth client ID of the registered app

  // ---- who sees what (ArcGIS groups) ----
  regulatorGroup: "MD HPAI Regulators",           // MDA staff and authorities
  haulerGroup: "MD HPAI Haulers",                 // truckers, haulers, transporters
  industryGroup: "MD HPAI Industry",              // growers and poultry personnel (falls back to haulerGroup members)

  // ---- MDA-only service (base). Exact premises, perimeters, zones, audit log, biosecurity audits ----
  core: {
    premises: "", perimeters: "", zones: "", audit: "", biosecurity: "",
    pubAreas: "", pubMarkers: "", declarations: "", history: ""     // the editable layers behind the public view
  },
  // ---- public read-only view of the core service: merged areas, generalized markers, declarations, history ----
  pub: {
    areas: "", markers: "", declarations: "", history: ""
  },
  // ---- movement service: trips, visits, permits (haulers see their own; MDA sees all) ----
  movement: { trips: "", visits: "", permits: "" },
  movementMda: { trips: "", visits: "", permits: "" },   // MDA view of the same layers (all records)
  industryVisits: "",                                     // read view used for grower risk (date + from-zone flag only)
  // ---- submissions: anyone can add, only MDA can read ----
  submit: { reports: "", accounts: "", alerts: "" },      // public create-only view
  submitMda: { reports: "", accounts: "", alerts: "" },   // MDA view

  // ---- existing layers (prototype) ----
  legacy: {
    zones: "https://services1.arcgis.com/qTQ6qYkHpxlu0G82/arcgis/rest/services/MD_HPAI_Response/FeatureServer/1",
    premises: "https://services1.arcgis.com/qTQ6qYkHpxlu0G82/arcgis/rest/services/MD_HPAI_Response/FeatureServer/0",
    perimeters: "https://services1.arcgis.com/qTQ6qYkHpxlu0G82/arcgis/rest/services/MD_HPAI_Response/FeatureServer/2"
  },
  farmsUrl: "https://services1.arcgis.com/qTQ6qYkHpxlu0G82/arcgis/rest/services/MD_HPAI_Poultry_Farms/FeatureServer/0",

  // ---- environmental reference layers (official public services) ----
  env: {
    wetlands: "https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer",          // USFWS National Wetlands Inventory
    forestWms: { url: "https://www.mrlc.gov/geoserver/mrlc_display/wms", layer: "NLCD_2021_Land_Cover_L48" },        // USGS/MRLC NLCD 2021 land cover (forests in green)
    nhd: "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer", nhdWater: [10, 12], nhdRivers: [6],     // USGS National Hydrography Dataset
    wbd: "https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer", wbdLayer: 6,                             // USGS Watershed Boundary Dataset, HUC-12
    wma: "https://mdgeodata.md.gov/imap/rest/services/Environment/MD_ProtectedLands/FeatureServer/0",               // MD DNR lands (DESIG = 'WMA')
    waterfowl: "https://mdgeodata.md.gov/imap/rest/services/Biota/MD_LivingResources/FeatureServer/7",              // MD DNR waterfowl concentration and staging areas
    refuges: "https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/FWSInterest_Simplified_Authoritative/FeatureServer/0" // USFWS refuges
  },

  // ---- live data written twice a day by tools/update_detections.py (official sources only) ----
  dataUrl: "data/detections.json",
  sampleHistoryUrl: "data/sample_history.json",   // SAMPLE past zone shapes for the time slider (exercise data)
  stationsUrl: "data/cd_stations.json",           // cleaning & disinfection stations (SAMPLE until MDA lists real ones)

  // ---- zone rules (MDA can change) ----
  zones: { controlKm: 10, surveillanceKm: 20 },
  tintDays: 30,                 // county tint lasts this long after a commercial-flock detection or declaration
  privacy: {
    markerShiftKm: [1.5, 3],    // the public marker is moved this far from the premises, in a random direction
    markerRadiusKm: 3,          // and drawn as an area this wide
    minFarmsNearMarker: 5       // re-identification check: at least this many farms must sit inside the marker area
  },

  // ---- routing ----
  routeUrl: "https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World",
  closuresUrl: "https://opendata.maryland.gov/resource/nigh-m2sg.json",   // MDOT CHART road closures (Maryland Open Data)
  farmBufferKm: 0.5,           // routes avoid passing this close to other poultry farms where they can
  // per movement type: which rules apply (see README "Routing rules")
  commodities: {
    live:    { label: "Live birds",       icon: "bird",  farmBuffer: true,  cd: true, hours: [5, 20], hazmat: false },
    eggs:    { label: "Eggs",             icon: "egg",   farmBuffer: true,  cd: true, hours: null,    hazmat: false },
    feed:    { label: "Feed",             icon: "feed",  farmBuffer: false, cd: "leaving", hours: null, hazmat: false },
    litter:  { label: "Litter / manure",  icon: "litter",farmBuffer: true,  cd: true, hours: [6, 18], hazmat: false },
    dead:    { label: "Dead birds",       icon: "dead",  farmBuffer: true,  cd: true, hours: [6, 18], hazmat: true },
    service: { label: "Service / crew",   icon: "crew",  farmBuffer: false, cd: true, hours: null,    hazmat: false }
  },

  // ---- Apple Wallet (needs an Apple pass-type certificate; see tools/make_wallet_pass.py) ----
  walletPassUrl: "",           // e.g. https://mda-server/pass?permit={id}; leave empty to hide the button

  // ---- contacts ----
  mdaPhone: "410-841-5810",
  accessEmail: "",

  center: [-75.95, 38.65],
  zoom: 8
};
