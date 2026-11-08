/**
 * Crop Lifecycle Template Controller.
 * Delivers verified crop lifecycle templates and district coverage.
 */

import {
  listSupportedTemplates,
  getCropLifecycleTemplate,
  loadOfficialCropCalendars,
} from "../services/croplifecycle.service.js";
import { errorResponse, successResponse } from "../utils/response.js";

/**
 * GET /api/v1/crop-lifecycle/templates
 * Returns all supported crop templates with district availability.
 */
export async function getTemplates(req, res, next) {
  try {
    const templates = listSupportedTemplates();
    return successResponse(
      res,
      200,
      { templates },
      { count: templates.length, version: "1.0.0-bamis" }
    );
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/crop-lifecycle/templates/:cropCode?district=cumilla
 * Returns template specifications for a specific crop and optional district.
 */
export async function getTemplateByCrop(req, res, next) {
  try {
    const { cropCode } = req.params;
    const { district } = req.query;

    const data = loadOfficialCropCalendars();
    const crop = data.crops.find((c) => c.cropId.toLowerCase() === cropCode.toLowerCase());

    if (!crop) {
      return errorResponse(
        res,
        404,
        `Crop '${cropCode}' is not supported in the official crop calendar.`,
        "CROP_NOT_FOUND"
      );
    }

    if (district) {
      const result = getCropLifecycleTemplate(cropCode, district);
      if (!result.success) {
        return errorResponse(res, 400, result.error, "INVALID_DISTRICT_OR_CROP");
      }
      return successResponse(res, 200, result.data);
    }

    // If no district specified, return all district variants for this crop
    const variants = {};
    for (const dCode of Object.keys(crop.districts)) {
      const resVar = getCropLifecycleTemplate(cropCode, dCode);
      if (resVar.success) {
        variants[dCode] = resVar.data;
      }
    }

    return successResponse(res, 200, {
      cropCode: crop.cropId,
      cropNameEn: crop.nameEn,
      cropNameBn: crop.nameBn,
      scientificName: crop.scientificName,
      availableDistricts: Object.keys(crop.districts),
      templatesByDistrict: variants,
    });
  } catch (error) {
    next(error);
  }
}
