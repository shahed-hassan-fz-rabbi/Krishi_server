/**
 * Soil Moisture Controller.
 * Handles /api/v1/soil-moisture/latest, /api/v1/soil-moisture/history, and /api/v1/soil-moisture/status.
 * Delivers NASA SMAP SPL3SMP_E V006 volumetric surface soil moisture with full scientific disclosures.
 */

import { DISTRICTS } from "../config/climate.config.js";
import { SMAP } from "../config/smap.config.js";
import { SmapObservation } from "../models/smapobservation.model.js";
import { errorResponse, successResponse } from "../utils/response.js";
import { isEarthdataConfigured, verifyEarthdataAuth } from "../services/nasa/earthdata.auth.js";
import { searchSmapGranules } from "../services/nasa/smap.client.js";

const VALID_DISTRICT_CODES = new Set(DISTRICTS.map((d) => d.code));

/**
 * Validates district code.
 */
function validateDistrict(code) {
  const district = (code || "cumilla").trim().toLowerCase();
  if (!VALID_DISTRICT_CODES.has(district)) {
    return {
      valid: false,
      message: `District '${district}' is invalid. Supported: ${[...VALID_DISTRICT_CODES].join(", ")}`,
      code: "INVALID_DISTRICT",
    };
  }
  return { valid: true, district };
}

/**
 * GET /api/v1/soil-moisture/latest?district=cumilla
 */
export async function getLatestSoilMoisture(req, res, next) {
  try {
    const check = validateDistrict(req.query.district);
    if (!check.valid) {
      return errorResponse(res, 400, check.message, check.code);
    }
    const { district } = check;

    // Find the latest recorded observation
    const latestDoc = await SmapObservation.findOne({ districtCode: district })
      .sort({ dateLabel: -1, orbit: -1 })
      .lean();

    if (!latestDoc) {
      return errorResponse(
        res,
        503,
        `No SMAP soil moisture observations are currently stored for district '${district}'. Ingestion job must be executed.`,
        "DATA_NOT_INGESTED"
      );
    }

    // Also look for corresponding AM/PM on the same date
    const sameDateDocs = await SmapObservation.find({
      districtCode: district,
      dateLabel: latestDoc.dateLabel,
    }).lean();

    const amDoc = sameDateDocs.find((d) => d.orbit === "AM") || null;
    const pmDoc = sameDateDocs.find((d) => d.orbit === "PM") || null;

    const data = {
      districtCode: district,
      dateLabel: latestDoc.dateLabel,
      latestOrbit: latestDoc.orbit,
      soilMoisture: latestDoc.soilMoisture,
      unit: SMAP.unit,
      isRecommendedQuality: latestDoc.isRecommendedQuality,
      qualityClassification:
        latestDoc.qualityClassification ||
        (latestDoc.isRecommendedQuality ? "recommended" : "not_recommended"),
      retrievalQualityFlag: latestDoc.retrievalQualityFlag,
      orbits: {
        am: amDoc
          ? {
              soilMoisture: amDoc.soilMoisture,
              qualityFlag: amDoc.retrievalQualityFlag,
              isRecommended: amDoc.isRecommendedQuality,
              qualityClassification:
                amDoc.qualityClassification ||
                (amDoc.isRecommendedQuality ? "recommended" : "not_recommended"),
            }
          : null,
        pm: pmDoc
          ? {
              soilMoisture: pmDoc.soilMoisture,
              qualityFlag: pmDoc.retrievalQualityFlag,
              isRecommended: pmDoc.isRecommendedQuality,
              qualityClassification:
                pmDoc.qualityClassification ||
                (pmDoc.isRecommendedQuality ? "recommended" : "not_recommended"),
            }
          : null,
      },
      spatialResolution: SMAP.spatialResolution,
      datasetKey: SMAP.datasetKey,
    };

    const meta = {
      dataset: SMAP.productName,
      provider: SMAP.provider,
      scientificDisclosure: SMAP.disclosure,
      retrievedAt: new Date().toISOString(),
    };

    return successResponse(res, 200, data, meta);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/soil-moisture/history?district=cumilla&from=2024-01-01&to=2024-12-31
 */
export async function getSoilMoistureHistory(req, res, next) {
  try {
    const check = validateDistrict(req.query.district);
    if (!check.valid) {
      return errorResponse(res, 400, check.message, check.code);
    }
    const { district } = check;

    const from = req.query.from || "2024-01-01";
    const to = req.query.to || "2024-12-31";
    const qualityFilter = req.query.quality; // 'recommended' | 'all'

    if (from > to) {
      return errorResponse(res, 400, "'from' date cannot be after 'to' date", "INVALID_DATE_RANGE");
    }

    const query = {
      districtCode: district,
      dateLabel: { $gte: from, $lte: to },
    };

    if (qualityFilter === "recommended") {
      query.isRecommendedQuality = true;
    }

    const docs = await SmapObservation.find(query)
      .sort({ dateLabel: 1, orbit: 1 })
      .lean();

    if (docs.length === 0) {
      return errorResponse(
        res,
        503,
        `No SMAP soil moisture data found for district '${district}' in range [${from}..${to}]${qualityFilter ? ` (filter: ${qualityFilter})` : ""}`,
        "DATA_UNAVAILABLE"
      );
    }

    let totalValidCount = 0;
    let totalSumMoisture = 0;
    let recommendedCount = 0;
    let recommendedSumMoisture = 0;
    let unconfirmedCount = 0;

    const series = docs.map((d) => {
      const isVal = d.soilMoisture !== null;
      if (isVal) {
        totalValidCount += 1;
        totalSumMoisture += d.soilMoisture;
        if (d.isRecommendedQuality) {
          recommendedCount += 1;
          recommendedSumMoisture += d.soilMoisture;
        } else {
          unconfirmedCount += 1;
        }
      }

      return {
        date: d.dateLabel,
        orbit: d.orbit,
        soilMoisture: d.soilMoisture,
        qualityFlag: d.retrievalQualityFlag,
        isRecommended: d.isRecommendedQuality,
        qualityClassification:
          d.qualityClassification || (d.isRecommendedQuality ? "recommended" : "not_recommended"),
        surfaceFlag: d.surfaceFlag,
        qaBits: d.qaBits || null,
        geophysical: {
          surfaceTemperatureK: d.surfaceTemperatureK ?? null,
          freezeThawFraction: d.freezeThawFraction ?? null,
          bulkDensity: d.bulkDensity ?? null,
          clayFraction: d.clayFraction ?? null,
          staticWaterFraction: d.staticWaterFraction ?? null,
          soilPorosity: d.soilPorosity ?? null,
        },
      };
    });

    const recommendedAverage =
      recommendedCount > 0 ? Number((recommendedSumMoisture / recommendedCount).toFixed(4)) : null;
    const compositeAverage =
      totalValidCount > 0 ? Number((totalSumMoisture / totalValidCount).toFixed(4)) : null;
    const highQualityRatio =
      docs.length > 0 ? Number(((recommendedCount / docs.length) * 100).toFixed(1)) : 0;

    const data = {
      districtCode: district,
      from,
      to,
      qualityFilter: qualityFilter || "all",
      summary: {
        totalRecords: docs.length,
        totalValidObservations: totalValidCount,
        recommendedObservationsCount: recommendedCount,
        unconfirmedObservationsCount: unconfirmedCount,
        // Recommended-only average strictly excludes non-recommended observations
        recommendedAverageSoilMoisture: recommendedAverage,
        // Composite average clearly flagged as including unconfirmed observations
        compositeAverageSoilMoisture: compositeAverage,
        unit: SMAP.unit,
        recommendedQualityPercentage: highQualityRatio,
      },
      series,
    };

    const meta = {
      dataset: SMAP.productName,
      spatialResolution: SMAP.spatialResolution,
      scientificDisclosure: SMAP.disclosure,
    };

    return successResponse(res, 200, data, meta);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/soil-moisture/status
 * Informs frontend about Earthdata configuration and local database coverage.
 */
export async function getSoilMoistureStatus(req, res, next) {
  try {
    const isConfigured = isEarthdataConfigured();
    const count = await SmapObservation.countDocuments();
    const cumillaCount = await SmapObservation.countDocuments({ districtCode: "cumilla" });
    const chattogramCount = await SmapObservation.countDocuments({ districtCode: "chattogram" });

    const latestDoc = await SmapObservation.findOne().sort({ dateLabel: -1 }).lean();

    return successResponse(res, 200, {
      earthdataConfigured: isConfigured,
      dataset: SMAP.productName,
      collectionConceptId: SMAP.collectionConceptId,
      totalObservationsStored: count,
      districts: {
        cumilla: cumillaCount,
        chattogram: chattogramCount,
      },
      latestStoredDate: latestDoc ? latestDoc.dateLabel : null,
      documentationUrls: SMAP.documentationUrls,
    });
  } catch (error) {
    next(error);
  }
}
