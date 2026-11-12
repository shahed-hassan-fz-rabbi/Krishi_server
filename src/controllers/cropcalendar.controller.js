/**
 * Official Bangladesh Crop Calendar Controller.
 * Delivers source-backed crop phenology and weather advisories
 * from BAMIS / DAE / BRRI / BARI.
 *
 * Strictly Read-Only:
 * - Reads official calendars from server/data/crops/official_crop_calendars.json.
 * - Reads existing SMAP & MODIS observations without database modification.
 * - Zero database writes.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SmapObservation } from "../models/smapobservation.model.js";
import { ModisObservation } from "../models/modisobservation.model.js";
import { MODIS } from "../config/modis.config.js";
import { SMAP } from "../config/smap.config.js";
import { findLatestGoodModisObservation, findLatestMarginalModisObservation } from "../services/nasa/modis.quality.js";
import { errorResponse, successResponse } from "../utils/response.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const calendarsPath = path.resolve(__dirname, "../../data/crops/official_crop_calendars.json");

let cachedCalendars = null;

function loadCropCalendars() {
  if (cachedCalendars) return cachedCalendars;
  if (!fs.existsSync(calendarsPath)) {
    throw new Error(`Crop calendars file missing at ${calendarsPath}`);
  }
  const raw = fs.readFileSync(calendarsPath, "utf-8");
  cachedCalendars = JSON.parse(raw);
  return cachedCalendars;
}

/**
 * Calculates current Standard Meteorological Week (1 to 52).
 */
function getStandardMeteorologicalWeek(date = new Date()) {
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const diffDays = Math.floor((date - startOfYear) / (24 * 3600 * 1000));
  return Math.min(52, Math.floor(diffDays / 7) + 1);
}

/**
 * Checks if a target week falls within a week range (supports wrap-around over year-end).
 */
function isWeekInRange(targetWeek, [startWeek, endWeek]) {
  if (startWeek <= endWeek) {
    return targetWeek >= startWeek && targetWeek <= endWeek;
  }
  // Wrap-around (e.g. 44 to 18 for Boro)
  return targetWeek >= startWeek || targetWeek <= endWeek;
}

/**
 * GET /api/v1/crop-calendar
 * Query params: ?district=cumilla&crop=monsoon_aman&season=Kharif-2
 */
export async function getCropCalendars(req, res, next) {
  try {
    const data = loadCropCalendars();
    const districtQuery = req.query.district ? req.query.district.trim().toLowerCase() : null;
    const cropQuery = req.query.crop ? req.query.crop.trim().toLowerCase() : null;
    const seasonQuery = req.query.season ? req.query.season.trim() : null;

    if (districtQuery && !data.metadata.districts.includes(districtQuery)) {
      return errorResponse(
        res,
        400,
        `District '${districtQuery}' is not supported. Supported: ${data.metadata.districts.join(", ")}`,
        "INVALID_DISTRICT"
      );
    }

    let results = [];

    for (const crop of data.crops) {
      if (cropQuery && crop.cropId.toLowerCase() !== cropQuery) {
        continue;
      }
      if (seasonQuery && crop.season.toLowerCase() !== seasonQuery.toLowerCase()) {
        continue;
      }

      if (districtQuery) {
        const distData = crop.districts[districtQuery];
        if (distData) {
          results.push({
            cropId: crop.cropId,
            nameEn: crop.nameEn,
            nameBn: crop.nameBn,
            scientificName: crop.scientificName,
            season: crop.season,
            seasonBn: crop.seasonBn,
            typicalVarieties: crop.typicalVarieties,
            districtCalendar: distData,
          });
        }
      } else {
        // Return for all supported districts
        results.push({
          cropId: crop.cropId,
          nameEn: crop.nameEn,
          nameBn: crop.nameBn,
          scientificName: crop.scientificName,
          season: crop.season,
          seasonBn: crop.seasonBn,
          typicalVarieties: crop.typicalVarieties,
          districtCalendars: crop.districts,
        });
      }
    }

    if (results.length === 0) {
      return errorResponse(
        res,
        404,
        "No official crop calendar entries found matching the specified criteria.",
        "CALENDAR_NOT_FOUND"
      );
    }

    return successResponse(res, 200, results, {
      authority: data.metadata.authority,
      ministry: data.metadata.ministry,
      version: data.metadata.version,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/crop-calendar/crops
 * Returns list of supported crops with seasons and variety metadata.
 */
export async function getCropList(req, res, next) {
  try {
    const data = loadCropCalendars();
    const list = data.crops.map((c) => ({
      cropId: c.cropId,
      nameEn: c.nameEn,
      nameBn: c.nameBn,
      scientificName: c.scientificName,
      season: c.season,
      seasonBn: c.seasonBn,
      typicalVarieties: c.typicalVarieties,
      supportedDistricts: Object.keys(c.districts),
    }));

    return successResponse(res, 200, list, {
      totalCrops: list.length,
      authority: data.metadata.authority,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/crop-calendar/alignment?district=cumilla&crop=monsoon_aman
 * Connects official BAMIS phenological stages with actual NASA satellite indicators.
 */
export async function getCropCalendarAlignment(req, res, next) {
  try {
    const data = loadCropCalendars();
    const districtCode = (req.query.district || "cumilla").trim().toLowerCase();
    const cropId = (req.query.crop || "monsoon_aman").trim().toLowerCase();

    if (!data.metadata.districts.includes(districtCode)) {
      return errorResponse(
        res,
        400,
        `District '${districtCode}' is not supported. Supported: ${data.metadata.districts.join(", ")}`,
        "INVALID_DISTRICT"
      );
    }

    const crop = data.crops.find((c) => c.cropId.toLowerCase() === cropId);
    if (!crop) {
      return errorResponse(
        res,
        400,
        `Crop '${cropId}' is not supported. Supported: ${data.crops.map((c) => c.cropId).join(", ")}`,
        "INVALID_CROP"
      );
    }

    const districtCalendar = crop.districts[districtCode];
    if (!districtCalendar) {
      return errorResponse(
        res,
        404,
        `Official calendar not found for crop '${cropId}' in district '${districtCode}'`,
        "CALENDAR_NOT_FOUND"
      );
    }

    // Determine current phenological stage based on current Standard Week
    const currentWeek = getStandardMeteorologicalWeek();
    let currentStage = null;
    let nextStage = null;

    for (let i = 0; i < districtCalendar.stages.length; i++) {
      const stage = districtCalendar.stages[i];
      if (isWeekInRange(currentWeek, stage.standardWeeks)) {
        currentStage = stage;
        nextStage = districtCalendar.stages[i + 1] || null;
        break;
      }
    }

    // If outside main season, flag as off-season
    const isSeasonActive = isWeekInRange(currentWeek, districtCalendar.standardWeeksRange);

    // Retrieve latest SMAP observation from MongoDB
    const latestSmap = await SmapObservation.findOne({
      districtCode,
      datasetKey: SMAP.datasetKey,
      retrievalQualityFlag: { $in: [0, 8] },
      isRecommendedQuality: true,
      qualityClassification: "recommended",
      soilMoisture: { $type: "number", $gte: SMAP.minValid, $lte: SMAP.maxValid },
    })
      .sort({ dateLabel: -1 })
      .lean();

    // Only rank-0, in-range MODIS data is eligible for the primary observation.
    const latestModis = await findLatestGoodModisObservation(ModisObservation, districtCode);
    const latestMarginalModis = latestModis ? null : await findLatestMarginalModisObservation(ModisObservation, districtCode);

    const alignment = {
      districtCode,
      cropId,
      cropNameEn: crop.nameEn,
      cropNameBn: crop.nameBn,
      season: crop.season,
      seasonBn: crop.seasonBn,
      currentStandardWeek: currentWeek,
      isSeasonActive,
      officialCalendar: {
        totalDurationDays: districtCalendar.totalDurationDays,
        sowingPeriod: districtCalendar.sowingPeriod,
        transplantingPeriod: districtCalendar.transplantingPeriod,
        harvestingPeriod: districtCalendar.harvestingPeriod,
        waterRequirementMmTotal: districtCalendar.waterRequirementMmTotal,
        sourcePublisher: districtCalendar.sourcePublisher,
        sourceDocumentTitle: districtCalendar.sourceDocumentTitle,
        sourceDocumentUrl: districtCalendar.sourceDocumentUrl,
        daeRegion: districtCalendar.daeRegion,
        allStages: districtCalendar.stages,
        currentStage: currentStage || {
          stageId: "off_season",
          stageNameEn: "Inter-Season / Field Fallow",
          stageNameBn: "মৌসুম বহির্ভূত / জমি তৈরি",
          description: `Current week (${currentWeek}) is outside the active growing window for ${crop.nameEn}.`,
        },
        nextStage,
      },
      satelliteContext: {
        soilMoisture: latestSmap
          ? {
              value: latestSmap.soilMoisture,
              unit: latestSmap.unit,
              date: latestSmap.dateLabel,
              quality: latestSmap.qualityClassification,
              isRecommended: latestSmap.isRecommendedQuality,
              source: "NASA SMAP SPL3SMP_E V006 (9 km posting)",
            }
          : null,
        vegetationIndex: latestModis
          ? {
              available: true,
              ndvi: latestModis.ndvi,
              evi: latestModis.evi,
              date: latestModis.dateLabel,
              quality: latestModis.qualityClassification,
              isReliable: latestModis.isReliableQuality,
              source: `NASA ${MODIS.productName} (250m)`,
            }
          : latestMarginalModis
            ? {
                available: false,
                ndvi: null,
                evi: null,
                date: latestMarginalModis.dateLabel || null,
                quality: latestMarginalModis.qualityClassification,
                pixelReliability: latestMarginalModis.pixelReliability,
                isReliable: false,
                source: `NASA ${MODIS.productName} (250m)`,
              }
            : null,
      },
      scientificDisclosure:
        "Official agronomic recommendations are published by BAMIS / DAE / BRRI / BARI. " +
        "Satellite observations (SMAP, MODIS, POWER) provide physical environmental context across 250m to 9km grid scales. " +
        "They do NOT replace extension advisory or direct farm-level soil testing.",
    };

    return successResponse(res, 200, alignment, {
      authority: data.metadata.authority,
      version: data.metadata.version,
    });
  } catch (error) {
    next(error);
  }
}
