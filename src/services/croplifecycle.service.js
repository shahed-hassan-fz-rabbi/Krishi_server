/**
 * Reusable Crop Lifecycle Template Engine Service.
 * Converts verified BAMIS / DAE / BRRI / BARI crop calendars into structured,
 * farm-specific lifecycle stages and estimated phenological timelines.
 *
 * Scientific Safeguards:
 * - Stage names, durations, standard meteorological weeks, and weather hazards
 *   derive strictly from official published crop calendars.
 * - Project-calculated calendar projections are clearly marked as estimates.
 * - No fabricated fertilizer dosages or speculative pesticide volumes.
 */
import { getBangladeshDateKey } from "../utils/bangladesh-date.js";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const calendarsPath = path.resolve(__dirname, "../../data/crops/official_crop_calendars.json");

let cachedCalendars = null;

export function loadOfficialCropCalendars() {
  if (cachedCalendars) return cachedCalendars;
  if (!fs.existsSync(calendarsPath)) {
    throw new Error(`Official crop calendars file not found at ${calendarsPath}`);
  }
  const raw = fs.readFileSync(calendarsPath, "utf-8");
  cachedCalendars = JSON.parse(raw);
  return cachedCalendars;
}

/**
 * Validates whether a crop and district pair is supported in the official dataset.
 */
export function validateCropAndDistrict(cropCode, districtCode) {
  if (!cropCode || !districtCode) {
    return {
      isValid: false,
      error: "Both cropCode and districtCode are required.",
    };
  }
  const data = loadOfficialCropCalendars();
  const lowerCrop = cropCode.trim().toLowerCase();
  const lowerDistrict = districtCode.trim().toLowerCase();

  const crop = data.crops.find((c) => c.cropId.toLowerCase() === lowerCrop);
  if (!crop) {
    return {
      isValid: false,
      error: `Crop '${cropCode}' is not supported in the official crop calendar. Supported crops: ${data.crops.map((c) => c.cropId).join(", ")}.`,
    };
  }

  const districtCal = crop.districts[lowerDistrict];
  if (!districtCal) {
    return {
      isValid: false,
      error: `District '${districtCode}' has no verified crop calendar for '${crop.nameEn}'. Supported districts for this crop: ${Object.keys(crop.districts).join(", ")}.`,
    };
  }

  return {
    isValid: true,
    crop,
    districtCal,
  };
}

/**
 * Returns structured template definition for a specific crop and district.
 */
export function getCropLifecycleTemplate(cropCode, districtCode) {
  const check = validateCropAndDistrict(cropCode, districtCode);
  if (!check.isValid) {
    return {
      success: false,
      error: check.error,
    };
  }

  const { crop, districtCal } = check;

  const stages = districtCal.stages.map((stg, index) => ({
    stageIndex: index,
    stageNumber: index + 1,
    stageCode: stg.stageId,
    stageNameEn: stg.stageNameEn,
    stageNameBn: stg.stageNameBn,
    standardWeeks: stg.standardWeeks,
    durationDays: stg.durationDays,
    waterRequirementMm: stg.waterRequirementMm,
    optimalTempRange: stg.optimalTempRange,
    minimumTempC: stg.minimumTempC,
    maximumTempC: stg.maximumTempC,
    weatherHazards: stg.weatherHazards,
    waterGuidance: {
      requirementMm: stg.waterRequirementMm,
      unit: "mm per stage",
      status: "source_grounded",
      source: "BAMIS Agro-Meteorological Crop Calendar",
    },
    nutrientGuidance: {
      status: "unavailable_in_source",
      advisory: "Official fertilizer and top-dressing dosages are determined by local soil test kits and DAE upazila soil fertility guides. Regional calendars omit chemical dosage numbers to prevent unbalanced application.",
    },
    monitoringGuidance: stg.weatherHazards || null,
    sourceReferences: {
      documentTitle: districtCal.sourceDocumentTitle,
      publisher: districtCal.sourcePublisher,
      documentUrl: districtCal.sourceDocumentUrl,
    },
  }));

  const template = {
    templateId: `${crop.cropId}_${districtCal.districtCode}`,
    cropCode: crop.cropId,
    cropNameEn: crop.nameEn,
    cropNameBn: crop.nameBn,
    scientificName: crop.scientificName,
    season: crop.season,
    seasonBn: crop.seasonBn,
    typicalVarieties: crop.typicalVarieties,
    districtCode: districtCal.districtCode,
    districtName: districtCal.districtName,
    daeRegion: districtCal.daeRegion,
    totalDurationDays: districtCal.totalDurationDays,
    sowingPeriod: districtCal.sowingPeriod,
    transplantingPeriod: districtCal.transplantingPeriod,
    harvestingPeriod: districtCal.harvestingPeriod,
    waterRequirementMmTotal: districtCal.waterRequirementMmTotal,
    standardWeeksRange: districtCal.standardWeeksRange,
    stages,
    sourceReferences: {
      title: districtCal.sourceDocumentTitle,
      publisher: districtCal.sourcePublisher,
      url: districtCal.sourceDocumentUrl,
      daeRegion: districtCal.daeRegion,
    },
    templateVersion: "1.0.0-bamis",
    updatedAt: "2024-01-01",
  };

  return {
    success: true,
    data: template,
  };
}

/**
 * Returns summary list of all supported crop lifecycle templates.
 */
export function listSupportedTemplates() {
  const data = loadOfficialCropCalendars();
  const templates = [];

  for (const crop of data.crops) {
    for (const [districtCode, districtCal] of Object.entries(crop.districts)) {
      templates.push({
        templateId: `${crop.cropId}_${districtCode}`,
        cropCode: crop.cropId,
        cropNameEn: crop.nameEn,
        cropNameBn: crop.nameBn,
        scientificName: crop.scientificName,
        season: crop.season,
        seasonBn: crop.seasonBn,
        districtCode,
        districtName: districtCal.districtName,
        totalDurationDays: districtCal.totalDurationDays,
        stageCount: districtCal.stages.length,
        sourcePublisher: districtCal.sourcePublisher,
      });
    }
  }

  return templates;
}

/**
 * Pure date addition helper using UTC midnight to prevent timezone offsets.
 */
function addDaysUtc(isoDateStr, daysToAdd) {
  const [y, m, d] = isoDateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  return date.toISOString().split("T")[0];
}

/**
 * Calculates day difference in UTC.
 */
function diffDaysUtc(isoDateA, isoDateB) {
  const [y1, m1, d1] = isoDateA.split("-").map(Number);
  const [y2, m2, d2] = isoDateB.split("-").map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.floor((t1 - t2) / (24 * 3600 * 1000));
}

/**
 * Generates structured farm lifecycle timeline from farm profile and official template.
 *
 * @param {Object} farm - Farm object containing location, crop, plantingDate
 * @param {Object} options - { asOfDate: 'YYYY-MM-DD' }
 */
export function generateFarmLifecycleTimeline(farm, options = {}) {
  const cropCode = farm.crop?.cropCode;
  const districtCode = farm.location?.districtCode;

  const templateResult = getCropLifecycleTemplate(cropCode, districtCode);
  if (!templateResult.success) {
    return {
      success: false,
      error: templateResult.error,
    };
  }

  const template = templateResult.data;
  const plantingDate = farm.crop?.plantingDate ? String(farm.crop.plantingDate).trim() : null;
  const isValidPlantingDate = Boolean(plantingDate && /^\d{4}-\d{2}-\d{2}$/.test(plantingDate));

  const asOfDate = options.asOfDate || getBangladeshDateKey();

  // Calculate day offsets
  let daysSincePlanting = null;
  if (isValidPlantingDate) {
    // Day 1 is the day of planting
    daysSincePlanting = diffDaysUtc(asOfDate, plantingDate) + 1;
  }

  let cumulativeDays = 0;
  let currentStageObj = null;
  let nextStageObj = null;

  const timelineStages = template.stages.map((stg) => {
    const startDay = cumulativeDays + 1;
    const endDay = cumulativeDays + stg.durationDays;
    cumulativeDays = endDay;

    let estimatedStartDate = null;
    let estimatedEndDate = null;
    let stageStatus = "unknown";
    let isCurrent = false;
    let isCompleted = false;
    let isUpcoming = false;

    if (isValidPlantingDate) {
      estimatedStartDate = addDaysUtc(plantingDate, startDay - 1);
      estimatedEndDate = addDaysUtc(plantingDate, endDay - 1);

      if (daysSincePlanting <= 0) {
        // Planting is scheduled for the future
        stageStatus = "upcoming";
        isUpcoming = true;
      } else if (daysSincePlanting >= startDay && daysSincePlanting <= endDay) {
        stageStatus = "current";
        isCurrent = true;
      } else if (daysSincePlanting > endDay) {
        stageStatus = "completed";
        isCompleted = true;
      } else {
        stageStatus = "upcoming";
        isUpcoming = true;
      }
    }

    const stageTimelineItem = {
      ...stg,
      startDay,
      endDay,
      estimatedStartDate,
      estimatedEndDate,
      status: stageStatus,
      isCurrent,
      isCompleted,
      isUpcoming,
      isProjectEstimate: true,
    };

    if (isCurrent && !currentStageObj) {
      currentStageObj = stageTimelineItem;
    }

    if (isUpcoming && !nextStageObj && (!currentStageObj || currentStageObj.stageCode !== stg.stageCode)) {
      nextStageObj = stageTimelineItem;
    }

    return stageTimelineItem;
  });

  // If past all stages
  const isLifecycleCompleted = isValidPlantingDate && daysSincePlanting > template.totalDurationDays;
  const isLifecyclePending = isValidPlantingDate && daysSincePlanting <= 0;

  let overallStatus = "active";
  if (isLifecycleCompleted) {
    overallStatus = "harvest_ready_or_completed";
  } else if (isLifecyclePending) {
    overallStatus = "planting_scheduled";
  }

  return {
    success: true,
    data: {
      farmId: farm._id || farm.id || null,
      farmName: farm.farmName,
      location: {
        district: template.districtName,
        districtCode: template.districtCode,
        upazila: farm.location?.upazila || "",
        village: farm.location?.village || "",
      },
      crop: {
        cropCode: template.cropCode,
        cropNameEn: template.cropNameEn,
        cropNameBn: template.cropNameBn,
        scientificName: template.scientificName,
        variety: farm.crop?.variety || "Standard Variety",
        season: template.season,
        seasonBn: template.seasonBn,
        cultivationMethod: farm.crop?.cultivationMethod || "Standard",
        plantingDate,
        isValidPlantingDate,
      },
      timelineOverview: {
        asOfDate,
        daysSincePlanting,
        totalDurationDays: template.totalDurationDays,
        overallStatus,
        isCompleted: isLifecycleCompleted,
        isPending: isLifecyclePending,
        currentStage: currentStageObj
          ? {
              stageCode: currentStageObj.stageCode,
              stageNameEn: currentStageObj.stageNameEn,
              stageNameBn: currentStageObj.stageNameBn,
              stageNumber: currentStageObj.stageNumber,
              startDay: currentStageObj.startDay,
              endDay: currentStageObj.endDay,
              estimatedStartDate: currentStageObj.estimatedStartDate,
              estimatedEndDate: currentStageObj.estimatedEndDate,
              dayInStage: daysSincePlanting ? daysSincePlanting - currentStageObj.startDay + 1 : null,
              durationDays: currentStageObj.durationDays,
              weatherHazards: currentStageObj.weatherHazards,
            }
          : null,
        nextStage: nextStageObj
          ? {
              stageCode: nextStageObj.stageCode,
              stageNameEn: nextStageObj.stageNameEn,
              stageNameBn: nextStageObj.stageNameBn,
              stageNumber: nextStageObj.stageNumber,
              estimatedStartDate: nextStageObj.estimatedStartDate,
              daysUntilStart: nextStageObj.estimatedStartDate
                ? Math.max(0, diffDaysUtc(nextStageObj.estimatedStartDate, asOfDate))
                : null,
            }
          : null,
      },
      stages: timelineStages,
      provenance: {
        sourceAuthority: "Bangladesh Agro-Meteorological Information Service (BAMIS) / DAE",
        sourceDocumentTitle: template.sourceReferences.title,
        sourcePublisher: template.sourceReferences.publisher,
        sourceDocumentUrl: template.sourceReferences.url,
        daeRegion: template.sourceReferences.daeRegion,
        isProjectEstimate: true,
        estimateDisclaimer:
          "Estimated calendar dates are calculations projected from the farmer's recorded planting date and BAMIS regional stage durations. Actual field progress depends on cultivar, temperatures, and moisture.",
        unsupportedFields: [
          "nutrientDosage",
          "chemicalPesticideVolumes",
        ],
      },
    },
  };
}
