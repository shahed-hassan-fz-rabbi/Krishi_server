/**
 * GIS & Geospatial Intelligence Controller.
 * Delivers verified BBS 2020 Admin-2 GeoJSON district boundaries,
 * multi-sensor observation locations, and sensor footprint envelopes.
 *
 * Strictly Read-Only:
 * - Reads BBS GeoJSON from server/data/gis/bbs_admin2_cumilla_chattogram.geojson.
 * - Reads existing SMAP & MODIS observations from MongoDB without modification.
 * - Zero database writes.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DISTRICTS } from "../config/climate.config.js";
import { SMAP } from "../config/smap.config.js";
import { MODIS } from "../config/modis.config.js";
import { SmapObservation } from "../models/smapobservation.model.js";
import { ModisObservation } from "../models/modisobservation.model.js";
import { errorResponse, successResponse } from "../utils/response.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const geojsonPath = path.resolve(__dirname, "../../data/gis/bbs_admin2_cumilla_chattogram.geojson");

// District P-Code mapping
const DISTRICT_MAP = {
  cumilla: {
    code: "cumilla",
    nameEn: "Cumilla",
    nameBn: "কুমিল্লা",
    pCode: "BD2019",
    refCoord: [91.18503, 23.46186], // [lon, lat]
    bbox: [90.63, 23.048, 91.3719, 23.7956], // [minLon, minLat, maxLon, maxLat]
    center: [23.46186, 91.18503], // [lat, lon]
    zoom: 10,
  },
  chattogram: {
    code: "chattogram",
    nameEn: "Chattogram",
    nameBn: "চট্টগ্রাম",
    pCode: "BD2015",
    refCoord: [91.8317, 22.3384], // [lon, lat]
    bbox: [91.3111, 21.8579, 92.2163, 22.9892],
    center: [22.3384, 91.8317],
    zoom: 9,
  },
};

let cachedGeoJson = null;

function loadGeoJson() {
  if (cachedGeoJson) return cachedGeoJson;
  if (!fs.existsSync(geojsonPath)) {
    throw new Error(`GeoJSON file missing at ${geojsonPath}`);
  }
  const raw = fs.readFileSync(geojsonPath, "utf-8");
  cachedGeoJson = JSON.parse(raw);
  return cachedGeoJson;
}

/**
 * GET /api/v1/gis/districts
 * Returns list of supported districts with geospatial metadata and available layers.
 */
export async function getGisDistricts(req, res, next) {
  try {
    const list = Object.values(DISTRICT_MAP).map((d) => ({
      code: d.code,
      nameEn: d.nameEn,
      nameBn: d.nameBn,
      pCode: d.pCode,
      center: d.center,
      zoom: d.zoom,
      bbox: d.bbox,
      refCoord: d.refCoord,
      availableSensors: ["smap", "modis", "power"],
    }));

    return successResponse(res, 200, list, {
      crs: "EPSG:4326 (WGS 84)",
      boundaryAuthority: "Bangladesh Bureau of Statistics (BBS) 2020 Admin-2",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/gis/boundaries?district=cumilla
 * Returns verified BBS Admin-2 GeoJSON for one or all supported districts.
 */
export async function getGisBoundaries(req, res, next) {
  try {
    const geo = loadGeoJson();
    const districtQuery = req.query.district ? req.query.district.trim().toLowerCase() : null;

    if (districtQuery) {
      const mapping = DISTRICT_MAP[districtQuery];
      if (!mapping) {
        return errorResponse(
          res,
          400,
          `Unsupported district '${districtQuery}'. Supported: ${Object.keys(DISTRICT_MAP).join(", ")}`,
          "INVALID_DISTRICT"
        );
      }

      const feature = geo.features.find((f) => f.properties.adm2_pcode === mapping.pCode);
      if (!feature) {
        return errorResponse(res, 404, `Boundary polygon not found for ${districtQuery}`, "BOUNDARY_NOT_FOUND");
      }

      return successResponse(
        res,
        200,
        {
          type: "FeatureCollection",
          features: [feature],
          districtMeta: mapping,
        },
        {
          provenance: geo.provenance,
          sourceDataset: "bgd_admbnda_adm2_bbs_20201113",
          licensing: "Creative Commons Attribution for Intergovernmental Organisations (CC BY-IGO)",
          crs: "EPSG:4326 (WGS 84)",
        }
      );
    }

    // Return all features
    return successResponse(res, 200, geo, {
      provenance: geo.provenance,
      sourceDataset: "bgd_admbnda_adm2_bbs_20201113",
      crs: "EPSG:4326 (WGS 84)",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/gis/layers?district=cumilla
 * Combines boundary polygon, latest SMAP pixel & footprint, latest MODIS pixel,
 * and NASA POWER reference coordinates into unified spatial layer manifest.
 */
export async function getGisLayers(req, res, next) {
  try {
    const districtCode = (req.query.district || "cumilla").trim().toLowerCase();
    const mapping = DISTRICT_MAP[districtCode];

    if (!mapping) {
      return errorResponse(
        res,
        400,
        `Unsupported district '${districtCode}'. Supported: ${Object.keys(DISTRICT_MAP).join(", ")}`,
        "INVALID_DISTRICT"
      );
    }

    const geo = loadGeoJson();
    const boundaryFeature = geo.features.find((f) => f.properties.adm2_pcode === mapping.pCode);

    // Fetch latest SMAP observation from MongoDB
    const latestSmap = await SmapObservation.findOne({ districtCode })
      .sort({ dateLabel: -1 })
      .lean();

    // Fetch latest MODIS observation from MongoDB
    const latestModis = await ModisObservation.findOne({ districtCode })
      .sort({ dateLabel: -1 })
      .lean();

    // Construct Spatial Layers Payload
    const layers = {
      district: mapping,
      boundary: boundaryFeature || null,
      sensors: {
        climate: {
          sensorName: "NASA POWER",
          location: {
            latitude: mapping.refCoord[1],
            longitude: mapping.refCoord[0],
          },
          nativeResolution: "0.5° × 0.625° grid (~50 km)",
          timeStandard: "LST (Local Solar Time)",
          description: "Regional assimilation gridded climate estimates (Precipitation, Temperature, Solar Radiation)",
        },
        soilMoisture: latestSmap
          ? {
              sensorName: "NASA SMAP (SPL3SMP_E V006)",
              extractedPixelLocation: {
                latitude: latestSmap.latitude,
                longitude: latestSmap.longitude,
              },
              referenceLocation: {
                latitude: latestSmap.targetReferenceLat,
                longitude: latestSmap.targetReferenceLon,
              },
              geodesicDistanceKm: latestSmap.geodesicDistanceKm,
              footprintEnvelopes: {
                gridPostingRadiusMeters: 4500, // Nominal 9 km EASE-Grid 2.0 cell radius
                radiometerFootprintRadiusMeters: 18000, // ~36 km native L-band antenna 3dB footprint radius
              },
              observation: {
                dateLabel: latestSmap.dateLabel,
                orbit: latestSmap.orbit,
                soilMoisture: latestSmap.soilMoisture,
                unit: latestSmap.unit,
                retrievalQualityFlag: latestSmap.retrievalQualityFlag,
                isRecommendedQuality: latestSmap.isRecommendedQuality,
                qualityClassification: latestSmap.qualityClassification,
                surfaceFlag: latestSmap.surfaceFlag,
                surfaceTemperatureK: latestSmap.surfaceTemperatureK,
                clayFraction: latestSmap.clayFraction,
                granuleId: latestSmap.granuleId,
              },
              spatialDisclosure:
                "Nominal 9 km grid posting on EASE-Grid 2.0; actual radiometer native spatial footprint is ~36 km. " +
                "Point observation represents top 5cm volume-averaged soil moisture for this regional cell, NOT individual farm fields.",
            }
          : null,
        vegetation: latestModis
          ? {
              sensorName: "NASA MODIS (MOD13Q1.061)",
              extractedPixelLocation: {
                latitude: latestModis.coordinates?.coordinates[1] || mapping.refCoord[1],
                longitude: latestModis.coordinates?.coordinates[0] || mapping.refCoord[0],
              },
              footprintEnvelopes: {
                pixelRadiusMeters: 125, // 250m nominal pixel resolution radius (6.25 hectares)
              },
              observation: {
                dateLabel: latestModis.dateLabel,
                compositeDayOfYear: latestModis.compositeDayOfYear,
                ndvi: latestModis.ndvi,
                evi: latestModis.evi,
                pixelReliability: latestModis.pixelReliability,
                isReliableQuality: latestModis.isReliableQuality,
                qualityClassification: latestModis.qualityClassification,
                modisTile: latestModis.metadata?.modisTile || "h26v06",
                sourceGranuleId: latestModis.sourceGranuleId,
              },
              spatialDisclosure:
                "250m sinusoidal grid resolution. Quantifies regional canopy chlorophyll vigor across 6.25 hectares, " +
                "NOT individual farm plots or direct crop yields.",
            }
          : null,
      },
    };

    return successResponse(res, 200, layers, {
      boundaryProvenance: "BBS 2020 Admin-2 / UN OCHA HDX",
      smapProvenance: SMAP.datasetKey,
      modisProvenance: MODIS.datasetKey,
    });
  } catch (error) {
    next(error);
  }
}
