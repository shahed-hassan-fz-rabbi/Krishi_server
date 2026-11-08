/**
 * NASA SMAP (SPL3SMP_E V006) Configuration.
 * Single source of truth for SMAP product metadata, variables, and quality flags.
 */

export const SMAP = {
  datasetKey: "nasa:smap:spl3smp_e:v006",
  productName: "SMAP Enhanced L3 Radiometer Global Daily 9 km EASE-Grid Soil Moisture V006",
  collectionConceptId: "C2938664763-NSIDC_CPRD",
  provider: "NASA NSIDC DAAC (National Snow and Ice Data Center)",
  harmonyBaseUrl: "https://harmony.earthdata.nasa.gov",
  cmrSearchUrl: "https://cmr.earthdata.nasa.gov/search/granules.json",
  spatialResolution: "9 km EASE-Grid 2.0",
  temporalCadence: "Daily (AM ~06:00 desc, PM ~18:00 asc)",
  temporalCoverageStart: "2015-03-31",
  variableName: "soil_moisture",
  unit: "m^3/m^3",
  fillValue: -9999.0,
  minValid: 0.0,
  maxValid: 0.9, // Physical volumetric soil moisture limit (saturation ~0.45-0.55 m^3/m^3 depending on soil texture)
  disclosure:
    "SMAP soil moisture represents a satellite radiometer-derived estimate of volumetric moisture in the top ~5 cm of soil column (m^3/m^3). " +
    "It is a 9 km regional satellite proxy, not an in-situ farm sensor measurement, and does not represent root-zone soil moisture.",
  documentationUrls: [
    "https://nsidc.org/data/spl3smp_e/versions/6",
    "https://harmony.earthdata.nasa.gov",
  ],
};
