/**
 * MODIS Vegetation Intelligence Controller.
 * Handles /api/v1/vegetation/latest, /api/v1/vegetation/history, and /api/v1/vegetation/status.
 * Delivers NASA MODIS MOD13Q1.061 250m NDVI and EVI with transparent pixel reliability.
 */

import { DISTRICTS } from "../config/climate.config.js";
import { MODIS } from "../config/modis.config.js";
import { ModisObservation } from "../models/modisobservation.model.js";
import { isAppeearsConfigured } from "../services/nasa/appeears.client.js";
import { errorResponse, successResponse } from "../utils/response.js";

const VALID_DISTRICT_CODES = new Set(DISTRICTS.map((d) => d.code));

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
 * GET /api/v1/vegetation/latest?district=cumilla
 */
export async function getLatestVegetation(req, res, next) {
  try {
    const check = validateDistrict(req.query.district);
    if (!check.valid) {
      return errorResponse(res, 400, check.message, check.code);
    }
    const { district } = check;

    const latestDoc = await ModisObservation.findOne({ districtCode: district })
      .sort({ dateLabel: -1 })
      .lean();

    if (!latestDoc) {
      return errorResponse(
        res,
        503,
        `No MODIS vegetation observations are currently stored for district '${district}'. Ingestion job must be executed.`,
        "DATA_NOT_INGESTED"
      );
    }

    const data = {
      districtCode: district,
      dateLabel: latestDoc.dateLabel,
      compositeDayOfYear: latestDoc.compositeDayOfYear,
      ndvi: latestDoc.ndvi,
      evi: latestDoc.evi,
      pixelReliability: latestDoc.pixelReliability,
      isReliableQuality: latestDoc.isReliableQuality,
      qualityClassification: latestDoc.qualityClassification,
      spatialResolution: MODIS.spatialResolution,
      temporalCadence: MODIS.temporalCadence,
      datasetKey: MODIS.datasetKey,
    };

    const meta = {
      dataset: MODIS.productName,
      provider: MODIS.provider,
      scientificDisclosure: MODIS.disclosure,
      retrievedAt: new Date().toISOString(),
    };

    return successResponse(res, 200, data, meta);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/vegetation/history?district=cumilla&from=2024-01-01&to=2024-12-31&quality=good
 */
export async function getVegetationHistory(req, res, next) {
  try {
    const check = validateDistrict(req.query.district);
    if (!check.valid) {
      return errorResponse(res, 400, check.message, check.code);
    }
    const { district } = check;

    const from = req.query.from || "2024-01-01";
    const to = req.query.to || "2024-12-31";
    const qualityFilter = req.query.quality; // 'good' | 'all'

    if (from > to) {
      return errorResponse(res, 400, "'from' date cannot be after 'to' date", "INVALID_DATE_RANGE");
    }

    const query = {
      districtCode: district,
      dateLabel: { $gte: from, $lte: to },
    };

    if (qualityFilter === "good") {
      query.isReliableQuality = true;
    }

    const docs = await ModisObservation.find(query).sort({ dateLabel: 1 }).lean();

    if (docs.length === 0) {
      return errorResponse(
        res,
        503,
        `No MODIS vegetation data found for district '${district}' in range [${from}..${to}]${qualityFilter ? ` (filter: ${qualityFilter})` : ""}`,
        "DATA_UNAVAILABLE"
      );
    }

    let totalValidCount = 0;
    let totalNdviSum = 0;
    let totalEviSum = 0;
    let reliableCount = 0;
    let reliableNdviSum = 0;
    let reliableEviSum = 0;
    let marginalOrCloudCount = 0;

    const series = docs.map((d) => {
      const isNdviVal = d.ndvi !== null;
      if (isNdviVal) {
        totalValidCount += 1;
        totalNdviSum += d.ndvi;
        if (d.evi !== null) totalEviSum += d.evi;

        if (d.isReliableQuality) {
          reliableCount += 1;
          reliableNdviSum += d.ndvi;
          if (d.evi !== null) reliableEviSum += d.evi;
        } else {
          marginalOrCloudCount += 1;
        }
      }

      return {
        date: d.dateLabel,
        compositeDayOfYear: d.compositeDayOfYear,
        ndvi: d.ndvi,
        evi: d.evi,
        pixelReliability: d.pixelReliability,
        isReliableQuality: d.isReliableQuality,
        qualityClassification: d.qualityClassification,
      };
    });

    const reliableAverageNdvi =
      reliableCount > 0 ? Number((reliableNdviSum / reliableCount).toFixed(4)) : null;
    const reliableAverageEvi =
      reliableCount > 0 ? Number((reliableEviSum / reliableCount).toFixed(4)) : null;
    const compositeAverageNdvi =
      totalValidCount > 0 ? Number((totalNdviSum / totalValidCount).toFixed(4)) : null;
    const reliablePercentage =
      docs.length > 0 ? Number(((reliableCount / docs.length) * 100).toFixed(1)) : 0;

    const data = {
      districtCode: district,
      from,
      to,
      qualityFilter: qualityFilter || "all",
      summary: {
        totalRecords: docs.length,
        totalValidObservations: totalValidCount,
        reliableObservationsCount: reliableCount,
        marginalOrCloudCount,
        reliableAverageNdvi,
        reliableAverageEvi,
        compositeAverageNdvi,
        reliableQualityPercentage: reliablePercentage,
      },
      series,
    };

    const meta = {
      dataset: MODIS.productName,
      spatialResolution: MODIS.spatialResolution,
      temporalCadence: MODIS.temporalCadence,
      scientificDisclosure: MODIS.disclosure,
    };

    return successResponse(res, 200, data, meta);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/vegetation/status
 */
export async function getVegetationStatus(req, res, next) {
  try {
    const configured = isAppeearsConfigured();
    const count = await ModisObservation.countDocuments();
    const cumillaCount = await ModisObservation.countDocuments({ districtCode: "cumilla" });
    const chattogramCount = await ModisObservation.countDocuments({ districtCode: "chattogram" });

    const latestDoc = await ModisObservation.findOne().sort({ dateLabel: -1 }).lean();

    return successResponse(res, 200, {
      appeearsConfigured: configured,
      dataset: MODIS.productName,
      collectionConceptId: MODIS.collectionConceptId,
      totalObservationsStored: count,
      districts: {
        cumilla: cumillaCount,
        chattogram: chattogramCount,
      },
      latestStoredDate: latestDoc ? latestDoc.dateLabel : null,
      documentationUrls: MODIS.documentationUrls,
    });
  } catch (error) {
    next(error);
  }
}
