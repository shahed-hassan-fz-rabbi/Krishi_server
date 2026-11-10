/**
 * Farm Management Controller.
 * Handles farm creation, listing, detail retrieval, updates, and deletion.
 * Enforces strict user-level ownership isolation and agricultural dataset grounding.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

import { Farm } from "../models/farm.model.js";
import { FarmActivity } from "../models/farmactivity.model.js";
import { SmapObservation } from "../models/smapobservation.model.js";
import { ModisObservation } from "../models/modisobservation.model.js";
import { validateCreateFarmInput, validateUpdateFarmInput } from "../validators/farm.validator.js";
import { errorResponse, successResponse } from "../utils/response.js";
import { DISTRICTS } from "../config/climate.config.js";
import { snapshotService } from "../services/snapshot.service.js";
import { generateFarmLifecycleTimeline } from "../services/croplifecycle.service.js";
import { getFarmEnvironmentalIntelligence } from "../services/farmenvironment.service.js";
import { generateActivitiesForFarm } from "../services/farmactivity.service.js";
import { ownedFarmFilter } from "../security/farm-ownership.js";
import { FarmNotificationService } from "../services/farmnotification.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const calendarsPath = path.resolve(__dirname, "../../data/crops/official_crop_calendars.json");

let cachedCalendars = null;
async function syncFarmNotifications(userId) {
  try {
    await FarmNotificationService.syncUserNotifications(userId);
  } catch {
    console.warn("[farm] Notification synchronization failed.");
  }
}

function getOfficialCropCalendars() {
  if (cachedCalendars) return cachedCalendars;
  if (fs.existsSync(calendarsPath)) {
    cachedCalendars = JSON.parse(fs.readFileSync(calendarsPath, "utf-8"));
    return cachedCalendars;
  }
  return { crops: [] };
}

function resolveCropInfo(cropCode) {
  const data = getOfficialCropCalendars();
  const found = data.crops.find((c) => c.cropId.toLowerCase() === cropCode.toLowerCase());
  if (found) {
    return {
      cropCode: found.cropId,
      cropNameEn: found.nameEn,
      cropNameBn: found.nameBn,
      scientificName: found.scientificName,
      season: found.season,
      seasonBn: found.seasonBn,
      typicalVarieties: found.typicalVarieties,
    };
  }
  return null;
}

/**
 * POST /api/v1/farms
 * Creates a new farm belonging to the authenticated user.
 */
export async function createFarm(req, res, next) {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 401, "Authentication required to create a farm", "UNAUTHORIZED");
    }

    const validation = validateCreateFarmInput(req.body);
    if (!validation.isValid) {
      return errorResponse(res, 400, "Validation failed", "VALIDATION_ERROR", validation.errors);
    }

    const { location, land, soil, water, crop, notes } = req.body;
    const farmName = (req.body.farmName || req.body.name || "").trim();
    const lowerDistrictCode = location.districtCode.trim().toLowerCase();
    const districtObj = DISTRICTS.find((d) => d.code === lowerDistrictCode);
    const districtName = districtObj ? districtObj.nameEn : "Cumilla";

    const cropMeta = resolveCropInfo(crop.cropCode);
    const cropName = cropMeta ? cropMeta.cropNameEn : crop.cropName || crop.cropCode;
    const season = cropMeta ? cropMeta.season : crop.season || "";

    const farmDoc = new Farm({
      userId,
      farmName: farmName.trim(),
      location: {
        district: districtName,
        districtCode: lowerDistrictCode,
        upazila: location.upazila.trim(),
        village: (location.village || "").trim(),
      },
      land: {
        area: Number(land.area),
        unit: (land.unit || "decimal").trim().toLowerCase(),
        landType: land.landType || "unspecified",
      },
      soil: {
        type: soil?.type || "unknown",
        drainage: soil?.drainage || "unknown",
      },
      water: {
        irrigationAvailability: water?.irrigationAvailability || "available",
        waterSource: (water?.waterSource || "").trim(),
      },
      crop: {
        cropCode: crop.cropCode.trim().toLowerCase(),
        cropName,
        season,
        variety: (crop.variety || "").trim(),
        cultivationMethod: (crop.cultivationMethod || "transplanting").trim(),
        plantingDate: crop.plantingDate.trim(),
        currentStage: (crop.currentStage || "field_preparation").trim(),
      },
      notes: (notes || "").trim(),
      status: "active",
    });

    const savedFarm = await farmDoc.save();

    // Auto-generate initial official activities for the farm
    try {
      await generateActivitiesForFarm(savedFarm._id, userId);
    } catch (actErr) {
      console.warn("[farm] Automatic activity generation warning:", actErr.message);
    }
    await syncFarmNotifications(userId);

    return successResponse(res, 201, savedFarm, {
      message: "Farm created successfully",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/farms
 * Returns all farms created by the authenticated user with summary stats.
 */
export async function listFarms(req, res, next) {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 401, "Authentication required", "UNAUTHORIZED");
    }

    const statusFilter = req.query.status ? { status: req.query.status } : {};
    const farms = await Farm.find({ userId, ...statusFilter })
      .sort({ createdAt: -1 })
      .lean();

    // Compute helpful aggregated summary without fabricating statistics
    let totalAreaDecimal = 0;
    const activeCropsSet = new Set();
    const districtsSet = new Set();

    farms.forEach((f) => {
      // Normalize area to decimal for summary display
      const area = f.land?.area || 0;
      const unit = f.land?.unit || "decimal";
      if (unit === "decimal") totalAreaDecimal += area;
      else if (unit === "acre") totalAreaDecimal += area * 100;
      else if (unit === "hectare") totalAreaDecimal += area * 247.1;
      else if (unit === "bigha") totalAreaDecimal += area * 33;
      else if (unit === "katha") totalAreaDecimal += area * 1.65;
      else totalAreaDecimal += area;

      if (f.crop?.cropName) activeCropsSet.add(f.crop.cropName);
      if (f.location?.district) districtsSet.add(f.location.district);
    });

    const summary = {
      totalFarms: farms.length,
      totalAreaDecimal: Math.round(totalAreaDecimal * 100) / 100,
      uniqueCropsCount: activeCropsSet.size,
      activeCrops: [...activeCropsSet],
      districts: [...districtsSet],
    };

    return successResponse(res, 200, { farms, summary }, { count: farms.length });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/farms/:id
 * Retrieves a single farm, verifying strict user ownership.
 */
export async function getFarmById(req, res, next) {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 401, "Authentication required", "UNAUTHORIZED");
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }

    const ownerFilter = ownedFarmFilter(id, userId);
    const farm = ownerFilter ? await Farm.findOne(ownerFilter).lean() : null;

    // Return 404 for absent and foreign farms to avoid leaking existence.
    if (!farm) {
      return errorResponse(res, 404, "Farm not found", "FARM_NOT_FOUND");
    }

    // Enrich with official crop calendar data
    const calendars = getOfficialCropCalendars();
    const cropDef = calendars.crops.find((c) => c.cropId.toLowerCase() === farm.crop.cropCode.toLowerCase());
    const districtCal = cropDef?.districts?.[farm.location.districtCode] || null;

    // Retrieve environmental satellite context for the farm's district
    let latestSmap = null;
    let latestModis = null;

    if (snapshotService.isDbConnected()) {
      try {
        latestSmap = await SmapObservation.findOne({ districtCode: farm.location.districtCode })
          .sort({ dateLabel: -1 })
          .lean();
        latestModis = await ModisObservation.findOne({ districtCode: farm.location.districtCode })
          .sort({ dateLabel: -1 })
          .lean();
      } catch {
        // Fallback to snapshot
      }
    }

    if (!latestSmap) {
      latestSmap = snapshotService.getSmapSnapshot(farm.location.districtCode)?.latest || null;
    }
    if (!latestModis) {
      latestModis = snapshotService.getModisSnapshot(farm.location.districtCode)?.latest || null;
    }

    const enriched = {
      ...farm,
      officialCropTemplate: districtCal
        ? {
            cropId: cropDef.cropId,
            nameEn: cropDef.nameEn,
            nameBn: cropDef.nameBn,
            season: cropDef.season,
            totalDurationDays: districtCal.totalDurationDays,
            sowingPeriod: districtCal.sowingPeriod,
            transplantingPeriod: districtCal.transplantingPeriod,
            harvestingPeriod: districtCal.harvestingPeriod,
            sourcePublisher: districtCal.sourcePublisher,
            stages: districtCal.stages,
          }
        : null,
      environmentalContext: {
        districtCode: farm.location.districtCode,
        soilMoisture: latestSmap
          ? {
              value: latestSmap.soilMoisture,
              unit: latestSmap.unit || "m³/m³",
              date: latestSmap.dateLabel,
              quality: latestSmap.qualityClassification || "recommended",
              source: "NASA SMAP (Top 0-5 cm soil proxy)",
            }
          : null,
        vegetationHealth: latestModis
          ? {
              ndvi: latestModis.ndvi,
              evi: latestModis.evi,
              date: latestModis.dateLabel,
              quality: latestModis.qualityClassification || "good_data",
              source: "NASA MODIS 250m Canopy Greenness",
            }
          : null,
      },
    };

    return successResponse(res, 200, enriched);
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/v1/farms/:id
 * Updates an existing farm document. Strict ownership check.
 */
export async function updateFarm(req, res, next) {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 401, "Authentication required", "UNAUTHORIZED");
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }

    const ownerFilter = ownedFarmFilter(id, userId);
    const farm = ownerFilter ? await Farm.findOne(ownerFilter) : null;
    if (!farm) {
      return errorResponse(res, 404, "Farm not found", "FARM_NOT_FOUND");
    }

    const validation = validateUpdateFarmInput(req.body);
    if (!validation.isValid) {
      return errorResponse(res, 400, "Validation failed", "VALIDATION_ERROR", validation.errors);
    }

    const b = req.body;

    if (b.farmName !== undefined) farm.farmName = String(b.farmName).trim();
    if (b.notes !== undefined) farm.notes = String(b.notes).trim();
    if (b.status !== undefined) farm.status = b.status;

    if (b.location) {
      if (b.location.districtCode) {
        farm.location.districtCode = b.location.districtCode.toLowerCase();
        const dObj = DISTRICTS.find((d) => d.code === farm.location.districtCode);
        farm.location.district = dObj ? dObj.nameEn : farm.location.district;
      }
      if (b.location.upazila) farm.location.upazila = String(b.location.upazila).trim();
      if (b.location.village !== undefined) farm.location.village = String(b.location.village).trim();
    }

    if (b.land) {
      if (b.land.area !== undefined) farm.land.area = Number(b.land.area);
      if (b.land.unit) farm.land.unit = b.land.unit.toLowerCase();
      if (b.land.landType) farm.land.landType = b.land.landType;
    }

    if (b.soil) {
      if (b.soil.type) farm.soil.type = b.soil.type;
      if (b.soil.drainage) farm.soil.drainage = b.soil.drainage;
    }

    if (b.water) {
      if (b.water.irrigationAvailability) farm.water.irrigationAvailability = b.water.irrigationAvailability;
      if (b.water.waterSource !== undefined) farm.water.waterSource = String(b.water.waterSource).trim();
    }

    if (b.crop) {
      if (b.crop.cropCode) {
        farm.crop.cropCode = b.crop.cropCode.toLowerCase();
        const cropMeta = resolveCropInfo(farm.crop.cropCode);
        if (cropMeta) {
          farm.crop.cropName = cropMeta.cropNameEn;
          farm.crop.season = cropMeta.season;
        }
      }
      if (b.crop.cropName) farm.crop.cropName = String(b.crop.cropName).trim();
      if (b.crop.variety !== undefined) farm.crop.variety = String(b.crop.variety).trim();
      if (b.crop.cultivationMethod !== undefined) farm.crop.cultivationMethod = String(b.crop.cultivationMethod).trim();
      if (b.crop.plantingDate) farm.crop.plantingDate = String(b.crop.plantingDate).trim();
      if (b.crop.currentStage !== undefined) farm.crop.currentStage = String(b.crop.currentStage).trim();
    }

    const updated = await farm.save();

    return successResponse(res, 200, updated, { message: "Farm updated successfully" });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/v1/farms/:id
 * Deletes a farm belonging to the authenticated user.
 */
export async function deleteFarm(req, res, next) {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 401, "Authentication required", "UNAUTHORIZED");
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }

    const ownerFilter = ownedFarmFilter(id, userId);
    const farm = ownerFilter ? await Farm.findOne(ownerFilter) : null;
    if (!farm) {
      return errorResponse(res, 404, "Farm not found", "FARM_NOT_FOUND");
    }

    await Farm.deleteOne(ownerFilter);
    // Cascade delete associated activities
    await FarmActivity.deleteMany({ farmId: id, userId });

    return successResponse(
      res,
      200,
      { deletedId: id },
      { message: `Farm '${farm.farmName}' deleted successfully` }
    );
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/farms/:id/lifecycle
 * Generates and returns structured crop lifecycle stages for this farm.
 * Enforces strict user ownership.
 */
export async function getFarmLifecycle(req, res, next) {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 401, "Authentication required", "UNAUTHORIZED");
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }

    const ownerFilter = ownedFarmFilter(id, userId);
    const farm = ownerFilter ? await Farm.findOne(ownerFilter).lean() : null;
    if (!farm) {
      return errorResponse(res, 404, "Farm not found", "FARM_NOT_FOUND");
    }

    const asOfDate = req.query.asOfDate ? String(req.query.asOfDate).trim() : undefined;
    const timelineResult = generateFarmLifecycleTimeline(farm, { asOfDate });

    if (!timelineResult.success) {
      return errorResponse(res, 400, timelineResult.error, "LIFECYCLE_GENERATION_FAILED");
    }

    return successResponse(res, 200, timelineResult.data);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/farms/:id/lifecycle/refresh
 * Re-evaluates lifecycle timeline and updates currentStage on the farm document.
 */
export async function refreshFarmLifecycle(req, res, next) {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 401, "Authentication required", "UNAUTHORIZED");
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }

    const ownerFilter = ownedFarmFilter(id, userId);
    const farm = ownerFilter ? await Farm.findOne(ownerFilter) : null;
    if (!farm) {
      return errorResponse(res, 404, "Farm not found", "FARM_NOT_FOUND");
    }

    const timelineResult = generateFarmLifecycleTimeline(farm.toObject());
    if (!timelineResult.success) {
      return errorResponse(res, 400, timelineResult.error, "LIFECYCLE_GENERATION_FAILED");
    }

    // Sync newly determined currentStage back into farm record
    const currentStageCode = timelineResult.data.timelineOverview?.currentStage?.stageCode;
    if (currentStageCode && farm.crop.currentStage !== currentStageCode) {
      farm.crop.currentStage = currentStageCode;
      await farm.save();
    }

    await syncFarmNotifications(userId);

    return successResponse(res, 200, timelineResult.data, {
      message: "Farm lifecycle timeline refreshed successfully",
      syncedStage: currentStageCode || null,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/farms/:id/environment
 * Retrieves NASA Environmental Intelligence (POWER, SMAP, MODIS, Deterministic Summary, Lifecycle integration)
 * for the authenticated farm owner.
 */
export async function getFarmEnvironment(req, res, next) {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 401, "Authentication required", "UNAUTHORIZED");
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }

    const ownerFilter = ownedFarmFilter(id, userId);
    const farm = ownerFilter ? await Farm.findOne(ownerFilter).lean() : null;
    if (!farm) {
      return errorResponse(res, 404, "Farm not found", "FARM_NOT_FOUND");
    }

    const intel = await getFarmEnvironmentalIntelligence(farm);
    return successResponse(res, 200, intel);
  } catch (error) {
    next(error);
  }
}

