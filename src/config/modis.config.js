/**
 * NASA MODIS (MOD13Q1.061) Configuration.
 * Single source of truth for MODIS 250m 16-day vegetation indices.
 */

export const MODIS = {
  datasetKey: "nasa:modis:mod13q1:v061",
  productName: "MODIS/Terra Vegetation Indices 16-Day L3 Global 250m SIN Grid V061",
  collectionConceptId: "C1748066515-LPCLOUD",
  provider: "NASA LP DAAC (Land Processes Distributed Active Archive Center)",
  appeearsBaseUrl: "https://appeears.earthdatacloud.nasa.gov/api/v1",
  spatialResolution: "250m sinusoidal grid",
  temporalCadence: "16-day composite",
  temporalExtentStart: "2000-02-18",

  // Core Layers
  layers: {
    ndvi: {
      name: "_250m_16_days_NDVI",
      scaleFactor: 0.0001,
      fillValue: -3000,
      validMin: -0.2,
      validMax: 1.0,
      unit: "NDVI",
      description: "Normalized Difference Vegetation Index (chlorophyll absorption & canopy vigor)",
    },
    evi: {
      name: "_250m_16_days_EVI",
      scaleFactor: 0.0001,
      fillValue: -3000,
      validMin: -0.2,
      validMax: 1.0,
      unit: "EVI",
      description: "Enhanced Vegetation Index (decoupled canopy background and reduced atmospheric aerosol)",
    },
    pixelReliability: {
      name: "_250m_16_days_pixel_reliability",
      scaleFactor: 1.0,
      fillValue: -1,
      validMin: 0,
      validMax: 3,
      rankings: {
        0: { label: "good_data", description: "Use with confidence", reliable: true },
        1: { label: "marginal_data", description: "Useful, but check other QA metrics", reliable: false },
        2: { label: "snow_ice", description: "Target covered with snow/ice", reliable: false },
        3: { label: "cloudy", description: "Target covered with clouds", reliable: false },
      },
    },
    compositeDoy: {
      name: "_250m_16_days_composite_day_of_the_year",
      scaleFactor: 1.0,
      fillValue: -1,
      validMin: 1,
      validMax: 366,
      description: "Day of year pixel was acquired",
    },
  },

  disclosure:
    "MODIS NDVI and EVI represent 250m regional canopy greenness and chlorophyll dynamics derived from surface reflectance. " +
    "They indicate relative vegetative vigor, NOT direct grain yield, crop disease presence, or root-zone soil water.",
  documentationUrls: [
    "https://doi.org/10.5067/MODIS/MOD13Q1.061",
    "https://appeears.earthdatacloud.nasa.gov",
  ],
};
