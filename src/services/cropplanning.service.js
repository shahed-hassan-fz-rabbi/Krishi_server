/**
 * Crop Planning & Recommendation Engine.
 * Deterministic suitability filtering grounded in BAMIS / DAE / BRRI / BARI crop calendars,
 * enriched with NASA satellite observations and explained via Gemini (with deterministic fallback).
 *
 * Scientific Safeguards:
 * - Suitability is derived from verified agronomic factors (season, water, land type).
 * - No arbitrary numerical percentages or fake star ratings.
 * - Categorization: "supported", "potential", or "insufficient_info".
 * - Never invents fertilizer dosages, yield promises, or profit claims.
 */

import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env.config.js";
import { loadOfficialCropCalendars } from "./croplifecycle.service.js";
import { SmapObservation } from "../models/smapobservation.model.js";
import { ModisObservation } from "../models/modisobservation.model.js";
import { snapshotService } from "./snapshot.service.js";

/**
 * Evaluates candidate crops for a given district and land/water profile.
 */
export function evaluateCropEligibility({
  districtCode,
  upazila,
  landType = "medium_high",
  soilType = "unknown",
  drainage = "good",
  irrigationAvailability = "available",
  waterSource = "",
  seasonPreference = null,
  preferredCrop = null,
  targetPlantingPeriod = null,
}) {
  const calendars = loadOfficialCropCalendars();
  const lowerDistrict = (districtCode || "").trim().toLowerCase();

  // Validate district
  if (!calendars.metadata.districts.includes(lowerDistrict)) {
    return {
      isValid: false,
      error: `District '${districtCode}' is not currently supported for official crop planning. Supported districts: ${calendars.metadata.districts.join(", ")}.`,
    };
  }

  const eligibleCrops = [];
  const missingInfo = [];

  // Identify missing optional inputs
  if (!soilType || soilType === "unknown") {
    missingInfo.push("Soil type not specified (standard loamy assumptions applied; local DAE soil check recommended).");
  }
  if (!drainage || drainage === "unknown") {
    missingInfo.push("Drainage condition unspecified (good to moderate drainage assumed).");
  }
  if (!waterSource && irrigationAvailability !== "unavailable") {
    missingInfo.push("Water source unspecified.");
  }

  // Iterate over verified crops in official dataset
  for (const crop of calendars.crops) {
    const districtCal = crop.districts[lowerDistrict];
    if (!districtCal) continue;

    const reasons = [];
    const constraints = [];
    let suitabilityCategory = "supported"; // 'supported' | 'potential' | 'insufficient_info'

    // 1. Season Alignment
    const cropSeason = crop.season.toLowerCase(); // 'kharif-1', 'kharif-2', 'robi' / 'rabi'
    let isSeasonMatch = true;

    if (seasonPreference) {
      const pref = seasonPreference.trim().toLowerCase();
      if (pref.includes("rabi") || pref.includes("robi") || pref === "winter") {
        isSeasonMatch = cropSeason.includes("rabi") || cropSeason.includes("robi");
      } else if (pref.includes("kharif-1") || pref.includes("aus") || pref === "early_monsoon") {
        isSeasonMatch = cropSeason.includes("kharif-1");
      } else if (pref.includes("kharif-2") || pref.includes("aman") || pref === "monsoon") {
        isSeasonMatch = cropSeason.includes("kharif-2");
      }
    }

    if (!isSeasonMatch) {
      // If user specified a different season, downgrade or note season divergence
      suitabilityCategory = "potential";
      constraints.push(`Crop is traditionally cultivated in ${crop.season} (${districtCal.sowingPeriod}), which differs from preferred season '${seasonPreference}'.`);
    } else {
      reasons.push(`Aligned with official ${crop.season} season (${districtCal.sowingPeriod}).`);
    }

    // 2. Preferred Crop Filter
    if (preferredCrop) {
      const prefC = preferredCrop.trim().toLowerCase();
      if (crop.cropId.toLowerCase() === prefC) {
        reasons.push("Direct match for farmer's crop interest.");
      }
    }

    // 3. Water Availability Evaluation
    const waterMm = districtCal.waterRequirementMmTotal;
    if (crop.cropId === "boro_rice") {
      if (irrigationAvailability === "unavailable") {
        suitabilityCategory = "potential";
        constraints.push(`Boro rice requires high cumulative irrigation (~${waterMm} mm) during dry Rabi season. Rainfed cultivation without assured irrigation risks total crop failure.`);
      } else if (irrigationAvailability === "limited") {
        suitabilityCategory = "potential";
        constraints.push(`Requires careful Alternate Wetting and Drying (AWD) water management due to limited irrigation (~${waterMm} mm demand).`);
      } else {
        reasons.push(`Assured irrigation meets the ${waterMm} mm dry-season requirement for Boro rice.`);
      }
    } else if (crop.cropId === "mustard") {
      if (irrigationAvailability === "available" || irrigationAvailability === "limited") {
        reasons.push(`Low moisture requirement (~${waterMm} mm) makes mustard highly compatible with residual soil moisture and 1-2 light supplemental irrigations.`);
      } else {
        reasons.push(`Can be cultivated with residual soil moisture (~${waterMm} mm total requirement) following Aman harvest.`);
      }
    } else if (crop.cropId === "monsoon_aman") {
      if (irrigationAvailability === "unavailable") {
        reasons.push("Primary monsoon-fed crop (Kharif-2); naturally supported by regional monsoon rainfall.");
      } else {
        reasons.push("Monsoon rainfall supported with supplemental irrigation for dry spells during tillering or panicle initiation.");
      }
    } else if (crop.cropId === "aus_rice") {
      reasons.push(`Moderate water requirement (~${waterMm} mm) during early monsoon Kharif-I.`);
    }

    // 4. Land Type Evaluation
    const lowerLandType = (landType || "").toLowerCase();
    if (lowerLandType === "low") {
      if (crop.cropId === "monsoon_aman") {
        suitabilityCategory = "potential";
        constraints.push("Lowland is prone to deep monsoon submergence (>50 cm); requires flood-tolerant varieties (e.g. BRRI dhan51/52) to avoid seedling drowning.");
      } else if (crop.cropId === "boro_rice") {
        reasons.push("Lowland is well-suited for Boro rice as surface floodwaters recede in early winter.");
      } else if (crop.cropId === "mustard") {
        suitabilityCategory = "potential";
        constraints.push("Lowland may stay waterlogged after monsoon; mustard requires timely drying to avoid seed rot.");
      }
    } else if (lowerLandType === "high" || lowerLandType === "medium_high") {
      if (crop.cropId === "mustard") {
        reasons.push("High to medium-high land provides good drainage essential for mustard root aeration and seed germination.");
      } else if (crop.cropId === "monsoon_aman") {
        reasons.push("Medium-high land is prime for transplanted Aman rice with controlled bunding.");
      }
    }

    // Drainage alert
    if (drainage === "waterlogged" && crop.cropId === "mustard") {
      suitabilityCategory = "potential";
      constraints.push("Waterlogged drainage is detrimental to mustard emergence. Raised beds or drainage ditches required.");
    }

    eligibleCrops.push({
      cropCode: crop.cropId,
      cropNameEn: crop.nameEn,
      cropNameBn: crop.nameBn,
      scientificName: crop.scientificName,
      season: crop.season,
      seasonBn: crop.seasonBn,
      typicalVarieties: crop.typicalVarieties,
      recommendedVarieties:
        typeof crop.typicalVarieties === "string"
          ? crop.typicalVarieties.split(",").map((s) => s.trim())
          : Array.isArray(crop.typicalVarieties)
          ? crop.typicalVarieties
          : [],
      totalDurationDays: districtCal.totalDurationDays,
      sowingPeriod: districtCal.sowingPeriod,
      transplantingPeriod: districtCal.transplantingPeriod,
      harvestingPeriod: districtCal.harvestingPeriod,
      waterRequirementMmTotal: districtCal.waterRequirementMmTotal,
      suitabilityCategory,
      suitability: suitabilityCategory,
      reasons,
      constraints,
      weatherHazardsSummary: districtCal.stages.map((s) => s.weatherHazards).filter(Boolean).slice(0, 2),
      sourceReferences: {
        title: districtCal.sourceDocumentTitle,
        publisher: districtCal.sourcePublisher,
        url: districtCal.sourceDocumentUrl,
        daeRegion: districtCal.daeRegion,
      },
    });
  }

  return {
    isValid: true,
    districtCode: lowerDistrict,
    districtName: lowerDistrict === "cumilla" ? "Cumilla" : "Chattogram",
    upazila: upazila || "Selected Upazila",
    crops: eligibleCrops,
    eligibleCrops,
    missingInfo,
    metadata: calendars.metadata,
    evaluationTimestamp: new Date().toISOString(),
  };
}

/**
 * Retrieves latest NASA environmental context for the planning district.
 */
export async function getPlanningSatelliteContext(districtCode) {
  const lowerDistrict = (districtCode || "cumilla").toLowerCase();
  let smap = null;
  let modis = null;

  if (snapshotService.isDbConnected()) {
    try {
      smap = await SmapObservation.findOne({ districtCode: lowerDistrict }).sort({ dateLabel: -1 }).lean();
      modis = await ModisObservation.findOne({ districtCode: lowerDistrict }).sort({ dateLabel: -1 }).lean();
    } catch {
      // Fallback
    }
  }

  if (!smap) {
    smap = snapshotService.getSmapSnapshot(lowerDistrict)?.latest || null;
  }
  if (!modis) {
    modis = snapshotService.getModisSnapshot(lowerDistrict)?.latest || null;
  }

  return {
    districtCode: lowerDistrict,
    smap: smap
      ? {
          soilMoistureM3M3: smap.soilMoisture,
          unit: smap.unit || "m³/m³",
          dateLabel: smap.dateLabel,
          qualityClassification: smap.qualityClassification || "recommended",
        }
      : null,
    modis: modis
      ? {
          ndviMean: modis.ndvi,
          eviMean: modis.evi,
          dateLabel: modis.dateLabel,
          qualityClassification: modis.qualityClassification || "good_data",
        }
      : null,
    soilMoistureProxy: smap
      ? {
          value: smap.soilMoisture,
          unit: smap.unit || "m³/m³",
          observedDate: smap.dateLabel,
          quality: smap.qualityClassification || "recommended",
          disclaimer: "NASA SMAP measures top 0-5 cm surface soil moisture proxy, not root-zone saturation.",
        }
      : null,
    vegetationIndexProxy: modis
      ? {
          ndvi: modis.ndvi,
          evi: modis.evi,
          observedDate: modis.dateLabel,
          quality: modis.qualityClassification || "good_data",
          disclaimer: "NASA MODIS 250m indicates regional canopy greenness, not a plant pathology diagnosis.",
        }
      : null,
  };
}

/**
 * Generates natural language planning explanation using Gemini,
 * falling back to a deterministic explanation on quota or network failure.
 */
export async function generatePlanningExplanation(args = {}) {
  const language = args.language === "en" ? "en" : "bn";
  const isBangla = language === "bn";

  // Normalize parameters whether passed nested or flat
  const farmerProfile = args.farmerProfile || {
    upazila: args.upazila,
    land: args.land || {},
    water: args.water || {},
    preferences: args.preferences || {},
  };

  const evaluationResult = args.evaluationResult || {
    districtCode: args.districtCode,
    districtName: (args.districtCode || "").toLowerCase() === "cumilla" ? "Cumilla" : "Chattogram",
    eligibleCrops: args.eligibleCrops || args.crops || [],
  };

  const environmentalContext = args.environmentalContext || args.satelliteContext || {};
  const apiKey = env.geminiApiKey;
  let geminiOutput = null;

  // Attempt Gemini if configured
  if (apiKey && apiKey.length > 20 && !apiKey.startsWith("YOUR_")) {
    try {
      const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
      const prompt = `
You are the grounded agricultural planning advisor of Krishi Mama.
Explain the following verified crop planning evaluation to a Bangladeshi farmer in simple, respectful, and crystal-clear ${isBangla ? "Bangla (চলিত বাংলা)" : "English"}.

STRICT RULES:
1. Ground your answer ONLY in the provided verified data below.
2. DO NOT invent fertilizer dosage, pesticide quantities, seed costs, yield figures, or profit guarantees.
3. If irrigation or land conditions present a constraint, explain why gently and constructively.
4. Distinguish between crops supported by data and those requiring field adjustments.
5. Advise the farmer to consult their local DAE (উপজেলা কৃষি অফিস) Sub-Assistant Agriculture Officer (SAAO) for field-level seed selection and soil test fertilizer guidance.
6. No emojis, no markdown tables. Keep paragraphs natural and readable.

Farmer & Plot Context:
- District: ${evaluationResult.districtName} (${evaluationResult.districtCode})
- Upazila: ${farmerProfile.upazila || "Not specified"}
- Land Area: ${farmerProfile.land?.area || "N/A"} ${farmerProfile.land?.unit || "decimal"}
- Land Type: ${farmerProfile.land?.landType || "medium_high"}
- Irrigation Availability: ${farmerProfile.water?.irrigationAvailability || "available"}

Verified Eligible Crops from Official BAMIS / DAE Crop Calendars:
${evaluationResult.eligibleCrops
  .map(
    (c) => `
* ${c.cropNameEn} (${c.cropNameBn}) - Season: ${c.season} (~${c.totalDurationDays} days)
  - Official Planting Period: ${c.sowingPeriod}
  - Suitability Status: ${c.suitabilityCategory}
  - Key Agronomic Reasons: ${c.reasons.join("; ")}
  - Constraints/Cautions: ${c.constraints.length > 0 ? c.constraints.join("; ") : "None reported in calendar"}
`
  )
  .join("\n")}

NASA Environmental Satellite Context:
- Surface Soil Moisture (SMAP 0-5 cm): ${environmentalContext.soilMoistureProxy ? `${environmentalContext.soilMoistureProxy.value} m³/m³ (Date: ${environmentalContext.soilMoistureProxy.observedDate})` : "Archived regional baseline"}
- Regional Canopy Greenness (MODIS NDVI): ${environmentalContext.vegetationIndexProxy ? `${environmentalContext.vegetationIndexProxy.ndvi} (Date: ${environmentalContext.vegetationIndexProxy.observedDate})` : "Archived regional baseline"}
`;

      const geminiPromise = ai.models.generateContent({
        model: env.geminiModel || "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Gemini generation timed out after 7000ms")), 7000)
      );
      const response = await Promise.race([geminiPromise, timeoutPromise]);

      if (response && response.text) {
        geminiOutput = response.text.trim();
      }
    } catch (err) {
      console.warn(`[cropplanning.service] Gemini explanation failed, falling back to deterministic explanation: ${err.message}`);
    }
  }

  // Deterministic Grounded Fallback
  if (!geminiOutput) {
    if (isBangla) {
      const topCrops = evaluationResult.eligibleCrops.filter((c) => c.suitabilityCategory === "supported");
      const potentialCrops = evaluationResult.eligibleCrops.filter((c) => c.suitabilityCategory === "potential");

      let text = `আপনার ${evaluationResult.districtName} জেলার ${farmerProfile.upazila || ""} এলাকার জমির জন্য সরকারি বিএএমআইএস (BAMIS) ও ডিএই (DAE) ক্রপ ক্যালেন্ডার অনুযায়ী ফসলের উপযোগিতা যাচাই করা হয়েছে।\n\n`;

      if (topCrops.length > 0) {
        text += `বিদ্যমান তথ্যানুযায়ী সরাসরি উপযোগী ফসল:\n`;
        topCrops.forEach((c) => {
          text += `• ${c.cropNameBn} (${c.seasonBn}): রোপণের উপযুক্ত সময় ${c.sowingPeriod}। জীবনকাল প্রায় ${c.totalDurationDays} দিন। পানির চাহিদা প্রায় ${c.waterRequirementMmTotal} মিমি। ${c.reasons.join(" ")}\n`;
        });
        text += `\n`;
      }

      if (potentialCrops.length > 0) {
        text += `বিবেচনাধীন বিকল্পসমূহ:\n`;
        potentialCrops.forEach((c) => {
          text += `• ${c.cropNameBn}: ${c.constraints.join(" ")}\n`;
        });
        text += `\n`;
      }

      text += `পরিবেশগত সতর্কতা:\nনাসা এসএমএপি (NASA SMAP) অনুযায়ী মাটির উপরিভাগের (০-৫ সেমি) আর্দ্রতা এবং বিএএমআইএস আবহাওয়া সতর্কবার্তা অনুসারে জাত নির্বাচন করুন। রাসায়নিক সারের সঠিক মাত্রার জন্য স্থানীয় উপজেলা কৃষি কর্মকর্তা (DAE / SAAO)-এর পরামর্শ নিন।`;

      geminiOutput = text;
    } else {
      const topCrops = evaluationResult.eligibleCrops.filter((c) => c.suitabilityCategory === "supported");
      const potentialCrops = evaluationResult.eligibleCrops.filter((c) => c.suitabilityCategory === "potential");

      let text = `Based on official BAMIS and DAE agricultural crop calendars for ${evaluationResult.districtName} District (${farmerProfile.upazila || ""}), crop options have been evaluated:\n\n`;

      if (topCrops.length > 0) {
        text += `Directly Supported Options:\n`;
        topCrops.forEach((c) => {
          text += `• ${c.cropNameEn} (${c.season}): Recommended sowing period is ${c.sowingPeriod} with an estimated duration of ${c.totalDurationDays} days. Water demand is ~${c.waterRequirementMmTotal} mm. ${c.reasons.join(" ")}\n`;
        });
        text += `\n`;
      }

      if (potentialCrops.length > 0) {
        text += `Options with Field Considerations:\n`;
        potentialCrops.forEach((c) => {
          text += `• ${c.cropNameEn}: ${c.constraints.join(" ")}\n`;
        });
        text += `\n`;
      }

      text += `Environmental Context:\nNASA SMAP indicates regional top-soil moisture proxies. Consult your local DAE Upazila Agriculture Officer (SAAO) for soil test fertilizer dosages and certified seed selection.`;

      geminiOutput = text;
    }
  }

  return geminiOutput;
}
