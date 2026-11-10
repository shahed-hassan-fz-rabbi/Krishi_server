/**
 * Climate Analysis Controller.
 * Handles /api/v1/climate/summary, /api/v1/climate/rainfall, and /api/v1/climate/temperature.
 * Bridges MongoDB observations with the Python scientific engine and enforces
 * input validation, caching, and scientific metadata integrity.
 */
import { DISTRICTS, PARAMETER_NAMES, TARGET_RANGE } from "../config/climate.config.js";
import { isIsoDate } from "../validators/power.validator.js";
import { errorResponse, successResponse } from "../utils/response.js";
import { analyzeDistrictClimate, analyzeHandoff } from "../services/climate/analysis.service.js";
import { NasaObservation } from "../models/nasaobservation.model.js";
import { snapshotService } from "../services/snapshot.service.js";

const VALID_DISTRICT_CODES = new Set(DISTRICTS.map((d) => d.code));
const VALID_RAINFALL_GROUPINGS = new Set(["monthly", "annual", "seasonal", "daily"]);
const VALID_TEMP_METRICS = new Set(["t2m", "tmax", "tmin", "all"]);

// Fast bounded memory cache for scientific calculations
const analysisCache = new Map();
const MAX_CACHE_SIZE = 100;

export const FORMULA_VERSION = "v1.0.0-phase3";
export const DATASET_KEY = "nasa:power:daily:point";

export function getCacheKey(parts) {
  return [FORMULA_VERSION, DATASET_KEY, ...parts].join("::");
}

export function clearAnalysisCache() {
  analysisCache.clear();
}

export function getAnalysisCacheSize() {
  return analysisCache.size;
}

/** GET /api/v1/climate/latest?district=cumilla — latest verified POWER point values. */
export async function getLatestClimateObservations(req, res, next) {
  try {
    const district = (req.query.district || "").trim().toLowerCase();
    if (!VALID_DISTRICT_CODES.has(district)) return errorResponse(res, 400, "A supported district is required.", "INVALID_DISTRICT");
    if (!snapshotService.isDbConnected()) return errorResponse(res, 503, "No offline daily POWER observation snapshot is configured.", "DATA_UNAVAILABLE", undefined, { provenance: "UNAVAILABLE", databaseConnected: false });
    const rows = await Promise.all(PARAMETER_NAMES.map((parameter) => NasaObservation.findOne({ datasetKey: DATASET_KEY, districtCode: district, parameter, quality: "ok" }).sort({ dateLabel: -1 }).lean()));
    const observations = Object.fromEntries(rows.filter(Boolean).map((row) => [row.parameter, { value: row.value, unit: row.unit, observationDate: row.dateLabel, timeStandard: row.timeStandard, quality: row.quality, ingestedAt: row.createdAt || null }]));
    if (!Object.keys(observations).length) return errorResponse(res, 503, "No verified NASA POWER observations are stored for this district.", "DATA_NOT_INGESTED", undefined, { provenance: "UNAVAILABLE", databaseConnected: true });
    return successResponse(res, 200, { districtCode: district, observations }, { dataset: "NASA POWER Daily Point Agroclimatology", datasetKey: DATASET_KEY, provider: "NASA POWER / Langley Research Center", provenance: "HISTORICAL_DATABASE", databaseConnected: true, timeStandard: "LST (Local Solar Time), not Bangladesh Standard Time", isForecast: false, spatialResolution: "0.5° × 0.625° source grids (~50 km)" });
  } catch (error) { next(error); }
}

function getFromCache(key) {
  return analysisCache.get(key) || null;
}

function setInCache(key, value) {
  if (analysisCache.size >= MAX_CACHE_SIZE) {
    const firstKey = analysisCache.keys().next().value;
    analysisCache.delete(firstKey);
  }
  analysisCache.set(key, value);
}

/**
 * Validates common query parameters (district, from, to).
 */
function validateClimateQuery(query) {
  const errors = [];

  const district = (query.district || "").trim().toLowerCase();
  if (!district) {
    return { valid: false, code: "MISSING_DISTRICT", message: "Query parameter 'district' is required" };
  }
  if (!VALID_DISTRICT_CODES.has(district)) {
    return {
      valid: false,
      code: "INVALID_DISTRICT",
      message: `District '${district}' is invalid. Supported: ${[...VALID_DISTRICT_CODES].join(", ")}`,
    };
  }

  const from = query.from || TARGET_RANGE.start;
  const to = query.to || TARGET_RANGE.end;

  if (!isIsoDate(from)) {
    return { valid: false, code: "INVALID_DATE", message: `'from' must be a valid ISO date YYYY-MM-DD (got: ${from})` };
  }
  if (!isIsoDate(to)) {
    return { valid: false, code: "INVALID_DATE", message: `'to' must be a valid ISO date YYYY-MM-DD (got: ${to})` };
  }
  if (from > to) {
    return { valid: false, code: "INVALID_DATE_RANGE", message: `'from' date (${from}) cannot be after 'to' date (${to})` };
  }
  if (from < TARGET_RANGE.start || to > TARGET_RANGE.end) {
    return {
      valid: false,
      code: "DATE_OUT_OF_BOUNDS",
      message: `Requested date range [${from}..${to}] is outside supported historical window [${TARGET_RANGE.start}..${TARGET_RANGE.end}]`,
    };
  }

  return { valid: true, district, from, to };
}

/**
 * GET /api/v1/climate/summary?district=chattogram
 * Comprehensive climate overview across all parameters.
 */
export async function getClimateSummary(req, res, next) {
  try {
    const validation = validateClimateQuery(req.query);
    if (!validation.valid) {
      return errorResponse(res, 400, validation.message, validation.code);
    }

    const { district, from, to } = validation;

    // Check if database is offline or disconnected
    if (!snapshotService.isDbConnected()) {
      const snapshot = snapshotService.getClimateSnapshot(district);
      if (snapshot && snapshot.data) {
        const meta = {
          ...(snapshot.meta || {}),
          district,
          provenance: "SNAPSHOT",
          databaseConnected: false,
          snapshotGeneratedAt: snapshot.snapshotMetadata.generatedAt,
          sourceDataset: snapshot.snapshotMetadata.sourceDataset,
          limitations: snapshot.snapshotMetadata.limitations,
        };
        return successResponse(res, 200, snapshot.data, meta);
      }
      return errorResponse(
        res,
        503,
        `Climate data for district '${district}' is unavailable (offline and no verified snapshot exists).`,
        "DATA_UNAVAILABLE"
      );
    }

    // Check data availability in DB
    const obsCount = await NasaObservation.countDocuments({
      datasetKey: DATASET_KEY,
      districtCode: district,
      dateLabel: { $gte: from, $lte: to },
    });

    if (obsCount === 0) {
      return errorResponse(
        res,
        503,
        `Historical climate data for district '${district}' is not yet available in the database`,
        "DATA_UNAVAILABLE"
      );
    }

    const cacheKey = getCacheKey(["summary", district, from, to]);
    const cached = getFromCache(cacheKey);
    if (cached) {
      return successResponse(res, 200, cached.data, {
        ...(cached.meta || {}),
        provenance: "CACHED",
        databaseConnected: true,
      });
    }

    const analysis = await analyzeDistrictClimate({
      districtCode: district,
      parameter: null,
      startIso: from,
      endIso: to,
    });

    const meta = {
      ...(analysis.meta || {}),
      provenance: "HISTORICAL_DATABASE",
      databaseConnected: true,
    };

    setInCache(cacheKey, { data: analysis.data, meta });
    return successResponse(res, 200, analysis.data, meta);
  } catch (error) {
    // If runtime DB error occurred, try fallback snapshot
    try {
      const validation = validateClimateQuery(req.query);
      if (validation.valid) {
        const snapshot = snapshotService.getClimateSnapshot(validation.district);
        if (snapshot && snapshot.data) {
          const meta = {
            ...(snapshot.meta || {}),
            district: validation.district,
            provenance: "SNAPSHOT",
            databaseConnected: false,
            snapshotGeneratedAt: snapshot.snapshotMetadata.generatedAt,
            sourceDataset: snapshot.snapshotMetadata.sourceDataset,
            limitations: snapshot.snapshotMetadata.limitations,
          };
          return successResponse(res, 200, snapshot.data, meta);
        }
      }
    } catch {
      // Ignore fallback error and continue to global error handler
    }
    next(error);
  }
}

/**
 * GET /api/v1/climate/rainfall?district=chattogram&from=2001-01-01&to=2025-12-31&grouping=monthly
 */
export async function getRainfall(req, res, next) {
  try {
    const validation = validateClimateQuery(req.query);
    if (!validation.valid) {
      return errorResponse(res, 400, validation.message, validation.code);
    }

    const { district, from, to } = validation;
    const grouping = (req.query.grouping || "monthly").toLowerCase();

    if (!VALID_RAINFALL_GROUPINGS.has(grouping)) {
      return errorResponse(
        res,
        400,
        `grouping '${grouping}' is invalid. Supported: ${[...VALID_RAINFALL_GROUPINGS].join(", ")}`,
        "INVALID_GROUPING"
      );
    }

    if (!snapshotService.isDbConnected()) {
      const snapshot = snapshotService.getClimateSnapshot(district);
      if (snapshot && snapshot.data && snapshot.data.rainfall) {
        const rain = snapshot.data.rainfall;
        let selectedData = {};
        if (grouping === "monthly") {
          selectedData = {
            series: rain.monthly_series,
            historical_normals: rain.monthly_historical,
          };
        } else if (grouping === "annual") {
          selectedData = {
            series: rain.annual_series,
            historical_normals: rain.annual_historical,
          };
        } else if (grouping === "seasonal") {
          selectedData = {
            historical_seasons: rain.seasonal_historical,
            seasons_definition: {
              winter: "December to February (Dec–Feb, 3 months) — Rabi cool season",
              pre_monsoon: "March to May (Mar–May, 3 months) — Hot pre-monsoon season",
              monsoon: "June to September (Jun–Sep, 4 months) — South-west monsoon season",
              post_monsoon: "October to November (Oct–Nov, 2 months) — Post-monsoon transition",
            },
          };
        } else if (grouping === "daily") {
          selectedData = {
            district,
            parameter: "PRECTOTCORR",
            unit: "mm/day",
            grouping: "daily",
            series: [],
            note: "Daily point-level series is only available with active database connection; monthly, annual, and seasonal historical normals are provided from verified offline snapshot.",
          };
        }

        const meta = {
          district,
          parameter: "PRECTOTCORR",
          unit: rain.unit || "mm",
          grouping,
          provenance: "SNAPSHOT",
          databaseConnected: false,
          snapshotGeneratedAt: snapshot.snapshotMetadata.generatedAt,
          sourceDataset: snapshot.snapshotMetadata.sourceDataset,
          limitations: snapshot.snapshotMetadata.limitations,
          wet_day_definition:
            "Project-selected threshold: valid daily precipitation >= 1.0 mm; missing days are excluded; not an agronomic threshold",
        };

        return successResponse(res, 200, selectedData, meta);
      }

      return errorResponse(
        res,
        503,
        `Rainfall data for district '${district}' is not available in the database`,
        "DATA_UNAVAILABLE"
      );
    }

    const obsCount = await NasaObservation.countDocuments({
      datasetKey: DATASET_KEY,
      districtCode: district,
      parameter: "PRECTOTCORR",
      dateLabel: { $gte: from, $lte: to },
    });

    if (obsCount === 0) {
      return errorResponse(
        res,
        503,
        `Rainfall data for district '${district}' is not available in the database`,
        "DATA_UNAVAILABLE"
      );
    }

    const cacheKey = getCacheKey(["rainfall", district, from, to, grouping]);
    const cached = getFromCache(cacheKey);
    if (cached) {
      return successResponse(res, 200, cached.data, cached.meta);
    }

    if (grouping === "daily") {
      const dailyObs = await NasaObservation.find({
        datasetKey: DATASET_KEY,
        districtCode: district,
        parameter: "PRECTOTCORR",
        dateLabel: { $gte: from, $lte: to },
      })
        .select("dateLabel value quality createdAt -_id")
        .sort({ dateLabel: 1 })
        .lean();

      const responsePayload = {
        data: {
          district,
          parameter: "PRECTOTCORR",
          unit: "mm/day",
          grouping: "daily",
          series: dailyObs.map((row) => ({ ...row, observationDate: row.dateLabel, ingestedAt: row.createdAt || null })),
        },
        meta: {
          district,
          parameter: "PRECTOTCORR",
          unit: "mm/day",
          grouping: "daily",
          total_days: dailyObs.length,
          time_standard: "LST",
          dataset_provenance: "nasa:power:daily:point",
        },
      };

      setInCache(cacheKey, responsePayload);
      return successResponse(res, 200, responsePayload.data, responsePayload.meta);
    }

    const analysis = await analyzeDistrictClimate({
      districtCode: district,
      parameter: "PRECTOTCORR",
      startIso: from,
      endIso: to,
    });

    let selectedData = {};
    if (grouping === "monthly") {
      selectedData = {
        series: analysis.data.monthly_series,
        historical_normals: analysis.data.monthly_historical,
      };
    } else if (grouping === "annual") {
      selectedData = {
        series: analysis.data.annual_series,
        historical_normals: analysis.data.annual_historical,
      };
    } else if (grouping === "seasonal") {
      selectedData = {
        historical_seasons: analysis.data.seasonal_historical,
        seasons_definition: {
          winter: "December to February (Dec–Feb, 3 months) — Rabi cool season",
          pre_monsoon: "March to May (Mar–May, 3 months) — Hot pre-monsoon season",
          monsoon: "June to September (Jun–Sep, 4 months) — South-west monsoon season",
          post_monsoon: "October to November (Oct–Nov, 2 months) — Post-monsoon transition",
        },
      };
    }

    const meta = {
      ...analysis.meta,
      grouping,
      wet_day_definition: "Project-selected threshold: valid daily precipitation >= 1.0 mm; missing days are excluded; not an agronomic threshold",
    };

    const result = { data: selectedData, meta };
    setInCache(cacheKey, result);
    return successResponse(res, 200, selectedData, meta);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/climate/temperature?district=chattogram&from=2001-01-01&to=2025-12-31&metric=t2m
 */
export async function getTemperature(req, res, next) {
  try {
    const validation = validateClimateQuery(req.query);
    if (!validation.valid) {
      return errorResponse(res, 400, validation.message, validation.code);
    }

    const { district, from, to } = validation;
    const metric = (req.query.metric || "t2m").toLowerCase();

    if (!VALID_TEMP_METRICS.has(metric)) {
      return errorResponse(
        res,
        400,
        `metric '${metric}' is invalid. Supported: ${[...VALID_TEMP_METRICS].join(", ")}`,
        "INVALID_METRIC"
      );
    }

    if (!snapshotService.isDbConnected()) {
      const snapshot = snapshotService.getClimateSnapshot(district);
      if (snapshot && snapshot.data && snapshot.data.temperature) {
        const temp = snapshot.data.temperature;
        const meta = {
          district,
          metric,
          unit: "C",
          provenance: "SNAPSHOT",
          databaseConnected: false,
          snapshotGeneratedAt: snapshot.snapshotMetadata.generatedAt,
          sourceDataset: snapshot.snapshotMetadata.sourceDataset,
          limitations: snapshot.snapshotMetadata.limitations,
          metric_descriptions: {
            t2m: "Temperature at 2 Meters (daily average)",
            tmax: "Maximum Temperature at 2 Meters",
            tmin: "Minimum Temperature at 2 Meters",
            diurnal_range: "Diurnal Temperature Range (TMAX - TMIN)",
          },
        };
        return successResponse(res, 200, temp, meta);
      }

      return errorResponse(
        res,
        503,
        `Temperature data for district '${district}' is not available in the database`,
        "DATA_UNAVAILABLE"
      );
    }

    const obsCount = await NasaObservation.countDocuments({
      datasetKey: DATASET_KEY,
      districtCode: district,
      parameter: "T2M",
      dateLabel: { $gte: from, $lte: to },
    });

    if (obsCount === 0) {
      return errorResponse(
        res,
        503,
        `Temperature data for district '${district}' is not available in the database`,
        "DATA_UNAVAILABLE"
      );
    }

    const cacheKey = getCacheKey(["temperature", district, from, to, metric]);
    const cached = getFromCache(cacheKey);
    if (cached) {
      return successResponse(res, 200, cached.data, cached.meta);
    }

    const analysis = await analyzeDistrictClimate({
      districtCode: district,
      parameter: "T2M",
      startIso: from,
      endIso: to,
    });

    const meta = {
      ...analysis.meta,
      metric,
      unit: "C",
      metric_descriptions: {
        t2m: "Temperature at 2 Meters (daily average)",
        tmax: "Maximum Temperature at 2 Meters",
        tmin: "Minimum Temperature at 2 Meters",
        diurnal_range: "Diurnal Temperature Range (TMAX - TMIN)",
      },
    };

    const result = { data: analysis.data, meta };
    setInCache(cacheKey, result);
    return successResponse(res, 200, analysis.data, meta);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/climate/handoff?district=cumilla&transition=aman-mustard
 * Scientific seasonal transition and climate shift analysis between sequential crops.
 */
export async function getHandoffPlan(req, res, next) {
  try {
    const district = (req.query.district || "cumilla").trim().toLowerCase();
    if (!VALID_DISTRICT_CODES.has(district)) {
      return errorResponse(
        res,
        400,
        `Unknown district '${district}'. Supported: ${Array.from(VALID_DISTRICT_CODES).join(", ")}`,
        "INVALID_DISTRICT"
      );
    }

    const transition = (req.query.transition || "aman-mustard").trim().toLowerCase();
    const validTransitions = new Set(["aman-mustard", "boro-aus"]);
    if (!validTransitions.has(transition)) {
      return errorResponse(
        res,
        400,
        `Unknown crop transition '${transition}'. Supported: ${Array.from(validTransitions).join(", ")}`,
        "INVALID_CROP_TRANSITION"
      );
    }

    if (!snapshotService.isDbConnected()) {
      const snapshot = snapshotService.getHandoffSnapshot(district, transition);
      if (snapshot && snapshot.data) {
        const meta = {
          district,
          transition,
          provenance: "SNAPSHOT",
          databaseConnected: false,
          snapshotGeneratedAt: snapshot.snapshotMetadata?.generatedAt,
          sourceDataset: snapshot.snapshotMetadata?.sourceDataset,
          limitations: snapshot.snapshotMetadata?.limitations,
        };
        return successResponse(res, 200, snapshot.data, meta);
      }

      return errorResponse(
        res,
        503,
        `Historical climate data for district '${district}' is not yet available in the database`,
        "DATA_UNAVAILABLE"
      );
    }

    // Verify data availability in DB
    const obsCount = await NasaObservation.countDocuments({
      datasetKey: DATASET_KEY,
      districtCode: district,
    });

    if (obsCount === 0) {
      return errorResponse(
        res,
        503,
        `Historical climate data for district '${district}' is not yet available in the database`,
        "DATA_UNAVAILABLE"
      );
    }

    const cacheKey = getCacheKey(["handoff", district, transition]);
    const cached = getFromCache(cacheKey);
    if (cached) {
      return successResponse(res, 200, cached.data, cached.meta);
    }

    const analysis = await analyzeHandoff({
      districtCode: district,
      cropTransition: transition,
    });

    const meta = {
      ...(analysis.meta || {}),
      provenance: "HISTORICAL_DATABASE",
      databaseConnected: true,
    };

    setInCache(cacheKey, { data: analysis.data, meta });
    return successResponse(res, 200, analysis.data, meta);
  } catch (error) {
    try {
      const district = (req.query.district || "cumilla").trim().toLowerCase();
      const transition = (req.query.transition || "aman-mustard").trim().toLowerCase();
      const snapshot = snapshotService.getHandoffSnapshot(district, transition);
      if (snapshot && snapshot.data) {
        const meta = {
          district,
          transition,
          provenance: "SNAPSHOT",
          databaseConnected: false,
          snapshotGeneratedAt: snapshot.snapshotMetadata?.generatedAt,
          sourceDataset: snapshot.snapshotMetadata?.sourceDataset,
          limitations: snapshot.snapshotMetadata?.limitations,
        };
        return successResponse(res, 200, snapshot.data, meta);
      }
    } catch {
      // Ignore
    }
    next(error);
  }
}
