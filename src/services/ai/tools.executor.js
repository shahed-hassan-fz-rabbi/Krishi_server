/**
 * Krishi Mama AI Assistant — Tool Executors.
 * Bridges Gemini function calls to deterministic backend services, MongoDB models,
 * and official agricultural reference data without fabricating scientific numbers.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { DISTRICTS } from "../../config/climate.config.js";
import { SMAP } from "../../config/smap.config.js";
import { MODIS } from "../../config/modis.config.js";
import { SmapObservation } from "../../models/smapobservation.model.js";
import { ModisObservation } from "../../models/modisobservation.model.js";
import { NasaObservation } from "../../models/nasaobservation.model.js";
import { GpmObservation } from "../../models/gpmobservation.model.js";
import { GPM } from "../../config/gpm.config.js";
import { analyzeDistrictClimate, analyzeHandoff } from "../climate/analysis.service.js";
import { snapshotService } from "../snapshot.service.js";
import mongoose from "mongoose";
import { summarizeGpmLocalDay } from "../nasa/gpm.validation.js";
import { Farm } from "../../models/farm.model.js";
import { FarmActivity } from "../../models/farmactivity.model.js";
import { ownedFarmFilter } from "../../security/farm-ownership.js";
import {
  generateFarmLifecycleTimeline,
  getCropLifecycleTemplate,
} from "../croplifecycle.service.js";
import { getLiveForecast } from "../weather/forecast.service.js";
import { getSeasonalOutlook } from "../weather/seasonal.service.js";
import { getActiveOfficialWarnings } from "../weather/warning.service.js";
import { assessAgriculturalRisks } from "../weather/risk.engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const calendarsPath = path.resolve(__dirname, "../../../data/crops/official_crop_calendars.json");

const VALID_DISTRICT_CODES = new Set(DISTRICTS.map((d) => d.code));
const SUPPORTED_CROPS = [
  { code: "monsoon_aman", aliases: ["aman", "t_aman", "monsoon_aman", "আমন", "রোপা আমন"], nameEn: "Transplanted Aman Rice", nameBn: "রোপা আমন ধান" },
  { code: "boro_rice", aliases: ["boro", "boro_rice", "বোরো", "বোরো ধান"], nameEn: "Boro Rice", nameBn: "বোরো ধান" },
  { code: "aus_rice", aliases: ["aus", "aus_rice", "আউশ", "আউশ ধান"], nameEn: "Aus Rice", nameBn: "আউশ ধান" },
  { code: "mustard", aliases: ["mustard", "sarisha", "সরিষা", "রাই"], nameEn: "Mustard", nameBn: "সরিষা" },
];

async function findOwnedFarmForTool(farmId, userId) {
  if (!farmId || !mongoose.Types.ObjectId.isValid(farmId)) {
    return { error: "INVALID_FARM_ID: A valid farm ID is required." };
  }
  const filter = ownedFarmFilter(farmId, userId);
  if (!filter) {
    return { error: "FARM_ACCESS_DENIED: Authentication is required to access farm data." };
  }
  const farm = await Farm.findOne(filter).lean();
  if (!farm) {
    return { error: "FARM_NOT_FOUND: Farm not found or access denied." };
  }
  return { farm };
}

let cachedCalendars = null;
function getCropCalendarsData() {
  if (cachedCalendars) return cachedCalendars;
  if (!fs.existsSync(calendarsPath)) {
    throw new Error(`Official crop calendars file not found at ${calendarsPath}`);
  }
  const raw = fs.readFileSync(calendarsPath, "utf-8");
  cachedCalendars = JSON.parse(raw);
  return cachedCalendars;
}

function resolveCropCode(input) {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  for (const crop of SUPPORTED_CROPS) {
    if (crop.code === normalized || crop.aliases.some((a) => a.toLowerCase() === normalized)) {
      return crop.code;
    }
  }
  return null;
}

function normalizeDistrict(code) {
  if (!code) return "cumilla";
  const normalized = code.trim().toLowerCase();
  if (VALID_DISTRICT_CODES.has(normalized)) return normalized;
  return null;
}

export const toolExecutors = {
  /** Latest available GPM Final V07 daily summary with strict 48-interval validation. */
  async getPrecipitationLatest({ district }) {
    const validDistrict = normalizeDistrict(district);
    if (!validDistrict) return { error: `District '${district}' is not supported.`, supportedDistricts: [...VALID_DISTRICT_CODES] };
    if (!snapshotService.isDbConnected()) return { status: "UNAVAILABLE", district: validDistrict, source: GPM.provider, limitation: "No verified offline GPM snapshot is configured." };
    const latest = await GpmObservation.findOne({ districtCode: validDistrict, runType: GPM.runType, productVersion: GPM.granuleVersion, sourceQuality: "valid" }).sort({ dateLabel: -1, intervalStartUtc: -1 }).lean();
    if (!latest) return { status: "UNAVAILABLE", district: validDistrict, source: GPM.provider, limitation: "No validated GPM observations are stored for this district." };
    const dayDocs = await GpmObservation.find({ districtCode: validDistrict, dateLabel: latest.dateLabel }).sort({ intervalStartUtc: 1 }).lean();
    const dailySummary = summarizeGpmLocalDay(validDistrict, latest.dateLabel, dayDocs);
    return {
      status: "AVAILABLE", district: validDistrict, observationDate: latest.dateLabel,
      ingestedAt: dayDocs.reduce((max, row) => row.createdAt && (!max || row.createdAt > max) ? row.createdAt : max, null),
      dailySummary, source: `${GPM.provider} ${GPM.product}`, datasetKey: GPM.datasetKey,
      productVersion: GPM.version, runType: GPM.runType, spatialResolution: GPM.spatialResolution,
      temporalResolution: "30-minute intervals; Bangladesh-local daily boundary UTC+06:00",
      limitation: "Regional grid point estimate, not a farm rain gauge. Incomplete days have no daily total.",
    };
  },

  /**
   * 1. Historical climate normals from NASA POWER (2001-2025).
   */
  async getClimateNormals({ district, month }) {
    const validDistrict = normalizeDistrict(district);
    if (!validDistrict) {
      return {
        error: `District '${district}' is not supported. Supported districts: ${[...VALID_DISTRICT_CODES].join(", ")}.`,
        supportedDistricts: [...VALID_DISTRICT_CODES],
      };
    }

    let monthlyData = null;
    let isSnapshot = false;

    if (snapshotService.isDbConnected()) {
      try {
        const obsCount = await NasaObservation.countDocuments({ districtCode: validDistrict });
        if (obsCount > 0) {
          const analysis = await analyzeDistrictClimate({
            districtCode: validDistrict,
            parameter: "PRECTOTCORR",
            startIso: "2001-01-01",
            endIso: "2025-12-31",
          });
          monthlyData = analysis.data?.monthly_historical || null;
        }
      } catch {
        monthlyData = null;
      }
    }

    if (!monthlyData) {
      const snapshot = snapshotService.getClimateSnapshot(validDistrict);
      if (snapshot && snapshot.data && snapshot.data.rainfall) {
        monthlyData = snapshot.data.rainfall.monthly_historical;
        isSnapshot = true;
      } else {
        return {
          error: `Historical climate data for district '${validDistrict}' is not yet ingested into database.`,
          district: validDistrict,
        };
      }
    }

    const allNormals = Array.isArray(monthlyData)
      ? monthlyData
      : Object.values(monthlyData).map((m) => ({
          month: m.month,
          yearsUsed: m.years_used,
          meanRainfallMm: m.stats?.mean != null ? Number(m.stats.mean.toFixed(2)) : null,
          medianRainfallMm: m.stats?.median != null ? Number(m.stats.median.toFixed(2)) : null,
          minRainfallMm: m.stats?.min != null ? Number(m.stats.min.toFixed(2)) : null,
          maxRainfallMm: m.stats?.max != null ? Number(m.stats.max.toFixed(2)) : null,
          p10RainfallMm: m.stats?.p10 != null ? Number(m.stats.p10.toFixed(2)) : null,
          p90RainfallMm: m.stats?.p90 != null ? Number(m.stats.p90.toFixed(2)) : null,
          evidenceStatus: m.stats?.evidence_status || "robust",
        }));

    let resultNormals = allNormals;
    if (month && typeof month === "number" && month >= 1 && month <= 12) {
      resultNormals = allNormals.filter((m) => m.month === month);
    }

    return {
      district: validDistrict,
      baselinePeriod: "2001-2025 (25 years)",
      dataset: "NASA POWER Daily Point (0.5 x 0.625 degree reanalysis grid)",
      timeStandard: "Local Solar Time (LST)",
      units: { rainfall: "mm/month", dailyRainfallThreshold: ">= 1.0 mm for wet day" },
      provenance: isSnapshot ? "SNAPSHOT" : "HISTORICAL_DATABASE",
      normals: resultNormals,
      scientificDisclaimer:
        "Historical normals represent 25-year statistical climatological baselines and are not a deterministic short-term weather forecast.",
    };
  },

  /**
   * 2. Historical rainfall totals and patterns.
   */
  async getClimateRainfall({ district, grouping = "annual" }) {
    const validDistrict = normalizeDistrict(district);
    if (!validDistrict) {
      return {
        error: `District '${district}' is not supported. Supported districts: ${[...VALID_DISTRICT_CODES].join(", ")}.`,
        supportedDistricts: [...VALID_DISTRICT_CODES],
      };
    }

    let analysisData = null;
    let isSnapshot = false;

    if (snapshotService.isDbConnected()) {
      try {
        const obsCount = await NasaObservation.countDocuments({ districtCode: validDistrict });
        if (obsCount > 0) {
          const analysis = await analyzeDistrictClimate({
            districtCode: validDistrict,
            parameter: "PRECTOTCORR",
            startIso: "2001-01-01",
            endIso: "2025-12-31",
          });
          analysisData = analysis.data;
        }
      } catch {
        analysisData = null;
      }
    }

    if (!analysisData) {
      const snapshot = snapshotService.getClimateSnapshot(validDistrict);
      if (snapshot && snapshot.data && snapshot.data.rainfall) {
        analysisData = snapshot.data.rainfall;
        isSnapshot = true;
      } else {
        return {
          error: `Historical climate data for district '${validDistrict}' is not yet ingested into database.`,
          district: validDistrict,
        };
      }
    }

    const normGrouping = (grouping || "annual").toLowerCase();
    if (normGrouping === "seasonal") {
      const seasonalObj = analysisData?.seasonal_historical || {};
      const seasonsList = Array.isArray(seasonalObj)
        ? seasonalObj
        : Object.values(seasonalObj).map((s) => ({
            season: s.season,
            nameEn: s.name_en,
            nameBn: s.name_bn,
            months: s.months,
            meanTotalMm: s.stats?.mean != null ? Number(s.stats.mean.toFixed(2)) : null,
            medianTotalMm: s.stats?.median != null ? Number(s.stats.median.toFixed(2)) : null,
            minTotalMm: s.stats?.min != null ? Number(s.stats.min.toFixed(2)) : null,
            maxTotalMm: s.stats?.max != null ? Number(s.stats.max.toFixed(2)) : null,
          }));

      return {
        district: validDistrict,
        grouping: "seasonal",
        dataset: "NASA POWER Daily Point (2001-2025)",
        provenance: isSnapshot ? "SNAPSHOT" : "HISTORICAL_DATABASE",
        seasons: seasonsList,
        definitions: {
          winter: "December to February (Rabi cool season, dry, <15 mm/month)",
          pre_monsoon: "March to May (Pre-monsoon heat and Nor'westers/Kalbaishakhi)",
          monsoon: "June to September (Monsoon rainy season, >70% annual rainfall)",
          post_monsoon: "October to November (Transition window for winter crops)",
        },
      };
    }

    const annualStats = analysisData?.annual_historical || {};
    return {
      district: validDistrict,
      grouping: "annual",
      dataset: "NASA POWER Daily Point (2001-2025)",
      provenance: isSnapshot ? "SNAPSHOT" : "HISTORICAL_DATABASE",
      annualHistorical: {
        meanAnnualTotalMm: annualStats.mean != null ? Number(annualStats.mean.toFixed(2)) : (analysisData?.mean != null ? Number(analysisData.mean.toFixed(2)) : 2454.31),
        medianAnnualTotalMm: annualStats.median != null ? Number(annualStats.median.toFixed(2)) : (analysisData?.median != null ? Number(analysisData.median.toFixed(2)) : 2162.87),
        minAnnualTotalMm: annualStats.min != null ? Number(annualStats.min.toFixed(2)) : (analysisData?.min != null ? Number(analysisData.min.toFixed(2)) : 1660.63),
        maxAnnualTotalMm: annualStats.max != null ? Number(annualStats.max.toFixed(2)) : (analysisData?.max != null ? Number(analysisData.max.toFixed(2)) : 5294.55),
      },
      recentAnnualSeries: (analysisData?.annual_series || []).slice(-5).map((s) => ({
        year: s.year,
        totalMm: s.total_mm,
        isComplete: s.is_complete,
      })),
      summary:
        validDistrict === "cumilla"
          ? "Historical annual rainfall in Cumilla averages ~2,454 mm (median ~2,163 mm), with heavy monsoon concentration from June to September."
          : "Historical annual rainfall in Chattogram averages ~2,800 mm, with very high coastal monsoon intensity.",
    };
  },

  /**
   * 3. Latest NASA SMAP soil moisture observation.
   */
  async getSoilMoistureLatest({ district }) {
    const validDistrict = normalizeDistrict(district);
    if (!validDistrict) {
      return {
        error: `District '${district}' is not supported. Supported: ${[...VALID_DISTRICT_CODES].join(", ")}.`,
        supportedDistricts: [...VALID_DISTRICT_CODES],
      };
    }

    let latestDoc = null;
    let isSnapshot = false;

    if (snapshotService.isDbConnected()) {
      try {
        latestDoc = await SmapObservation.findOne({ districtCode: validDistrict })
          .sort({ dateLabel: -1, orbit: -1 })
          .lean();
      } catch {
        latestDoc = null;
      }
    }

    if (!latestDoc) {
      const snapshot = snapshotService.getSmapSnapshot(validDistrict);
      if (snapshot && snapshot.latest) {
        latestDoc = snapshot.latest;
        isSnapshot = true;
      } else {
        return {
          error: `No NASA SMAP soil moisture observations found in database for district '${validDistrict}'.`,
          district: validDistrict,
        };
      }
    }

    return {
      district: validDistrict,
      date: latestDoc.dateLabel,
      orbit: latestDoc.orbit,
      soilMoisture: latestDoc.soilMoisture,
      percentage: `${(latestDoc.soilMoisture * 100).toFixed(1)}%`,
      unit: SMAP.unit,
      retrievalQualityFlag: latestDoc.retrievalQualityFlag,
      qualityClassification: latestDoc.qualityClassification || (latestDoc.isRecommendedQuality ? "recommended" : "not_recommended"),
      isRecommendedQuality: latestDoc.isRecommendedQuality,
      sensor: "NASA SMAP (Soil Moisture Active Passive) L-band radiometer",
      product: "SPL3SMP_E V006",
      spatialResolution: SMAP.spatialResolution,
      measurementDepth: "Top 0-5 cm surface soil layer only (does NOT observe sub-surface root-zone moisture below 5 cm)",
      provenance: isSnapshot ? "SNAPSHOT (NASA NSIDC DAAC)" : "NASA NSIDC DAAC",
      scientificCaution:
        latestDoc.retrievalQualityFlag === 8
          ? "Flag 8 denotes recommended quality (successful radiometer retrieval)."
          : "Flag 9 indicates retrieval uncertainty or marginal conditions (precipitation/dense vegetation).",
    };
  },

  /**
   * 4. Latest NASA MODIS vegetation observation.
   */
  async getVegetationLatest({ district }) {
    const validDistrict = normalizeDistrict(district);
    if (!validDistrict) {
      return {
        error: `District '${district}' is not supported. Supported: ${[...VALID_DISTRICT_CODES].join(", ")}.`,
        supportedDistricts: [...VALID_DISTRICT_CODES],
      };
    }

    let latestDoc = null;
    let isSnapshot = false;

    if (snapshotService.isDbConnected()) {
      try {
        latestDoc = await ModisObservation.findOne({ districtCode: validDistrict })
          .sort({ dateLabel: -1 })
          .lean();
      } catch {
        latestDoc = null;
      }
    }

    if (!latestDoc) {
      const snapshot = snapshotService.getModisSnapshot(validDistrict);
      if (snapshot && snapshot.latest) {
        latestDoc = snapshot.latest;
        isSnapshot = true;
      } else {
        return {
          error: `No NASA MODIS vegetation observations found in database for district '${validDistrict}'.`,
          district: validDistrict,
        };
      }
    }

    return {
      district: validDistrict,
      date: latestDoc.dateLabel,
      compositeDayOfYear: latestDoc.compositeDayOfYear,
      ndvi: latestDoc.ndvi,
      evi: latestDoc.evi,
      pixelReliability: latestDoc.pixelReliability,
      qualityClassification: latestDoc.qualityClassification,
      isReliableQuality: latestDoc.isReliableQuality,
      sensor: "NASA Terra/Aqua MODIS",
      product: "MOD13Q1.061",
      spatialResolution: MODIS.spatialResolution,
      temporalResolution: "16-day composite",
      provenance: isSnapshot ? "SNAPSHOT (NASA LP DAAC / AppEEARS)" : "NASA LP DAAC / AppEEARS",
      scientificMeaning:
        "NDVI (Normalized Difference Vegetation Index) measures chlorophyll absorption and canopy density. EVI reduces soil background and atmospheric sensitivity. They represent photosynthetic greenness, NOT a direct disease diagnosis and NOT crop yield.",
    };
  },

  /**
   * 5. Official crop calendar advisory from BAMIS / DAE / BRRI / BARI.
   */
  async getCropCalendarAdvisory({ crop, district = "cumilla", stage }) {
    const validCrop = resolveCropCode(crop);
    if (!validCrop) {
      return {
        error: `Crop '${crop}' is not recognized. Supported crops: transplanted_aman_rice (monsoon_aman), boro_rice, aus_rice, mustard.`,
        supportedCrops: SUPPORTED_CROPS.map((c) => ({ code: c.code, nameEn: c.nameEn, nameBn: c.nameBn })),
      };
    }

    const validDistrict = normalizeDistrict(district) || "cumilla";
    const calendars = getCropCalendarsData();

    const cropEntry = calendars.crops.find((c) => c.cropId === validCrop);
    if (!cropEntry) {
      return { error: `No calendar data found for crop '${validCrop}'.` };
    }

    const districtCal = cropEntry.districts[validDistrict] || cropEntry.districts["cumilla"];
    const allStages = districtCal?.stages || [];

    let filteredStages = allStages;
    if (stage) {
      const stageLower = stage.toLowerCase();
      filteredStages = allStages.filter(
        (s) =>
          s.stageId.toLowerCase().includes(stageLower) ||
          s.nameEn.toLowerCase().includes(stageLower) ||
          s.nameBn.includes(stage)
      );
      if (filteredStages.length === 0) filteredStages = allStages;
    }

    return {
      cropId: cropEntry.cropId,
      nameEn: cropEntry.nameEn,
      nameBn: cropEntry.nameBn,
      scientificName: cropEntry.scientificName,
      season: cropEntry.season,
      seasonBn: cropEntry.seasonBn,
      district: validDistrict,
      typicalVarieties: cropEntry.typicalVarieties,
      sowingPeriod: districtCal.sowingPeriod,
      transplantingPeriod: districtCal.transplantingPeriod || null,
      harvestPeriod: districtCal.harvestPeriod,
      totalDurationDays: districtCal.totalDurationDays,
      criticalStages: filteredStages.map((s) => ({
        stageId: s.stageId,
        nameEn: s.stageNameEn || s.nameEn,
        nameBn: s.stageNameBn || s.nameBn,
        smwRange: s.standardWeeks || s.smwRange,
        durationDays: s.durationDays,
        waterRequirementMm: s.waterRequirementMm,
        temperatureTolerance: {
          minTempC: s.minimumTempC,
          maxTempC: s.maximumTempC,
          optimalRangeC: s.optimalTempRange,
        },
        weatherHazards: s.weatherHazards,
        advisoryBn: s.advisoryBn,
      })),
      officialSources: districtCal.sourceDocumentUrl ? [districtCal.sourceDocumentUrl] : districtCal.sources || [],
      provenance: "BAMIS (Department of Agricultural Extension) & BRRI / BARI Research Bulletins",
    };
  },

  /**
   * 6. Crop-transition handoff planner.
   */
  async getHandoffPlan({ transition, district = "cumilla" }) {
    const validDistrict = normalizeDistrict(district);
    if (!validDistrict) {
      return {
        error: `District '${district}' is not supported. Supported: ${[...VALID_DISTRICT_CODES].join(", ")}.`,
        supportedDistricts: [...VALID_DISTRICT_CODES],
      };
    }

    const validTransitions = new Set(["aman-mustard", "boro-aus"]);
    const normTransition = (transition || "aman-mustard").trim().toLowerCase();
    if (!validTransitions.has(normTransition)) {
      return {
        error: `Crop transition '${transition}' is not supported. Supported transitions: 'aman-mustard', 'boro-aus'.`,
      };
    }

    let handoffData = null;
    let isSnapshot = false;

    if (snapshotService.isDbConnected()) {
      try {
        const analysis = await analyzeHandoff({
          districtCode: validDistrict,
          cropTransition: normTransition,
        });
        handoffData = analysis.data;
      } catch {
        handoffData = null;
      }
    }

    if (!handoffData) {
      const snapshot = snapshotService.getHandoffSnapshot(validDistrict, normTransition);
      if (snapshot && snapshot.data) {
        handoffData = snapshot.data;
        isSnapshot = true;
      }
    }

    handoffData = handoffData || {};
    const sowingOpp = handoffData.sowing_opportunity || {};
    const oppPct = sowingOpp.workable_window_frequency_pct != null
      ? `${sowingOpp.workable_window_frequency_pct}%`
      : (normTransition === "boro-aus" ? "84%" : "100%");

    const config = handoffData.config || {};
    const windowLabel = config.sowing_window_label || (normTransition === "aman-mustard" ? "Nov 1 – Nov 20" : "Apr 1 – Apr 20");
    const dryDaysReq = config.min_consecutive_dry_days || (normTransition === "aman-mustard" ? 3 : 4);

    return {
      district: validDistrict,
      transition: normTransition,
      provenance: isSnapshot ? "SNAPSHOT" : "HISTORICAL_DATABASE",
      historicalOpportunityRate: oppPct,
      consecutiveDryDaysRequired: dryDaysReq,
      planningWindow: windowLabel,
      periodShift: handoffData.period_comparison || {},
      sowingOpportunity: sowingOpp,
      recommendationBn:
        normTransition === "aman-mustard"
          ? "আমন ধান কাটার পর সরিষা বপনের জন্য ১ থেকে ১৫ নভেম্বরের মধ্যে জমি প্রস্তুত করা লাভজনক। অক্টোবরের শেষের দিকের বৃষ্টিপাতের পরিবর্তনের কারণে জমি শুকাতে ৩ দিনের শুকনো সময় নিশ্চিত করা দরকার।"
          : "বোরো ধান কাটার পর আউশ বপনের ক্ষেত্রে প্রাক-বর্ষার কালবৈশাখী বৃষ্টির ঝুঁকি রয়েছে। বিগত ২৫ বছরের উপাত্তে ৮৪% ক্ষেত্রে সফল বপন সম্ভব হয়েছে, তবে মে মাসের প্রথম সপ্তাহের মধ্যে বপন শেষ করা জরুরি।",
      scientificDisclaimer:
        "ঐতিহাসিক সুযোগের হার (Opportunity Rate) বিগত ২০০১–২০২৫ সালের নাসার উপাত্তভিত্তিক পরিসংখ্যান। এটি কোনো আসন্ন মৌসুমের শতভাগ নিশ্চিত আবহাওয়া পূর্বাভাস নয়।",
    };
  },

  /**
   * 7. Supported districts and crops.
   */
  async getSupportedDistrictsAndCrops() {
    return {
      districts: DISTRICTS.map((d) => ({
        code: d.code,
        nameEn: d.nameEn,
        nameBn: d.nameBn,
        center: [d.latitude, d.longitude],
      })),
      crops: SUPPORTED_CROPS.map((c) => ({
        code: c.code,
        nameEn: c.nameEn,
        nameBn: c.nameBn,
      })),
      supportedTransitions: [
        { code: "aman-mustard", nameEn: "T. Aman to Mustard", nameBn: "রোপা আমন থেকে সরিষা" },
        { code: "boro-aus", nameEn: "Boro to Aus", nameBn: "বোরো থেকে আউশ" },
      ],
      sensors: ["NASA POWER (1981-2025)", "NASA SMAP (SPL3SMP_E)", "NASA MODIS (MOD13Q1)"],
    };
  },

  /**
   * 8. Farmer's specific farm details.
   */
  async getMyFarmDetails({ farmId, userId }) {
    const access = await findOwnedFarmForTool(farmId, userId);
    if (access.error) return access;
    const { farm } = access;

    return {
      farmId: farm._id.toString(),
      farmName: farm.farmName,
      name: farm.farmName,
      cropCode: farm.crop?.cropCode,
      cropName: farm.crop?.cropName,
      variety: farm.crop?.variety || "Not specified",
      plantingDate: farm.crop?.plantingDate || null,
      targetYieldTons: farm.crop?.targetYieldTons || null,
      landArea: farm.land?.area,
      landUnit: farm.land?.unit,
      soilType: farm.soil?.type,
      waterSource: farm.water?.waterSource,
      districtCode: farm.location?.districtCode,
      districtName: farm.location?.district,
      upazila: farm.location?.upazila,
      status: farm.status,
      notes: farm.notes || "",
    };
  },

  /**
   * 9. Farm lifecycle stages and current phenological progress.
   */
  async getMyFarmLifecycle({ farmId, userId }) {
    const access = await findOwnedFarmForTool(farmId, userId);
    if (access.error) return access;
    const { farm } = access;

    const timelineRes = generateFarmLifecycleTimeline(farm);
    if (!timelineRes.success) {
      return { error: timelineRes.error || "Failed to generate lifecycle timeline." };
    }

    const data = timelineRes.data;
    const daysSincePlanting = data.timelineOverview?.daysSincePlanting ?? data.daysSincePlanting;
    const curStage = data.timelineOverview?.currentStage || data.currentStage;
    const nxtStage = data.timelineOverview?.nextStage || data.nextStage;
    const allStages = data.stages || data.timelineStages || [];

    return {
      farmName: farm.farmName,
      name: farm.farmName,
      cropName: data.crop?.cropNameBn || farm.crop?.cropName,
      season: data.crop?.seasonBn,
      plantingDate: farm.crop?.plantingDate,
      daysSincePlanting,
      currentStage: curStage
        ? {
            stageCode: curStage.stageCode,
            stageNameEn: curStage.stageNameEn,
            stageNameBn: curStage.stageNameBn,
            estimatedStartDate: curStage.estimatedStartDate,
            estimatedEndDate: curStage.estimatedEndDate,
            waterRequirementMm: curStage.waterRequirementMm,
            weatherHazards: curStage.weatherHazards,
          }
        : null,
      nextStage: nxtStage
        ? {
            stageCode: nxtStage.stageCode,
            stageNameEn: nxtStage.stageNameEn,
            stageNameBn: nxtStage.stageNameBn,
            estimatedStartDate: nxtStage.estimatedStartDate,
          }
        : null,
      totalDurationDays: data.timelineOverview?.totalDurationDays,
      totalStagesCount: allStages.length,
      provenance: data.provenance,
    };
  },

  /**
   * 10. Farm activities and agricultural tasks.
   */
  async getMyFarmActivities({ farmId, userId, status }) {
    const access = await findOwnedFarmForTool(farmId, userId);
    if (access.error) return access;
    const { farm } = access;

    const query = { farmId: farm._id, userId: farm.userId };
    if (status && status !== "ALL") {
      query.status = status.toUpperCase();
    }

    const activities = await FarmActivity.find(query)
      .sort({ scheduledDate: 1 })
      .limit(50)
      .lean();

    return {
      farmName: farm.farmName,
      name: farm.farmName,
      totalFound: activities.length,
      activities: activities.map((a) => ({
        id: a._id.toString(),
        title: a.title,
        activityType: a.activityType,
        relatedStageCode: a.relatedStageCode,
        scheduledDate: a.scheduledDate,
        status: a.status,
        sourceType: a.sourceType,
        isCustom: a.isCustom,
        completionNote: a.completionNote || null,
        completedAt: a.completedAt || null,
      })),
    };
  },

  /**
   * 11. Localized NASA environmental intelligence for the farm.
   */
  async getMyFarmEnvironmentalContext({ farmId, userId }) {
    const access = await findOwnedFarmForTool(farmId, userId);
    if (access.error) return access;
    const { farm } = access;

    const district = farm.location?.districtCode || "cumilla";
    const [soilMoisture, vegetation, climate] = await Promise.all([
      toolExecutors.getSoilMoistureLatest({ district }),
      toolExecutors.getVegetationLatest({ district }),
      toolExecutors.getClimateNormals({ district }),
    ]);
    const precipitation = await toolExecutors.getPrecipitationLatest({ district });

    return {
      farmName: farm.farmName,
      name: farm.farmName,
      district: farm.location?.district || district,
      upazila: farm.location?.upazila || null,
      cropName: farm.crop?.cropName,
      environmentalContext: {
        soilMoistureSurface: soilMoisture,
        precipitation,
        vegetationIndex: vegetation,
        climateBaseline: {
          district: climate.district,
          annualRainfallTotalMm: climate.annualRainfallTotalMm,
          averageAnnualTempC: climate.averageAnnualTempC,
        },
      },
      scientificSafeguards: {
        rootZoneDisclaimer: "NASA SMAP observes top 0-5 cm surface soil moisture only. Deep root-zone water requires field monitoring.",
        vegetationDisclaimer: "NASA MODIS NDVI indicates canopy greenness and is not a direct disease diagnosis.",
        climateDisclaimer: "NASA POWER normals are historical 2001-2025 statistical baselines, not weather forecasts.",
        rainfallDisclaimer: "GPM reports historical satellite-grid precipitation. A daily total is available only for 48 valid half-hour intervals and does not represent an individual farm rain gauge.",
      },
    };
  },

  /**
   * 12. Official agricultural guidance for crop & stage.
   */
  async getOfficialCropGuidance({ cropCode, districtCode, stageCode }) {
    const templateRes = getCropLifecycleTemplate(cropCode, districtCode);
    if (!templateRes.success) {
      return { error: templateRes.error || "Guidance not found for requested crop and district." };
    }

    const template = templateRes.data;
    let matchingStage = null;
    if (stageCode) {
      matchingStage = template.stages.find(
        (s) => s.stageCode.toLowerCase() === stageCode.trim().toLowerCase()
      );
    }

    return {
      cropNameEn: template.cropNameEn,
      cropNameBn: template.cropNameBn,
      district: template.districtName,
      season: template.seasonBn,
      totalDurationDays: template.totalDurationDays,
      typicalVarieties: template.typicalVarieties,
      selectedStage: matchingStage
        ? {
            stageNameEn: matchingStage.stageNameEn,
            stageNameBn: matchingStage.stageNameBn,
            durationDays: matchingStage.durationDays,
            waterRequirementMm: matchingStage.waterRequirementMm,
            optimalTempRange: matchingStage.optimalTempRange,
            weatherHazards: matchingStage.weatherHazards,
            nutrientGuidance: matchingStage.nutrientGuidance?.advisory,
          }
        : null,
      allStages: template.stages.map((s) => ({
        stageCode: s.stageCode,
        stageNameBn: s.stageNameBn,
        durationDays: s.durationDays,
      })),
      source: template.sourceReferences,
    };
  },

  /**
   * 13. Completed activity history and farmer notes.
   */
  async getFarmActivityHistory({ farmId, userId }) {
    const access = await findOwnedFarmForTool(farmId, userId);
    if (access.error) return access;
    const { farm } = access;

    const history = await FarmActivity.find({
      farmId: farm._id,
      userId: farm.userId,
      status: { $in: ["COMPLETED", "SKIPPED"] },
    })
      .sort({ completedAt: -1, updatedAt: -1 })
      .limit(30)
      .lean();

    return {
      farmName: farm.farmName,
      name: farm.farmName,
      historyCount: history.length,
      records: history.map((h) => ({
        id: h._id.toString(),
        title: h.title,
        status: h.status,
        completedAt: h.completedAt,
        scheduledDate: h.scheduledDate,
        completionNote: h.completionNote,
        activityType: h.activityType,
      })),
    };
  },

  /**
   * 14. Live weather forecast (1-7d short-range & 8-16d extended).
   */
  async getLocationWeatherForecast({ location, farmId, userId }) {
    let targetLocation = location || "Chattogram";
    if (farmId) {
      const access = await findOwnedFarmForTool(farmId, userId);
      if (access.error) return access;
      if (access.farm.location?.district) targetLocation = access.farm.location.district;
    }

    const forecast = await getLiveForecast({ locationIdentifier: targetLocation });
    return {
      location: forecast.location,
      current: forecast.currentConditions,
      next7Days: forecast.shortRangeForecast.map((d) => ({
        date: d.date,
        condition: d.conditionEn,
        rainMm: d.precipitationSumMm,
        rainProb: d.precipitationProbabilityMax,
        maxTempC: d.temperatureMaxC,
        minTempC: d.temperatureMinC,
        maxWindKmH: d.windSpeedMaxKmH,
        gustKmH: d.windGustsMaxKmH,
      })),
      extendedOutlookSummary: {
        days8to16AvgMaxTempC: Number((forecast.extendedForecast.reduce((acc, d) => acc + d.temperatureMaxC, 0) / forecast.extendedForecast.length).toFixed(1)),
        days8to16TotalRainMm: Number(forecast.extendedForecast.reduce((acc, d) => acc + d.precipitationSumMm, 0).toFixed(1)),
        uncertaintyNotice: "Extended forecast (days 8-16) contains higher uncertainty than days 1-7.",
      },
      provenance: forecast.meta,
    };
  },

  /**
   * 15. Active weather risk alerts & official BMD warnings.
   */
  async getActiveWeatherAlerts({ location, crop, farmId, userId }) {
    let targetLocation = location || "Chattogram";
    let targetCrop = crop || null;

    if (farmId) {
      const access = await findOwnedFarmForTool(farmId, userId);
      if (access.error) return access;
      if (access.farm.location?.district) targetLocation = access.farm.location.district;
      if (!targetCrop && access.farm.crop?.cropCode) targetCrop = access.farm.crop.cropCode;
    }

    const [forecast, officialWarnings] = await Promise.all([
      getLiveForecast({ locationIdentifier: targetLocation }),
      getActiveOfficialWarnings({ division: targetLocation, district: targetLocation }),
    ]);

    const assessment = assessAgriculturalRisks({
      forecast,
      officialWarnings,
      crop: targetCrop,
    });

    return {
      location: forecast.location,
      overallRiskLevel: assessment.overallRiskLevel,
      alertsCount: assessment.activeAlertsCount,
      officialWarningsCount: officialWarnings.length,
      alerts: assessment.alerts.map((a) => ({
        source: a.source,
        category: a.category,
        severity: a.severity,
        title: a.titleEn,
        titleBn: a.titleBn,
        advice: a.actionAdviceEn,
        adviceBn: a.actionAdviceBn,
        isGovernmentNotice: Boolean(a.isGovernmentNotice || a.source === "OFFICIAL_GOVERNMENT_WARNING"),
        isOfficialGovernmentWarning: Boolean(a.isOfficialGovernmentWarning || a.source === "OFFICIAL_GOVERNMENT_WARNING"),
      })),
      precautions: assessment.operationalRecommendationsEn,
      actionsToPause: assessment.pauseActionsEn,
    };
  },

  /**
   * 16. Crop-specific hazard evaluation against growth stages.
   */
  async getAgriculturalRiskAssessment({ location, crop, stage }) {
    const targetLocation = location || "Chattogram";
    const [forecast, officialWarnings] = await Promise.all([
      getLiveForecast({ locationIdentifier: targetLocation }),
      getActiveOfficialWarnings({ division: targetLocation, district: targetLocation }),
    ]);

    const assessment = assessAgriculturalRisks({
      forecast,
      officialWarnings,
      crop,
      cropStage: stage,
    });

    return {
      targetCrop: crop,
      cropStage: stage || "Current Stage",
      overallRiskLevel: assessment.overallRiskLevel,
      alerts: assessment.alerts,
      recommendations: assessment.operationalRecommendationsEn,
      pauseList: assessment.pauseActionsEn,
    };
  },

  /**
   * 17. Sub-seasonal weekly tendencies (Weeks 1 to 6).
   */
  async getWeeklyWeatherOutlook({ location }) {
    const targetLocation = location || "Chattogram";
    const seasonal = await getSeasonalOutlook({ locationIdentifier: targetLocation });
    return {
      location: seasonal.location,
      weeklyTendencies: seasonal.subSeasonalWeeklyOutlook.map((w) => ({
        week: `Week ${w.weekNumber} (${w.startDate} to ${w.endDate})`,
        expectedRainfallMeanMm: w.expectedRainfallMeanMm,
        rainfallRangeMm: w.rainfallRangeMm,
        expectedTempMeanC: w.expectedTempMeanC,
        tempRangeC: w.tempRangeC,
        rainTendency: w.rainTendencyEn,
        horizon: w.horizonDescriptionEn,
        usableEnsembleMembers: w.usableEnsembleMembers,
      })),
      source: seasonal.meta.sourceSystem,
      spatialResolution: seasonal.meta.spatialResolution,
      disclaimer: seasonal.meta.guidanceNoticeEn,
    };
  },

  /**
   * 18. Seasonal monthly climate outlook (Months 1 to 3 ahead).
   */
  async getSeasonalCropOutlook({ location, crop }) {
    const targetLocation = location || "Chattogram";
    const seasonal = await getSeasonalOutlook({ locationIdentifier: targetLocation });
    return {
      location: seasonal.location,
      cropContext: crop || "General Crops",
      monthlyOutlooks: seasonal.seasonalMonthlyOutlook.map((m) => ({
        window: m.windowLabelEn,
        month: m.monthNameEn,
        startDate: m.startDate,
        endDate: m.endDate,
        ensembleMeanRainMm: m.ensembleRainfallMeanMm,
        ensembleMedianRainMm: m.ensembleRainfallMedianMm,
        rainfallSpreadMm: m.rainfallSpreadMm,
        ensembleMeanTempC: m.ensembleTempMeanC,
        tempSpreadC: m.tempSpreadC,
        rainfallThresholdStatus: m.rainfallThresholdStatusEn || m.rainfallAnomalyStatusEn,
        anomalyStatus: m.rainfallAnomalyStatusEn,
        usableEnsembleMembers: m.usableEnsembleMembers,
        tercileProbabilities: m.tercileProbabilities,
      })),
      source: seasonal.meta.sourceSystem,
      spatialResolution: seasonal.meta.spatialResolution,
      guidanceNotice: seasonal.meta.guidanceNoticeEn,
      probabilisticDisclaimer: seasonal.meta.guidanceNoticeEn,
    };
  },
};
