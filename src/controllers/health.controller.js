/** @module controllers/health */

import { getDatabaseState } from "../config/database.js";
import { successResponse } from "../utils/response.js";
import { NasaDataset } from "../models/nasadataset.model.js";
import { NasaObservation } from "../models/nasaobservation.model.js";
import { POWER } from "../config/climate.config.js";

export const DATASET_FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function isDatasetFresh(coverage, now = new Date()) {
  const verifiedAt = coverage?.lastVerifiedAt ? new Date(coverage.lastVerifiedAt) : null;
  const hasObservedDate = Boolean(coverage?.lastObservedDate);
  if (!hasObservedDate || !verifiedAt || Number.isNaN(verifiedAt.getTime())) return false;
  const ageMs = now.getTime() - verifiedAt.getTime();
  return ageMs >= 0 && ageMs <= DATASET_FRESHNESS_WINDOW_MS;
}

/**
 * GET /api/v1/health
 * Liveness + readiness indicator. Reports API status, uptime,
 * MongoDB connection state, and NASA dataset freshness independently.
 */
export async function getHealth(req, res) {
  const db = getDatabaseState();
  const dbConnected = db.readyState === 1;

  const datasetStatus = {
    configured: true,
    datasetKey: POWER.datasetKey,
    product: POWER.productName,
    isPopulated: false,
    isFresh: false,
    observationCount: 0,
    coverage: null,
    checkStatus: dbConnected ? "not_checked" : "database_disconnected",
  };

  if (dbConnected) {
    try {
      const ds = await NasaDataset.findById(POWER.datasetKey).lean();
      const count = await NasaObservation.countDocuments();
      if (ds) {
        datasetStatus.checkStatus = "ok";
        datasetStatus.isPopulated = count > 0;
        datasetStatus.observationCount = count;
        datasetStatus.coverage = {
          firstObservedDate: ds.coverage?.firstObservedDate || null,
          lastObservedDate: ds.coverage?.lastObservedDate || null,
          lastVerifiedAt: ds.coverage?.lastVerifiedAt || null,
        };
        datasetStatus.isFresh = count > 0 && isDatasetFresh(ds.coverage);
      }
    } catch {
      datasetStatus.checkStatus = "query_failed";
    }
  }

  const overallStatus = dbConnected
    ? datasetStatus.checkStatus === "query_failed"
      ? "degraded_dataset_check_failed"
      : datasetStatus.isPopulated
      ? datasetStatus.isFresh
        ? "ok"
        : "degraded_dataset_stale"
      : "degraded_dataset_empty"
    : "degraded_db_disconnected";

  return successResponse(res, 200, {
    status: overallStatus,
    service: "krishi-mama-api",
    version: "v1",
    environment: process.env.NODE_ENV || "development",
    database: {
      connected: dbConnected,
      state: db.state,
    },
    dataset: datasetStatus,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
