/**
 * Farm Validator.
 * Enforces field validations, allowable enums, and district/crop integrity
 * before database persistence.
 */

import { DISTRICTS } from "../config/climate.config.js";
import { getUpazilasForDistrict } from "../config/upazilas.config.js";

const VALID_DISTRICT_CODES = new Set(DISTRICTS.map((d) => d.code));
const VALID_CROP_CODES = new Set(["monsoon_aman", "boro_rice", "aus_rice", "mustard"]);
const VALID_LAND_UNITS = new Set(["decimal", "acre", "hectare", "bigha", "katha"]);
const VALID_LAND_TYPES = new Set(["high", "medium_high", "medium_low", "low", "unspecified"]);
const VALID_SOIL_TYPES = new Set(["clay", "loam", "clay_loam", "sandy_loam", "sandy", "silt", "alluvial", "other", "unknown"]);
const VALID_DRAINAGE = new Set(["good", "moderate", "poor", "waterlogged", "unknown"]);
const VALID_IRRIGATION = new Set(["available", "limited", "unavailable"]);

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates manual farm creation payload.
 */
export function validateCreateFarmInput(body = {}) {
  const errors = [];

  // 1. Farm Name
  const farmName = (body.farmName || body.name || "").trim();
  if (!farmName) {
    errors.push({ field: "farmName", message: "Farm name is required." });
  } else if (farmName.length < 2) {
    errors.push({ field: "farmName", message: "Farm name must be at least 2 characters long." });
  } else if (farmName.length > 100) {
    errors.push({ field: "farmName", message: "Farm name cannot exceed 100 characters." });
  }

  // 2. Location
  const location = body.location || {};
  const districtCode = (location.districtCode || "").trim().toLowerCase();
  if (!districtCode) {
    errors.push({ field: "location.districtCode", message: "District selection is required." });
  } else if (!VALID_DISTRICT_CODES.has(districtCode)) {
    errors.push({
      field: "location.districtCode",
      message: `District '${districtCode}' is not supported. Supported districts: ${[...VALID_DISTRICT_CODES].join(", ")}.`,
    });
  }

  const upazila = (location.upazila || "").trim();
  if (!upazila) {
    errors.push({ field: "location.upazila", message: "Upazila selection or name is required." });
  } else if (VALID_DISTRICT_CODES.has(districtCode)) {
    const validUpazilas = getUpazilasForDistrict(districtCode);
    const matches = validUpazilas.some(
      (u) =>
        u.code.toLowerCase() === upazila.toLowerCase() ||
        u.nameEn.toLowerCase() === upazila.toLowerCase() ||
        u.nameBn === upazila
    );
    if (!matches) {
      errors.push({
        field: "location.upazila",
        message: `Upazila '${upazila}' is not recognized for district '${districtCode}'.`,
      });
    }
  }

  // 3. Land
  const land = body.land || {};
  const area = Number(land.area);
  if (land.area === undefined || land.area === null || isNaN(area)) {
    errors.push({ field: "land.area", message: "Valid land size/area is required." });
  } else if (area <= 0) {
    errors.push({ field: "land.area", message: "Land area must be greater than zero." });
  } else if (area > 100000) {
    errors.push({ field: "land.area", message: "Land area exceeds reasonable bounds." });
  }

  const unit = (land.unit || "decimal").trim().toLowerCase();
  if (!VALID_LAND_UNITS.has(unit)) {
    errors.push({ field: "land.unit", message: `Invalid land measurement unit '${unit}'.` });
  }

  if (land.landType && !VALID_LAND_TYPES.has(land.landType)) {
    errors.push({ field: "land.landType", message: `Invalid land type '${land.landType}'.` });
  }

  // 4. Soil (optional fields)
  const soil = body.soil || {};
  if (soil.type && !VALID_SOIL_TYPES.has(soil.type)) {
    errors.push({ field: "soil.type", message: `Invalid soil type '${soil.type}'.` });
  }
  if (soil.drainage && !VALID_DRAINAGE.has(soil.drainage)) {
    errors.push({ field: "soil.drainage", message: `Invalid drainage condition '${soil.drainage}'.` });
  }

  // 5. Water & Irrigation
  const water = body.water || {};
  const irrigation = (water.irrigationAvailability || "available").trim().toLowerCase();
  if (!VALID_IRRIGATION.has(irrigation)) {
    errors.push({ field: "water.irrigationAvailability", message: `Invalid irrigation availability '${irrigation}'.` });
  }

  // 6. Crop
  const crop = body.crop || {};
  const cropCode = (crop.cropCode || "").trim().toLowerCase();
  if (!cropCode) {
    errors.push({ field: "crop.cropCode", message: "Crop selection is required." });
  } else if (!VALID_CROP_CODES.has(cropCode)) {
    errors.push({
      field: "crop.cropCode",
      message: `Crop '${cropCode}' is not supported in the official crop calendar. Supported crops: ${[...VALID_CROP_CODES].join(", ")}.`,
    });
  }

  const plantingDate = (crop.plantingDate || "").trim();
  if (!plantingDate) {
    errors.push({ field: "crop.plantingDate", message: "Planting / sowing date is required." });
  } else if (!ISO_DATE_REGEX.test(plantingDate)) {
    errors.push({ field: "crop.plantingDate", message: "Planting date must follow ISO YYYY-MM-DD format." });
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validates partial updates to an existing farm.
 */
export function validateUpdateFarmInput(body = {}) {
  const errors = [];

  // Forbid altering ownership
  if ("userId" in body || "_id" in body) {
    errors.push({ field: "userId", message: "Farm ownership cannot be modified." });
  }

  if (body.farmName !== undefined) {
    const farmName = String(body.farmName).trim();
    if (!farmName || farmName.length < 2) {
      errors.push({ field: "farmName", message: "Farm name must be at least 2 characters long." });
    }
  }

  if (body.location?.districtCode !== undefined) {
    const dc = String(body.location.districtCode).trim().toLowerCase();
    if (!VALID_DISTRICT_CODES.has(dc)) {
      errors.push({ field: "location.districtCode", message: `Unsupported district '${dc}'.` });
    }
  }

  if (body.land?.area !== undefined) {
    const a = Number(body.land.area);
    if (isNaN(a) || a <= 0) {
      errors.push({ field: "land.area", message: "Land area must be a positive number." });
    }
  }

  if (body.crop?.cropCode !== undefined) {
    const cc = String(body.crop.cropCode).trim().toLowerCase();
    if (!VALID_CROP_CODES.has(cc)) {
      errors.push({ field: "crop.cropCode", message: `Unsupported crop '${cc}'.` });
    }
  }

  if (body.crop?.plantingDate !== undefined) {
    const pd = String(body.crop.plantingDate).trim();
    if (!ISO_DATE_REGEX.test(pd)) {
      errors.push({ field: "crop.plantingDate", message: "Planting date must follow ISO YYYY-MM-DD format." });
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
