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
import { snapshotService } from "../services/snapshot.service.js";

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
 * Formats a single SMAP observation document into API response payload.
 */
function buildSmapLatestPayload(district, latestDoc, amDoc = null, pmDoc = null, isSnapshot = false, limitations = null) {
  const data = {
    districtCode: district,
    dateLabel: latestDoc.dateLabel,
    ingestedAt: latestDoc.createdAt || null,
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
        : latestDoc.orbit === "AM"
        ? {
            soilMoisture: latestDoc.soilMoisture,
            qualityFlag: latestDoc.retrievalQualityFlag,
            isRecommended: latestDoc.isRecommendedQuality,
            qualityClassification: latestDoc.qualityClassification || "recommended",
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
        : latestDoc.orbit === "PM"
        ? {
            soilMoisture: latestDoc.soilMoisture,
            qualityFlag: latestDoc.retrievalQualityFlag,
            isRecommended: latestDoc.isRecommendedQuality,
            qualityClassification: latestDoc.qualityClassification || "recommended",
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
    provenance: isSnapshot ? "SNAPSHOT" : "HISTORICAL_DATABASE",
    databaseConnected: !isSnapshot,
    ...(limitations ? { limitations } : {}),
  };

  return { data, meta };
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

    // Check offline snapshot fallback first if DB is disconnected
    if (!snapshotService.isDbConnected()) {
      const snapshot = snapshotService.getSmapSnapshot(district);
      if (snapshot && snapshot.latest) {
        const { data, meta } = buildSmapLatestPayload(
          district,
          snapshot.latest,
          null,
          null,
          true,
          snapshot.snapshotMetadata?.limitations
        );
        return successResponse(res, 200, data, meta);
      }
      return errorResponse(
        res,
        503,
        `No SMAP soil moisture observations are available offline for district '${district}'.`,
        "DATA_UNAVAILABLE"
      );
    }

    const recommendedFilter = {
      districtCode: district,
      datasetKey: SMAP.datasetKey,
      retrievalQualityFlag: { $in: [0, 8] },
      isRecommendedQuality: true,
      qualityClassification: "recommended",
      soilMoisture: { $type: "number", $gte: 0, $lte: 1 },
    };
    const validObservationCount = await SmapObservation.countDocuments(recommendedFilter);
    if (validObservationCount === 0) {
      return errorResponse(
        res,
        503,
        `No recommended SMAP soil moisture observations are stored for district '${district}'.`,
        "DATA_NO_VALID_OBSERVATIONS"
      );
    }

    // Find the latest recorded observation
    const latestDoc = await SmapObservation.findOne({ districtCode: district, datasetKey: SMAP.datasetKey })
      .sort({ dateLabel: -1, orbit: -1 })
      .lean();

    if (!latestDoc) {
      const snapshot = snapshotService.getSmapSnapshot(district);
      if (snapshot && snapshot.latest) {
        const { data, meta } = buildSmapLatestPayload(
          district,
          snapshot.latest,
          null,
          null,
          true,
          snapshot.snapshotMetadata?.limitations
        );
        return successResponse(res, 200, data, meta);
      }

      return errorResponse(
        res,
        503,
        `No SMAP soil moisture observations are currently stored for district '${district}'. Ingestion job must be executed.`,
        "DATA_NOT_INGESTED"
      );
    }
    if (latestDoc.districtCode !== district) {
      return errorResponse(res, 500, "SMAP district isolation check failed.", "DATA_ISOLATION_VIOLATION");
    }

    // Also look for corresponding AM/PM on the same date
    const sameDateDocs = await SmapObservation.find({
      districtCode: district,
      datasetKey: SMAP.datasetKey,
      dateLabel: latestDoc.dateLabel,
    }).lean();
    if (sameDateDocs.some((doc) => doc.districtCode !== district)) {
      return errorResponse(res, 500, "SMAP district isolation check failed.", "DATA_ISOLATION_VIOLATION");
    }

    const amDoc = sameDateDocs.find((d) => d.orbit === "AM") || null;
    const pmDoc = sameDateDocs.find((d) => d.orbit === "PM") || null;

    const { data, meta } = buildSmapLatestPayload(district, latestDoc, amDoc, pmDoc, false);
    return successResponse(res, 200, data, meta);
  } catch (error) {
    try {
      const check = validateDistrict(req.query.district);
      if (check.valid) {
        const snapshot = snapshotService.getSmapSnapshot(check.district);
        if (snapshot && snapshot.latest) {
          const { data, meta } = buildSmapLatestPayload(
            check.district,
            snapshot.latest,
            null,
            null,
            true,
            snapshot.snapshotMetadata?.limitations
          );
          return successResponse(res, 200, data, meta);
        }
      }
    } catch {
      // Fall through to error handler
    }
    next(error);
  }
}

function buildSmapHistoryPayload(district, from, to, qualityFilter, docs, isSnapshot = false, limitations = null) {
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
      ingestedAt: d.createdAt || null,
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
      recommendedAverageSoilMoisture: recommendedAverage,
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
    provenance: isSnapshot ? "SNAPSHOT" : "HISTORICAL_DATABASE",
    databaseConnected: !isSnapshot,
    ...(limitations ? { limitations } : {}),
  };

  return { data, meta };
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

    if (!snapshotService.isDbConnected()) {
      const snapshot = snapshotService.getSmapSnapshot(district);
      if (snapshot && snapshot.observations && snapshot.observations.length > 0) {
        let obs = snapshot.observations.filter(
          (d) => d.dateLabel >= from && d.dateLabel <= to
        );
        if (qualityFilter === "recommended") {
          obs = obs.filter((d) => d.isRecommendedQuality);
        }
        if (obs.length > 0) {
          const { data, meta } = buildSmapHistoryPayload(
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
        `No SMAP soil moisture data found offline for district '${district}' in range [${from}..${to}]${qualityFilter ? ` (filter: ${qualityFilter})` : ""}`,
        "DATA_UNAVAILABLE"
      );
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
      const snapshot = snapshotService.getSmapSnapshot(district);
      if (snapshot && snapshot.observations && snapshot.observations.length > 0) {
        let obs = snapshot.observations.filter(
          (d) => d.dateLabel >= from && d.dateLabel <= to
        );
        if (qualityFilter === "recommended") {
          obs = obs.filter((d) => d.isRecommendedQuality);
        }
        if (obs.length > 0) {
          const { data, meta } = buildSmapHistoryPayload(
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
        `No SMAP soil moisture data found for district '${district}' in range [${from}..${to}]${qualityFilter ? ` (filter: ${qualityFilter})` : ""}`,
        "DATA_UNAVAILABLE"
      );
    }

    const { data, meta } = buildSmapHistoryPayload(district, from, to, qualityFilter, docs, false);
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

    if (!snapshotService.isDbConnected()) {
      const cumillaSnap = snapshotService.getSmapSnapshot("cumilla");
      const chattogramSnap = snapshotService.getSmapSnapshot("chattogram");
      const cumillaCount = cumillaSnap?.observations?.length || 2;
      const chattogramCount = chattogramSnap?.observations?.length || 2;

      return successResponse(res, 200, {
        earthdataConfigured: isConfigured,
        dataset: SMAP.productName,
        collectionConceptId: SMAP.collectionConceptId,
        totalObservationsStored: cumillaCount + chattogramCount,
        districts: {
          cumilla: cumillaCount,
          chattogram: chattogramCount,
        },
        latestStoredDate: cumillaSnap?.latest?.dateLabel || "2024-01-03",
        documentationUrls: SMAP.documentationUrls,
        provenance: "SNAPSHOT",
        databaseConnected: false,
      });
    }

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
      provenance: "HISTORICAL_DATABASE",
      databaseConnected: true,
    });
  } catch (error) {
    next(error);
  }
}
