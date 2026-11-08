/**
 * Crop Planning & Recommendation Controller.
 * Exposes endpoints for deterministic agronomic crop eligibility,
 * NASA satellite contextualization, and grounded AI explanation.
 */

import { errorResponse, successResponse } from "../utils/response.js";
import {
  evaluateCropEligibility,
  getPlanningSatelliteContext,
  generatePlanningExplanation,
} from "../services/cropplanning.service.js";

/**
 * POST /api/v1/crop-planning/recommendations
 * Evaluate suitable crops for a farm profile and generate an AI-assisted explanation.
 */
export async function getCropRecommendations(req, res, next) {
  try {
    const {
      districtCode,
      upazila = "",
      village = "",
      land = {},
      water = {},
      preferences = {},
      language = "bn",
    } = req.body || {};

    if (!districtCode || typeof districtCode !== "string") {
      return errorResponse(res, 400, "District code is required for crop planning.");
    }

    const {
      area = null,
      unit = "decimal",
      landType = "medium_high",
      soilType = "unknown",
      drainage = "good",
    } = land;

    const {
      irrigationAvailability = "available",
      waterSource = "",
    } = water;

    const {
      seasonPreference = null,
      preferredCrop = null,
      targetPlantingPeriod = null,
    } = preferences;

    // 1. Evaluate deterministic crop eligibility against official calendars
    const eligibility = evaluateCropEligibility({
      districtCode,
      upazila,
      landType,
      soilType,
      drainage,
      irrigationAvailability,
      waterSource,
      seasonPreference,
      preferredCrop,
      targetPlantingPeriod,
    });

    if (!eligibility.isValid) {
      return errorResponse(res, 400, eligibility.error);
    }

    // 2. Fetch NASA environmental context (SMAP & MODIS)
    const satelliteContext = await getPlanningSatelliteContext(districtCode);

    // 3. Generate grounded AI explanation (Gemini with deterministic fallback)
    const aiExplanation = await generatePlanningExplanation({
      districtCode,
      upazila,
      land: { area, unit, landType, soilType, drainage },
      water: { irrigationAvailability, waterSource },
      preferences: { seasonPreference, preferredCrop, targetPlantingPeriod },
      eligibleCrops: eligibility.crops,
      satelliteContext,
      language: language === "en" ? "en" : "bn",
    });

    const payload = {
      query: {
        districtCode: districtCode.trim().toLowerCase(),
        upazila: (upazila || "").trim(),
        village: (village || "").trim(),
        land: {
          area: typeof area === "number" ? area : null,
          unit,
          landType,
          soilType,
          drainage,
        },
        water: {
          irrigationAvailability,
          waterSource: (waterSource || "").trim(),
        },
        preferences: {
          seasonPreference,
          preferredCrop,
          targetPlantingPeriod,
        },
      },
      metadata: eligibility.metadata,
      missingInfo: eligibility.missingInfo,
      crops: eligibility.crops,
      satelliteContext,
      aiExplanation,
      citations: {
        cropCalendars: "BAMIS (Bangladesh Agrometeorological Information System) / DAE / BRRI / BARI",
        satellite: "NASA SMAP (Soil Moisture Active Passive) 9km & NASA MODIS Terra (MOD13Q1) 250m 16-Day NDVI",
        disclaimer:
          language === "en"
            ? "Agricultural recommendations are based on official crop calendars and regional satellite proxies. Field conditions vary. Please consult your local Upazila Agriculture Officer (DAE) before making significant farm investments."
            : "কৃষি পরামর্শগুলো সরকারি ফসল পঞ্জিকা এবং নাসা আঞ্চলিক স্যাটেলাইট প্রক্সির ওপর ভিত্তি করে প্রস্তুত। মাঠপর্যায়ের ভিন্নতা থাকতে পারে। চূড়ান্ত সিদ্ধান্ত ও সার ব্যবস্থাপনার জন্য আপনার নিকটস্থ উপজেলা কৃষি কর্মকর্তা (উপসহকারী কৃষি কর্মকর্তা)-র পরামর্শ নিন।",
      },
    };

    return successResponse(res, 200, payload);
  } catch (err) {
    return next(err);
  }
}
