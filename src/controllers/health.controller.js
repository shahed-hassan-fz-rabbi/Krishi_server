/** @module controllers/health */

import { getDatabaseState } from "../config/database.js";
import { successResponse } from "../utils/response.js";

/**
 * GET /api/v1/health
 * Liveness + readiness indicator. Reports API status, uptime,
 * and the live MongoDB connection state.
 */
export function getHealth(req, res) {
  const db = getDatabaseState();

  return successResponse(res, 200, {
    status: "ok",
    service: "krishi-mama-api",
    version: "v1",
    environment: process.env.NODE_ENV || "development",
    database: {
      connected: db.readyState === 1,
      state: db.state,
    },
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
