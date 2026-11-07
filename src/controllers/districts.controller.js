/**
 * District Controller.
 * Exposes enabled districts with exact coordinates and metadata.
 */
import { District } from "../models/district.model.js";
import { successResponse } from "../utils/response.js";

/**
 * GET /api/v1/districts
 * Returns all enabled agricultural districts.
 */
export async function getDistricts(req, res, next) {
  try {
    const districts = await District.find({ enabled: true })
      .select("code nameEn nameBn latitude longitude isDefault enabled coordinateSource -_id")
      .sort({ isDefault: -1, code: 1 })
      .lean();

    const defaultDistrict = districts.find((d) => d.isDefault)?.code || "chattogram";

    return successResponse(res, 200, districts, {
      count: districts.length,
      defaultDistrict,
    });
  } catch (error) {
    next(error);
  }
}
