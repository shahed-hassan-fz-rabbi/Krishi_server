import { DIVISIONS } from "../config/division.config.js";
import { getRegionalIntelligence } from "../services/regional-intelligence.service.js";
import { errorResponse, successResponse } from "../utils/response.js";

export function getDivisions(req, res) {
  return successResponse(res, 200, DIVISIONS, {
    source: "BBS-derived administrative division polygon centroids",
    coordinateReferenceSystem: "EPSG:4326 (WGS 84)",
    limitation: "A representative point does not describe every location in a division.",
  });
}

export async function getDivisionIntelligence(req, res, next) {
  try {
    const code = String(req.query.division || "").trim().toLowerCase();
    const supported = DIVISIONS.some((division) => division.code === code);
    if (!supported) {
      return errorResponse(res, 400, "A supported Bangladesh division is required.", "INVALID_DIVISION", undefined, {
        supportedDivisions: DIVISIONS.map((division) => division.code),
      });
    }
    const data = await getRegionalIntelligence(code);
    return successResponse(res, 200, data, {
      source: "NASA provider API and validated product status",
      databaseWrites: false,
    });
  } catch (error) {
    next(error);
  }
}
