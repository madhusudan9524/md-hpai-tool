// Configuration: change these when moving the tool to MDA's ArcGIS organization.
window.HPAI_CONFIG = {
  portalUrl: "https://uofmd.maps.arcgis.com",
  // OAuth "Client ID" of the app registered in ArcGIS Online (Developer credentials > OAuth 2.0).
  appId: "Gju4PCNvp8ugZdZQ",
  zonesUrl: "https://services1.arcgis.com/qTQ6qYkHpxlu0G82/arcgis/rest/services/MD_HPAI_Response/FeatureServer/1",
  premisesUrl: "https://services1.arcgis.com/qTQ6qYkHpxlu0G82/arcgis/rest/services/MD_HPAI_Response/FeatureServer/0",
  perimeterUrl: "https://services1.arcgis.com/qTQ6qYkHpxlu0G82/arcgis/rest/services/MD_HPAI_Response/FeatureServer/2",
  wildBirdsUrl: "https://services1.arcgis.com/qTQ6qYkHpxlu0G82/arcgis/rest/services/MD_HPAI_WildBirds/FeatureServer/0",
  routeUrl: "https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World",
  // Survey123 movement-permit request form (share URL). Fields are prefilled with ?field:name=value
  permitFormUrl: "https://survey123.arcgis.com/share/dc58d20686754e49a56f072f382121dd",
  permitResultsUrl: "https://survey123.arcgis.com/surveys/dc58d20686754e49a56f072f382121dd/data",
  center: [-75.95, 38.65],
  zoom: 8
};
