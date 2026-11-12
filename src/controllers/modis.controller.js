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
import { snapshotService } from "../services/snapshot.service.js";

const VALID_DISTRICT_CODES = new Set(DISTRICTS.map((d) => d.code));
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isValidObservationDate(dateLabel) {
  if (typeof dateLabel !== "string" || !ISO_DAY.test(dateLabel)) return false;
  const date = new Date(`${dateLabel}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateLabel;
}

function validIndex(value) {
  return Number.isFinite(value) && value >= MODIS.layers.ndvi.validMin && value <= MODIS.layers.ndvi.validMax
    ? value
    : null;
}

function isEligibleGoodObservation(observation, district) {
  if (
    !observation ||
    observation.districtCode !== district ||
    observation.datasetKey !== MODIS.datasetKey ||
    !isValidObservationDate(observation.dateLabel) ||
    observation.pixelReliability !== 0 ||
    observation.isReliableQuality !== true ||
    observation.qualityClassification !== "good_data"
  ) return false;

  return validIndex(observation.ndvi) !== null || validIndex(observation.evi) !== null;
}

function latestEligibleSnapshotObservation(snapshot, district) {
  if (!Array.isArray(snapshot?.observations)) return null;
  return snapshot.observations
    .filter((observation) => isEligibleGoodObservation(observation, district))
    .sort((a, b) => b.dateLabel.localeCompare(a.dateLabel))[0] || null;
}

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

function buildModisLatestPayload(district, latestDoc, isSnapshot = false, limitations = null) {
  const data = {
    districtCode: district,
    dateLabel: latestDoc.dateLabel,
    ingestedAt: latestDoc.createdAt || null,
    compositeDayOfYear: latestDoc.compositeDayOfYear,
    ndvi: validIndex(latestDoc.ndvi),
    evi: validIndex(latestDoc.evi),
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
    provenance: isSnapshot ? "SNAPSHOT" : "HISTORICAL_DATABASE",
    databaseConnected: !isSnapshot,
    ...(limitations ? { limitations } : {}),
  };

  return { data, meta };
}

function buildModisHistoryPayload(district, from, to, qualityFilter, docs, isSnapshot = false, limitations = null) {
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
      ingestedAt: d.createdAt || null,
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
    provenance: isSnapshot ? "SNAPSHOT" : "HISTORICAL_DATABASE",
    databaseConnected: !isSnapshot,
    ...(limitations ? { limitations } : {}),
  };

  return { data, meta };
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

    if (!snapshotService.isDbConnected()) {
      const snapshot = snapshotService.getModisSnapshot(district);
      const snapshotLatest = latestEligibleSnapshotObservation(snapshot, district);
      if (snapshotLatest) {
        const { data, meta } = buildModisLatestPayload(
          district,
          snapshotLatest,
          true,
          snapshot.snapshotMetadata?.limitations
        );
        return successResponse(res, 200, data, meta);
      }
      return errorResponse(res, 503, `No rank-0 quality-approved MODIS observation is available for district '${district}'.`, "DATA_NO_VALID_OBSERVATIONS");
    }

    const reliableFilter = {
      districtCode: district,
      datasetKey: MODIS.datasetKey,
      isReliableQuality: true,
      qualityClassification: "good_data",
      pixelReliability: 0,
      dateLabel: { $type: "string", $regex: /^\d{4}-\d{2}-\d{2}$/ },
      $or: [
        { ndvi: { $type: "number", $gte: -0.2, $lte: 1 } },
        { evi: { $type: "number", $gte: -0.2, $lte: 1 } },
      ],
    };
    const validObservationCount = await ModisObservation.countDocuments(reliableFilter);
    if (validObservationCount === 0) {
      return errorResponse(
        res,
        503,
        `No reliable MODIS vegetation observations are stored for district '${district}'.`,
        "DATA_NO_VALID_OBSERVATIONS"
      );
    }

    // Choose the newest observation that passed the same quality gate used for
    // the availability count. A newer marginal/cloudy pixel must not hide an
    // older usable observation for this district.
    const latestDoc = await ModisObservation.findOne(reliableFilter)
      .sort({ dateLabel: -1 })
      .lean();

    if (!latestDoc || !isEligibleGoodObservation(latestDoc, district)) {
      const snapshot = snapshotService.getModisSnapshot(district);
      const snapshotLatest = latestEligibleSnapshotObservation(snapshot, district);
      if (snapshotLatest) {
        const { data, meta } = buildModisLatestPayload(
          district,
          snapshotLatest,
          true,
          snapshot.snapshotMetadata?.limitations
        );
        return successResponse(res, 200, data, meta);
      }

      return errorResponse(res, 503, `No rank-0 quality-approved MODIS observation is available for district '${district}'.`, "DATA_NO_VALID_OBSERVATIONS");
    }
    if (latestDoc.districtCode !== district) {
      return errorResponse(res, 500, "MODIS district isolation check failed.", "DATA_ISOLATION_VIOLATION");
    }

    const { data, meta } = buildModisLatestPayload(district, latestDoc, false);
    return successResponse(res, 200, data, meta);
  } catch (error) {
    try {
      const check = validateDistrict(req.query.district);
      if (check.valid) {
        const snapshot = snapshotService.getModisSnapshot(check.district);
        const snapshotLatest = latestEligibleSnapshotObservation(snapshot, check.district);
        if (snapshotLatest) {
          const { data, meta } = buildModisLatestPayload(
            check.district,
            snapshotLatest,
            true,
            snapshot.snapshotMetadata?.limitations
          );
          return successResponse(res, 200, data, meta);
        }
      }
    } catch {
      // Fall through
    }
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

    if (!snapshotService.isDbConnected()) {
      const snapshot = snapshotService.getModisSnapshot(district);
      if (snapshot && snapshot.observations && snapshot.observations.length > 0) {
        let obs = snapshot.observations.filter(
          (d) => d.dateLabel >= from && d.dateLabel <= to
        );
        if (qualityFilter === "good") {
          obs = obs.filter((d) => d.isReliableQuality);
        }
        if (obs.length > 0) {
          const { data, meta } = buildModisHistoryPayload(
            district,
            from,
            to,
            qualityFilter,
            obs,
            true,
            snapshot.snapshotMetadata?.limitations
          );
          return successResponse(res, 200, data, meta);
        }
      }

      return errorResponse(
        res,
        503,
        `No MODIS vegetation data found offline for district '${district}' in range [${from}..${to}]${qualityFilter ? ` (filter: ${qualityFilter})` : ""}`,
        "DATA_UNAVAILABLE"
      );
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
      const snapshot = snapshotService.getModisSnapshot(district);
      if (snapshot && snapshot.observations && snapshot.observations.length > 0) {
        let obs = snapshot.observations.filter(
          (d) => d.dateLabel >= from && d.dateLabel <= to
        );
        if (qualityFilter === "good") {
          obs = obs.filter((d) => d.isReliableQuality);
        }
        if (obs.length > 0) {
          const { data, meta } = buildModisHistoryPayload(
            district,
            from,
            to,
            qualityFilter,
            obs,
            true,
            snapshot.snapshotMetadata?.limitations
          );
          return successResponse(res, 200, data, meta);
        }
      }

      return errorResponse(
        res,
        503,
        `No MODIS vegetation data found for district '${district}' in range [${from}..${to}]${qualityFilter ? ` (filter: ${qualityFilter})` : ""}`,
        "DATA_UNAVAILABLE"
      );
    }

    const { data, meta } = buildModisHistoryPayload(district, from, to, qualityFilter, docs, false);
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

    if (!snapshotService.isDbConnected()) {
      const cumillaSnap = snapshotService.getModisSnapshot("cumilla");
      const chattogramSnap = snapshotService.getModisSnapshot("chattogram");
      const cumillaCount = cumillaSnap?.observations?.length || 3;
      const chattogramCount = chattogramSnap?.observations?.length || 3;

      return successResponse(res, 200, {
        appeearsConfigured: configured,
        dataset: MODIS.productName,
        collectionConceptId: MODIS.collectionConceptId,
        totalObservationsStored: cumillaCount + chattogramCount,
        districts: {
          cumilla: cumillaCount,
          chattogram: chattogramCount,
        },
        latestStoredDate: cumillaSnap?.latest?.dateLabel || "2024-01-17",
        documentationUrls: MODIS.documentationUrls,
        provenance: "SNAPSHOT",
        databaseConnected: false,
      });
    }

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
      provenance: "HISTORICAL_DATABASE",
      databaseConnected: true,
    });
  } catch (error) {
    next(error);
  }
}
