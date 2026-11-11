/**
 * Krishi Mama AI Assistant — Chat Service.
 * Orchestrates conversational AI interactions, manages grounded tool dispatch,
 * extracts scientific provenance and quality flags, and maintains session safety.
 */

import crypto from "crypto";
import { geminiAssistantClient } from "./gemini.client.js";
import { toolExecutors } from "./tools.executor.js";
import { DISTRICTS } from "../../config/climate.config.js";

const VALID_DISTRICT_CODES = new Set(DISTRICTS.map((d) => d.code));

function isBanglaMessage(message) {
  return /[\u0980-\u09FF]/.test(message);
}

function getAnnualRainfallMean(rainfallData) {
  const value = rainfallData?.annualHistorical?.meanAnnualTotalMm;
  return Number.isFinite(value) ? value : null;
}

// Simple in-memory conversation memory with bounded size
const conversationStore = new Map();
const MAX_CONVERSATIONS = 100;

function getConversationHistory(conversationId) {
  if (!conversationId) return [];
  const session = conversationStore.get(conversationId);
  return session ? session.history : [];
}

function updateConversationHistory(conversationId, userText, assistantText) {
  if (!conversationId) return;
  let session = conversationStore.get(conversationId);
  if (!session) {
    if (conversationStore.size >= MAX_CONVERSATIONS) {
      const oldestKey = conversationStore.keys().next().value;
      conversationStore.delete(oldestKey);
    }
    session = { history: [], lastActive: Date.now() };
    conversationStore.set(conversationId, session);
  }
  session.history.push({ role: "user", parts: [{ text: userText }] });
  session.history.push({ role: "model", parts: [{ text: assistantText }] });
  // Keep only last 6 turns (3 round-trips)
  if (session.history.length > 6) {
    session.history = session.history.slice(-6);
  }
  session.lastActive = Date.now();
}

/**
 * Deterministic local fallback generator when Gemini API is unavailable or unconfigured.
 * Strictly uses real data from toolExecutors with zero hallucination.
 */
async function generateDeterministicFallback({ message, district = "cumilla", crop = null, farmId = null, userId = null }) {
  const normMessage = message.toLowerCase();
  const validDistrict = VALID_DISTRICT_CODES.has(district?.toLowerCase()) ? district.toLowerCase() : "cumilla";
  const executedTools = [];
  let answer = "";
  const sources = [];
  let dataDate = null;
  let dataQuality = "unknown";
  let language = "bn";
  const provenance = [];
  const limitations = [];

  // Farm-aware contextual fallback if farmId is provided
  if (farmId) {
    if (
      normMessage.includes("কাজ") ||
      normMessage.includes("কার্যক্রম") ||
      normMessage.includes("টাস্ক") ||
      normMessage.includes("task") ||
      normMessage.includes("activity") ||
      normMessage.includes("করণীয়") ||
      normMessage.includes("reminder") ||
      normMessage.includes("due date")
    ) {
      const actData = await toolExecutors.getMyFarmActivities({ farmId, userId });
      executedTools.push({ toolName: "getMyFarmActivities", result: actData });
      language = isBanglaMessage(message) ? "bn" : "en";

      if (actData.error) {
        answer = language === "bn"
          ? "আপনার খামারের কার্যক্রম এখন পাওয়া যাচ্ছে না। পরে আবার চেষ্টা করুন।"
          : "Your farm activities are currently unavailable. Please try again later.";
      } else {
        const pending = actData.activities.filter((a) => a.status === "PENDING" || a.status === "IN_PROGRESS");
        sources.push("Krishi Mama Farm Activity Tracker");
        sources.push("DAE & BAMIS Official Crop Calendar Schedule");
        dataQuality = "verified";
        provenance.push("My Farm Operational Registry");

        if (pending.length === 0) {
          answer = language === "bn"
            ? `আপনার খামার "${actData.farmName}"-এর জন্য বর্তমানে কোনো বকেয়া বা অপেক্ষমাণ কাজ নেই।`
            : `There are no pending or in-progress activities for your farm "${actData.farmName}".`;
        } else {
          const taskList = pending
            .slice(0, 5)
            .map((t, idx) => language === "bn"
              ? `${idx + 1}. ${t.title} (নির্ধারিত তারিখ: ${t.scheduledDate || "উল্লেখ নেই"}, অবস্থা: ${t.status === "IN_PROGRESS" ? "চলমান" : "অপেক্ষমাণ"})`
              : `${idx + 1}. ${t.title} (due: ${t.scheduledDate || "not specified"}, status: ${t.status === "IN_PROGRESS" ? "in progress" : "pending"})`)
            .join("\n");
          answer = language === "bn"
            ? `আপনার খামার "${actData.farmName}"-এর অপেক্ষমাণ কাজ:\n${taskList}\n\nকাজ সম্পন্ন হলে নিজে থেকে অবস্থা হালনাগাদ করুন।`
            : `Pending activities for your farm "${actData.farmName}":\n${taskList}\n\nUpdate an activity yourself after completing it.`;
        }
      }
      return {
        answer,
        executedTools,
        sources,
        dataDate,
        dataQuality,
        provenance,
        limitations: [language === "bn" ? "তালিকাটি সংরক্ষিত খামার কার্যক্রম থেকে এসেছে; এটি মাঠের বর্তমান অবস্থা যাচাই করে না।" : "This list comes from saved farm activities and does not verify current field conditions."],
        language,
        modelUsed: "deterministic-farm-grounded-engine",
      };
    }

    if (
      normMessage.includes("পর্যায়") ||
      normMessage.includes("বৃদ্ধি") ||
      normMessage.includes("growth") ||
      normMessage.includes("স্টেজ") ||
      normMessage.includes("stage") ||
      normMessage.includes("দিন") ||
      normMessage.includes("বয়স") ||
      normMessage.includes("lifecycle")
      || normMessage.includes("irrigat")
      || normMessage.includes("water requirement")
    ) {
      const lifeData = await toolExecutors.getMyFarmLifecycle({ farmId, userId });
      executedTools.push({ toolName: "getMyFarmLifecycle", result: lifeData });
      language = isBanglaMessage(message) ? "bn" : "en";

      if (lifeData.error) {
        answer = language === "bn"
          ? "আপনার খামারের ফসলের পর্যায় এখন নির্ধারণ করা যাচ্ছে না। রোপণের তারিখ ও ফসলের তথ্য যাচাই করুন।"
          : "The crop stage for your farm cannot currently be determined. Check the planting date and crop details.";
      } else {
        sources.push("BAMIS Agro-Meteorological Crop Calendar");
        sources.push("BRRI / BARI Research Bulletins");
        dataQuality = "verified";
        provenance.push(lifeData.provenance?.publisher || "BAMIS & DAE Official Crop Calendar");

        const cur = lifeData.currentStage;
        const nxt = lifeData.nextStage;
        const days = Number.isFinite(lifeData.daysSincePlanting) ? lifeData.daysSincePlanting : null;
        answer = language === "bn"
          ? `আপনার খামার "${lifeData.farmName}"-এর ফসলের পর্যায় (ক্যালেন্ডারভিত্তিক অনুমান):\n` +
            `- ফসল: ${lifeData.cropName || "উল্লেখ নেই"}${lifeData.season ? ` (${lifeData.season})` : ""}\n` +
            `- রোপণের তারিখ: ${lifeData.plantingDate || "উল্লেখ নেই"}\n` +
            `- রোপণের পর দিন: ${days == null ? "নির্ধারণ করা যায়নি" : `${days} দিন`}\n` +
            (cur ? `- বর্তমান পর্যায়: ${cur.stageNameBn || cur.stageNameEn}\n  - আনুমানিক তারিখ: ${cur.estimatedStartDate || "উল্লেখ নেই"} থেকে ${cur.estimatedEndDate || "উল্লেখ নেই"}\n` : "- বর্তমান পর্যায় নির্ধারণ করা যায়নি।\n") +
            (nxt ? `- পরবর্তী পর্যায়: ${nxt.stageNameBn || nxt.stageNameEn} (আনুমানিক ${nxt.estimatedStartDate || "তারিখ নেই"})\n` : "") +
            "\nতারিখগুলো ক্যালেন্ডারভিত্তিক অনুমান; মাঠের ফসল দেখে মিলিয়ে নিন।"
          : `Crop stage for your farm "${lifeData.farmName}" (calendar-based estimate):\n` +
            `- Crop: ${lifeData.cropName || "not specified"}${lifeData.season ? ` (${lifeData.season})` : ""}\n` +
            `- Planting date: ${lifeData.plantingDate || "not specified"}\n` +
            `- Days since planting: ${days == null ? "unavailable" : days}\n` +
            (cur ? `- Current stage: ${cur.stageNameEn || cur.stageNameBn}\n  - Estimated dates: ${cur.estimatedStartDate || "not specified"} to ${cur.estimatedEndDate || "not specified"}\n` : "- Current stage could not be determined.\n") +
            (nxt ? `- Next stage: ${nxt.stageNameEn || nxt.stageNameBn} (estimated ${nxt.estimatedStartDate || "date unavailable"})\n` : "") +
            "\nDates are calendar-based estimates; compare them with the crop in the field.";
      }
      return {
        answer,
        executedTools,
        sources,
        dataDate,
        dataQuality,
        provenance,
        limitations: [language === "bn" ? "পর্যায় ও তারিখ ক্যালেন্ডারভিত্তিক অনুমান; এগুলো মাঠ পর্যবেক্ষণের বিকল্প নয়।" : "Stages and dates are calendar-based estimates, not a substitute for field observation."],
        language,
        modelUsed: "deterministic-farm-grounded-engine",
      };
    }

    if (
      normMessage.includes("পরিবেশ") ||
      normMessage.includes("আর্দ্রতা") ||
      normMessage.includes("সবুজতা") ||
      normMessage.includes("স্যাটেলাইট") ||
      normMessage.includes("আবহাওয়া") ||
      normMessage.includes("environment") ||
      normMessage.includes("soil moisture") ||
      normMessage.includes("vegetation") ||
      normMessage.includes("satellite") ||
      normMessage.includes("climate") ||
      normMessage.includes("rainfall") ||
      normMessage.includes("weather") ||
      normMessage.includes("ndvi") ||
      normMessage.includes("evi")
    ) {
      const envData = await toolExecutors.getMyFarmEnvironmentalContext({ farmId, userId });
      executedTools.push({ toolName: "getMyFarmEnvironmentalContext", result: envData });
      language = isBanglaMessage(message) ? "bn" : "en";

      if (envData.error) {
        answer = language === "bn"
          ? "এই খামারের পরিবেশগত উপাত্ত এখন পাওয়া যাচ্ছে না। পরে আবার চেষ্টা করুন।"
          : "Environmental observations for this farm are currently unavailable. Please try again later.";
      } else {
        sources.push("NASA GPM IMERG Final V07", "NASA SMAP (SPL3SMP_E)", "NASA MODIS (MOD13Q1)", "NASA POWER (2001-2025)");
        dataDate = envData.environmentalContext?.precipitation?.observationDate || envData.environmentalContext?.soilMoistureSurface?.date || null;
        dataQuality = "grounded";
        provenance.push("NASA Earth Science Data Systems");
        limitations.push(envData.scientificSafeguards.rootZoneDisclaimer);
        limitations.push(envData.scientificSafeguards.vegetationDisclaimer);
        limitations.push(envData.scientificSafeguards.rainfallDisclaimer);

        const sm = envData.environmentalContext?.soilMoistureSurface;
        const veg = envData.environmentalContext?.vegetationIndex;
        const clim = envData.environmentalContext?.climateBaseline;
        const gpm = envData.environmentalContext?.precipitation;
        const dailyRain = gpm?.dailySummary;
        const smValue = Number.isFinite(sm?.soilMoisture) ? sm.soilMoisture.toFixed(4) + " m³/m³" : language === "bn" ? "উপাত্ত অনুপলব্ধ" : "unavailable";
        const smQuality = sm?.retrievalQualityFlag ?? (language === "bn" ? "অজানা" : "unknown");
        const vegValue = Number.isFinite(veg?.ndvi) ? veg.ndvi.toFixed(3) : language === "bn" ? "উপাত্ত অনুপলব্ধ" : "unavailable";
        const vegEvi = Number.isFinite(veg?.evi) ? veg.evi.toFixed(3) : language === "bn" ? "উপাত্ত অনুপলব্ধ" : "unavailable";
        const climateRain = Number.isFinite(clim?.annualRainfallTotalMm) ? clim.annualRainfallTotalMm : null;
        const validIntervals = Number.isInteger(dailyRain?.validIntervals) ? dailyRain.validIntervals : null;
        const noDate = language === "bn" ? "তারিখ অনুপলব্ধ" : "date unavailable";
        const dailyRainValue = dailyRain?.completeness === "complete" && dailyRain.validIntervals === 48
          ? language === "bn" ? `${dailyRain.totalPrecipitationMm} মিমি` : `${dailyRain.totalPrecipitationMm} mm`
          : language === "bn" ? "অসম্পূর্ণ বা অনুপস্থিত; মোট প্রকাশ করা হয়নি" : "incomplete or unavailable; total withheld";
        const intervalText = validIntervals == null
          ? (language === "bn" ? "বৈধ ব্যবধানের সংখ্যা অনুপলব্ধ" : "valid interval count unavailable")
          : language === "bn" ? `${validIntervals}/48 বৈধ ব্যবধান` : `${validIntervals}/48 valid intervals`;

        answer = language === "bn"
          ? `আপনার খামার "${envData.farmName}" (${envData.district}${envData.upazila ? `, ${envData.upazila}` : ""})-এর জন্য উপলভ্য নাসা পর্যবেক্ষণ:\n` +
            `- GPM IMERG Final V07 বৃষ্টি: ${dailyRainValue}; ${dailyRain?.dateLabel || noDate}; ${intervalText}।\n` +
            `- SMAP উপরিভাগের আর্দ্রতা (০–৫ সেমি): ${smValue}; ${sm?.date || noDate}; মান পতাকা ${smQuality}, গুণমান ${sm?.qualityClassification || "অজানা"}।\n` +
            `- MODIS উদ্ভিদ সূচক: NDVI ${vegValue}, EVI ${vegEvi}; ${veg?.date || noDate}; গুণমান ${veg?.qualityClassification || "অজানা"}।\n` +
            `- NASA POWER ঐতিহাসিক জলবায়ু: বার্ষিক বৃষ্টির মান ${climateRain == null ? "উপাত্ত অনুপলব্ধ" : `${climateRain} মিমি`}। এটি লাইভ আবহাওয়া নয়।\n\n` +
            "GPM, SMAP ও MODIS আঞ্চলিক স্যাটেলাইট গ্রিডের তথ্য, খামারের সরাসরি সেন্সর নয়। SMAP মূল অঞ্চলের আর্দ্রতা দেখায় না; NDVI/EVI রোগ নির্ণয় নয়।"
          : `Available NASA observations for your farm "${envData.farmName}" (${envData.district}${envData.upazila ? `, ${envData.upazila}` : ""}):\n` +
            `- GPM IMERG Final V07 rainfall: ${dailyRainValue}; ${dailyRain?.dateLabel || noDate}; ${intervalText}.\n` +
            `- SMAP surface moisture (0–5 cm): ${smValue}; ${sm?.date || noDate}; flag ${smQuality}, quality ${sm?.qualityClassification || "unknown"}.\n` +
            `- MODIS vegetation indices: NDVI ${vegValue}, EVI ${vegEvi}; ${veg?.date || noDate}; quality ${veg?.qualityClassification || "unknown"}.\n` +
            `- NASA POWER historical climate: annual rainfall ${climateRain == null ? "unavailable" : `${climateRain} mm`}; this is not live weather.\n\n` +
            "GPM, SMAP, and MODIS are regional satellite-grid products, not direct farm sensors. SMAP does not represent root-zone moisture, and NDVI/EVI are not disease diagnoses.";
      }
      return {
        answer,
        executedTools,
        sources,
        dataDate,
        dataQuality,
        provenance,
        limitations,
        language,
        modelUsed: "deterministic-farm-grounded-engine",
      };
    }

    if (
      normMessage.includes("খামার") ||
      normMessage.includes("জমি") ||
      normMessage.includes("বিবরণ") ||
      normMessage.includes("ফার্ম") ||
      normMessage.includes("farm")
    ) {
      const farmData = await toolExecutors.getMyFarmDetails({ farmId, userId });
      executedTools.push({ toolName: "getMyFarmDetails", result: farmData });
      language = isBanglaMessage(message) ? "bn" : "en";

      if (farmData.error) {
        answer = language === "bn"
          ? "আপনার খামারের বিবরণ এখন পাওয়া যাচ্ছে না।"
          : "Your farm details are currently unavailable.";
      } else {
        sources.push("Krishi Mama My Farm Registry");
        dataQuality = "verified";
        provenance.push("Farmer Authenticated Profile");

        const unavailable = language === "bn" ? "উল্লেখ নেই" : "not specified";
        answer = language === "bn"
          ? `আপনার খামারের সংরক্ষিত বিবরণ:\n` +
            `- নাম: ${farmData.name || unavailable}\n` +
            `- অবস্থান: ${farmData.districtName || farmData.districtCode || unavailable}${farmData.upazila ? `, ${farmData.upazila}` : ""}\n` +
            `- ফসল: ${farmData.cropName || farmData.cropCode || unavailable}\n` +
            `- জাত: ${farmData.variety && farmData.variety !== "Not specified" ? farmData.variety : unavailable}\n` +
            `- জমির আয়তন: ${farmData.landArea == null ? unavailable : `${farmData.landArea} ${farmData.landUnit || ""}`}\n` +
            `- মাটির ধরন: ${farmData.soilType || unavailable}\n` +
            `- সেচের উৎস: ${farmData.waterSource || unavailable}\n` +
            `- রোপণের তারিখ: ${farmData.plantingDate || unavailable}`
          : `Saved details for your farm:\n` +
            `- Name: ${farmData.name || unavailable}\n` +
            `- Location: ${farmData.districtName || farmData.districtCode || unavailable}${farmData.upazila ? `, ${farmData.upazila}` : ""}\n` +
            `- Crop: ${farmData.cropName || farmData.cropCode || unavailable}\n` +
            `- Variety: ${farmData.variety && farmData.variety !== "Not specified" ? farmData.variety : unavailable}\n` +
            `- Area: ${farmData.landArea == null ? unavailable : `${farmData.landArea} ${farmData.landUnit || ""}`}\n` +
            `- Soil: ${farmData.soilType || unavailable}\n` +
            `- Water source: ${farmData.waterSource || unavailable}\n` +
            `- Planting date: ${farmData.plantingDate || unavailable}`;
      }
      return {
        answer,
        executedTools,
        sources,
        dataDate,
        dataQuality,
        provenance,
        limitations: [language === "bn" ? "তথ্যগুলো আপনার সংরক্ষিত খামার প্রোফাইল থেকে এসেছে।" : "Details come from your saved farm profile."],
        language,
        modelUsed: "deterministic-farm-grounded-engine",
      };
    }
  }

  // Weather Forecast, Alert, or Outlook queries
  if (
    normMessage.includes("পূর্বাভাস") ||
    normMessage.includes("forecast") ||
    normMessage.includes("আবহাওয়া") ||
    normMessage.includes("weather") ||
    normMessage.includes("seasonal") ||
    normMessage.includes("outlook") ||
    normMessage.includes("সাব-সিজন") ||
    normMessage.includes("মৌসুমি") ||
    normMessage.includes("মৌসুমী") ||
    normMessage.includes("সপ্তাহ") ||
    normMessage.includes("মাসিক") ||
    normMessage.includes("সতর্কতা") ||
    normMessage.includes("alert") ||
    normMessage.includes("warning") ||
    normMessage.includes("ঝড়") ||
    normMessage.includes("কালবৈশাখী") ||
    normMessage.includes("তাপদাহ") ||
    normMessage.includes("শৈত্যপ্রবাহ")
  ) {
    let targetLoc = validDistrict || "Chattogram";
    for (const div of ["dhaka", "chattogram", "sylhet", "rajshahi", "khulna", "barishal", "rangpur", "mymensingh", "cumilla"]) {
      if (normMessage.includes(div)) {
        targetLoc = div;
        break;
      }
    }

    const isBangla = /[\u0980-\u09FF]/.test(message);
    const forecastData = await toolExecutors.getLocationWeatherForecast({ location: targetLoc, farmId, userId })
      .catch(() => ({ error: "WEATHER_UNAVAILABLE", current: null, location: null }));
    const alertsData = await toolExecutors.getActiveWeatherAlerts({ location: targetLoc, crop, farmId, userId })
      .catch(() => ({ error: "WEATHER_RISK_UNAVAILABLE", overallRiskLevel: "DATA_INSUFFICIENT", alertsCount: 0, officialWarningsCount: 0, alerts: [] }));
    executedTools.push({ toolName: "getLocationWeatherForecast", result: forecastData });
    executedTools.push({ toolName: "getActiveWeatherAlerts", result: alertsData });

    const wantsWeeklyOutlook = /week|weekly|সপ্তাহ|সাব-সিজন/.test(normMessage);
    const wantsSeasonalOutlook = /season|monthly|month|মৌসুম|মাসিক/.test(normMessage);
    let weeklyOutlookData = null;
    let seasonalOutlookData = null;
    if (wantsWeeklyOutlook || wantsSeasonalOutlook) {
      const [weeklyResult, seasonalResult] = await Promise.all([
        wantsWeeklyOutlook
          ? toolExecutors.getWeeklyWeatherOutlook({ location: targetLoc, farmId, userId }).catch(() => ({ dataStatus: "DATA_UNAVAILABLE", weeklyTendencies: [] }))
          : Promise.resolve(null),
        wantsSeasonalOutlook
          ? toolExecutors.getSeasonalCropOutlook({ location: targetLoc, crop, farmId, userId }).catch(() => ({ dataStatus: "DATA_UNAVAILABLE", monthlyOutlooks: [] }))
          : Promise.resolve(null),
      ]);
      weeklyOutlookData = weeklyResult;
      seasonalOutlookData = seasonalResult;
      if (weeklyResult) {
        executedTools.push({ toolName: "getWeeklyWeatherOutlook", result: weeklyResult });
        sources.push(weeklyResult.source || "Open-Meteo Seasonal Forecast API");
        if (weeklyResult.disclaimer) limitations.push(weeklyResult.disclaimer);
      }
      if (seasonalResult) {
        executedTools.push({ toolName: "getSeasonalCropOutlook", result: seasonalResult });
        sources.push(seasonalResult.source || "Open-Meteo Seasonal Forecast API");
        if (seasonalResult.guidanceNotice) limitations.push(seasonalResult.guidanceNotice);
      }
      provenance.push("Open-Meteo Seasonal Forecast API; periods are regional outlooks, not local daily forecasts");
    }

    sources.push("Open-Meteo Weather Forecast API");
    const hasOfficialBulletins = (alertsData.officialWarningsCount > 0) ||
      (Array.isArray(alertsData.alerts) && alertsData.alerts.some(a => a.isGovernmentNotice));
    if (hasOfficialBulletins) {
      const authorities = [...new Set((alertsData.alerts || [])
        .filter(alert => alert.isGovernmentNotice && alert.issuingAuthority)
        .map(alert => alert.issuingAuthority))];
      sources.push(...(authorities.length
        ? authorities.map(authority => `Verified government warning: ${authority}`)
        : ["Verified government warnings"]));
    }

    const cur = forecastData.current;
    const locNameEn = forecastData.location?.nameEn || targetLoc;
    const locNameBn = forecastData.location?.nameBn || locNameEn;
    const alertCount = alertsData.alertsCount || 0;
    const overallRisk = alertsData.overallRiskLevel || "DATA_INSUFFICIENT";
    const isDataInsufficient = overallRisk === "DATA_INSUFFICIENT" || !cur || forecastData.error;

    dataDate = cur?.date || null;
    dataQuality = isDataInsufficient ? "insufficient_data" : "verified";
    provenance.push("Open-Meteo Forecast API (Asia/Dhaka) & Krishi Mama agricultural risk criteria");
    if (alertsData.officialWarningsStatus === "UNAVAILABLE") {
      limitations.push(isBangla
        ? "সরকারি সতর্কতার তথ্যভান্ডার অনুপলব্ধ; কোনো বুলেটিন না ফেরাকে সতর্কতা নেই বলে ধরে নেবেন না।"
        : "Official warning store unavailable; an empty result must not be interpreted as no government warning.");
    }
    limitations.push(
      isBangla
        ? "১-৭ দিনের পূর্বাভাস সংখ্যাভিত্তিক আবহাওয়া মডেলের ওপর ভিত্তি করে তৈরি। বর্ধিত ও মৌসুমী দৃষ্টিভঙ্গিতে স্বাভাবিক অনিশ্চয়তা রয়েছে।"
        : "1–7 day forecasts are based on deterministic numerical weather prediction models; extended horizons carry elevated uncertainty."
    );

    let weatherSummary;

    if (isDataInsufficient) {
      if (isBangla) {
        weatherSummary = `**${locNameBn}-এর আবহাওয়া উপাত্ত:**\n` +
          `সতর্কতা: এই এলাকার জন্য পর্যাপ্ত আবহাওয়া পূর্বাভাস বা ঝুঁকি উপাত্ত বর্তমানে অনুপলব্ধ।\n` +
          `- সামগ্রিক কৃষি ঝুঁকি: উপাত্ত অপর্যাপ্ত (অজানা)\n` +
          `- পরিস্থিতি: প্রয়োজনীয় উপাত্তের অনুপস্থিতিতে আনুমানিক বা কাল্পনিক ঝুঁকি স্তর নির্ধারণ করা বিজ্ঞানসম্মত নয়।\n` +
          `- পরামর্শ: স্প্রে বা সেচের মতো স্পর্শকাতর কৃষিকাজ পরিচালনার আগে স্থানীয় কৃষি কর্মকর্তা বা বিশ্বস্ত আবহাওয়া পর্যবেক্ষকের পরামর্শ নিন।`;
      } else {
        weatherSummary = `**Weather Intelligence for ${locNameEn}:**\n` +
          `Unavailable: Sufficient weather forecast or agronomic risk observations are currently unavailable for this location.\n` +
          `- Overall Agricultural Risk: DATA INSUFFICIENT (UNKNOWN)\n` +
          `- Status: Risk levels and operational safety cannot be safely evaluated without verified provider observations.\n` +
          `- Guidance: Please consult local agricultural extension officers before scheduling chemical spraying or harvesting.`;
      }
    } else {
      const conditionStr = cur.conditionEn || (isBangla ? "তথ্য পাওয়া যায়নি" : "Data unavailable");
      const riskLabelBn = overallRisk === "SEVERE"
        ? "তীব্র (SEVERE)"
        : overallRisk === "HIGH"
        ? "উচ্চ (HIGH)"
        : overallRisk === "MODERATE"
        ? "মাঝারি (MODERATE)"
        : "স্বাভাবিক / কম (LOW)";
      const riskLabelEn = overallRisk;

      const hasRainMetric = typeof cur.todayRainExpectedMm === "number" && Number.isFinite(cur.todayRainExpectedMm);
      const hasRainProb = typeof cur.todayRainProbabilityPercent === "number" && Number.isFinite(cur.todayRainProbabilityPercent);
      const hasWindMetric = typeof cur.maxWindSpeedKmH === "number" && Number.isFinite(cur.maxWindSpeedKmH);

      const rainStrEn = hasRainMetric ? `${cur.todayRainExpectedMm} mm` : "Not observed";
      const rainProbStrEn = hasRainProb ? `${cur.todayRainProbabilityPercent}%` : "Not available";
      const windStrEn = hasWindMetric ? `${cur.maxWindSpeedKmH} km/h` : "Not observed";

      const rainStrBn = hasRainMetric ? `${cur.todayRainExpectedMm} মিমি` : "উপাত্ত নেই";
      const rainProbStrBn = hasRainProb ? `${cur.todayRainProbabilityPercent}%` : "অনুপলব্ধ";
      const windStrBn = hasWindMetric ? `${cur.maxWindSpeedKmH} কিমি/ঘণ্টা` : "উপাত্ত নেই";

      if (isBangla) {
        weatherSummary = `**${locNameBn}-এর আবহাওয়া পূর্বাভাস ও কৃষি সতর্কতা:**\n` +
          `- আজকের পূর্বাভাস: ${conditionStr} (সর্বোচ্চ: ${cur.temperatureMaxC}°সে, সর্বনিম্ন: ${cur.temperatureMinC}°সে)\n` +
          `- আজকের সম্ভাব্য বৃষ্টি: ${rainStrBn} (সম্ভাবনা: ${rainProbStrBn})\n` +
          `- বাতাসের গতি: ${windStrBn}\n` +
          `- সামগ্রিক কৃষি ঝুঁকি: ${riskLabelBn}\n`;

        if (alertCount > 0) {
          weatherSummary += `\n**সক্রিয় কৃষি সতর্কতা (${alertCount}টি):**\n`;
          alertsData.alerts.slice(0, 3).forEach((a, i) => {
            const sourceBadge = a.isGovernmentNotice
              ? `[যাচাইকৃত সরকারি বুলেটিন: ${a.issuingAuthority || "সরকারি কর্তৃপক্ষ"}]`
              : "[পূর্বাভাসভিত্তিক কৃষি সতর্কতা]";
            weatherSummary += `${i + 1}. ${sourceBadge} **${a.titleBn || a.title}**\n   পরামর্শ: ${a.adviceBn || a.advice}\n`;
          });
        } else {
          weatherSummary += alertsData.officialWarningsStatus === "UNAVAILABLE"
            ? `\nসরকারি সতর্কতার তথ্যভান্ডার অনুপলব্ধ; সরকারি সতর্কতা যাচাই করা যায়নি।`
            : `\nবর্তমান প্রাপ্ত ৭ দিনের পূর্বাভাসের ভিত্তিতে কোনো সক্রিয় উচ্চ বা তীব্র কৃষি আবহাওয়া সতর্কতা নেই।`;
        }

        if (alertsData.precautions && alertsData.precautions.length > 0) {
          weatherSummary += `\n**মাঠ পর্যায়ের কৃষিজ পরামর্শ:**\n` + alertsData.precautions.slice(0, 2).map(p => `- ${p}`).join("\n");
        }
      } else {
        weatherSummary = `**Weather Forecast & Agricultural Risks for ${locNameEn}:**\n` +
          `- Today's forecast: ${conditionStr} (Max: ${cur.temperatureMaxC}°C, Min: ${cur.temperatureMinC}°C)\n` +
          `- Expected Rain Today: ${rainStrEn} (Probability: ${rainProbStrEn})\n` +
          `- Peak Wind Speed: ${windStrEn}\n` +
          `- Overall Agricultural Risk: ${riskLabelEn}\n`;

        if (alertCount > 0) {
          weatherSummary += `\n**Active Weather & Risk Alerts (${alertCount}):**\n`;
          alertsData.alerts.slice(0, 3).forEach((a, i) => {
            const sourceBadge = a.isGovernmentNotice
              ? `[Verified Government Warning: ${a.issuingAuthority || "Government authority"}]`
              : "[Forecast Risk Alert]";
            weatherSummary += `${i + 1}. ${sourceBadge} **${a.title}**\n   Advice: ${a.advice}\n`;
          });
        } else {
          weatherSummary += alertsData.officialWarningsStatus === "UNAVAILABLE"
            ? `\nThe official warning store is unavailable; government warnings could not be checked.`
            : `\nNo active high or severe agricultural weather hazards indicated in the current 7-day forecast.`;
        }

        if (alertsData.precautions && alertsData.precautions.length > 0) {
          weatherSummary += `\n**Field Operational Guidance:**\n` + alertsData.precautions.slice(0, 2).map(p => `- ${p}`).join("\n");
        }
      }
    }

    const farmContext = alertsData.farmContext || forecastData.farmContext;
    if (farmContext) {
      const cropStage = farmContext.cropStage
        ? (isBangla ? farmContext.cropStage.stageNameBn : farmContext.cropStage.stageNameEn)
        : (isBangla ? "পর্যায় নির্ধারিত নয়" : "stage unavailable");
      const farmLine = isBangla
        ? `খামারভিত্তিক প্রসঙ্গ: ${farmContext.farmName || "নামহীন খামার"} · ${farmContext.upazila || ""}, ${farmContext.district || farmContext.districtCode || locNameBn}; নির্বাচিত ফসল ${farmContext.cropCode || "নির্বাচিত হয়নি"}; পর্যায় ${cropStage}${farmContext.cropStage ? " (সরকারি ক্যালেন্ডার থেকে আনুমানিক)" : ""}. আবহাওয়া আঞ্চলিক গ্রিডের তথ্য, খামার-পর্যায়ের পরিমাপ নয়।\n\n`
        : `Farm context: ${farmContext.farmName || "Unnamed farm"} · ${farmContext.upazila || ""}, ${farmContext.district || farmContext.districtCode || locNameEn}; selected crop ${farmContext.cropCode || "not selected"}; stage ${cropStage}${farmContext.cropStage ? " (estimated from the official calendar)" : ""}. Weather is regional grid data, not a farm-level measurement.\n\n`;
      weatherSummary = `${farmLine}${weatherSummary}`;
    }

    if (weeklyOutlookData || seasonalOutlookData) {
      const periodLines = [];
      if (weeklyOutlookData) {
        const available = (weeklyOutlookData.weeklyTendencies || []).filter(period => period.status === "AVAILABLE");
        periodLines.push(isBangla ? "\n৬-সপ্তাহের আঞ্চলিক দৃষ্টিভঙ্গি:" : "\nSix-week regional outlook:");
        if (!available.length) {
          periodLines.push(isBangla ? "- উপাত্ত অপ্রাপ্য; কোনো মান অনুমান করা হয়নি।" : "- Unavailable; no values were inferred.");
        } else {
          for (const week of available) {
            const rainfall = Number.isFinite(week.expectedRainfallMeanMm)
              ? `${week.expectedRainfallMeanMm} mm (${week.rainfallRangeMm?.min ?? "—"}–${week.rainfallRangeMm?.max ?? "—"} mm)`
              : (isBangla ? "বৃষ্টি অনুপলব্ধ" : "rain unavailable");
            periodLines.push(`- ${week.week}: ${rainfall}${Number.isFinite(week.expectedTempMeanC) ? `; ${week.expectedTempMeanC}°C mean` : ""}.`);
          }
        }
      }
      if (seasonalOutlookData) {
        const available = (seasonalOutlookData.monthlyOutlooks || []).filter(period => period.status === "AVAILABLE");
        periodLines.push(isBangla ? "\n১–৩ মাসের আঞ্চলিক দৃষ্টিভঙ্গি:" : "\nOne-to-three-month regional outlook:");
        if (!available.length) {
          periodLines.push(isBangla ? "- উপাত্ত অপ্রাপ্য; কোনো মান অনুমান করা হয়নি।" : "- Unavailable; no values were inferred.");
        } else {
          for (const month of available) {
            const rainfall = Number.isFinite(month.rainfallMeanMm)
              ? `${month.rainfallMeanMm} mm (${month.rainfallRangeMm?.min ?? "—"}–${month.rainfallRangeMm?.max ?? "—"} mm)`
              : (isBangla ? "বৃষ্টি অনুপলব্ধ" : "rain unavailable");
            periodLines.push(`- ${month.window}: ${rainfall}${Number.isFinite(month.temperatureMeanC) ? `; ${month.temperatureMeanC}°C mean` : ""}.`);
          }
        }
      }
      periodLines.push(isBangla
        ? "এগুলো Open-Meteo-এর আঞ্চলিক মডেল দৃষ্টিভঙ্গি; খামারভিত্তিক পূর্বাভাস বা ক্যালিব্রেটেড সম্ভাব্যতা নয়।"
        : "These are regional Open-Meteo model outlooks, not farm-level forecasts or calibrated probabilities.");
      weatherSummary += `\n${periodLines.join("\n")}`;
    }

    return {
      answer: weatherSummary,
      language: isBangla ? "bn" : "en",
      executedTools,
      sources,
      dataDate: dataDate || null,
      dataQuality,
      provenance,
      limitations,
      modelUsed: "deterministic-weather-grounded-engine",
    };
  }

  // 0. Check for Unsupported District or Crop in user query text
  const UNSUPPORTED_DISTRICTS_BN = ["রংপুর", "সিলেট", "রাজশাহী", "ঢাকা", "বরিশাল", "খুলনা", "ময়মনসিংহ", "বগুড়া", "দিনাজপুর", "যশোর", "পাবনা", "কুষ্টিয়া"];
  const UNSUPPORTED_CROPS_BN = ["গম", "ভুট্টা", "আলু", "পাট", "তুলা", "ডাল", "পেঁয়াজ"];

  const foundUnsupportedDistrict = UNSUPPORTED_DISTRICTS_BN.find((d) => normMessage.includes(d));
  const foundUnsupportedCrop = UNSUPPORTED_CROPS_BN.find((c) => normMessage.includes(c));

  if (foundUnsupportedDistrict || (foundUnsupportedCrop && !normMessage.includes("সরিষা") && !normMessage.includes("আমন") && !normMessage.includes("বোরো") && !normMessage.includes("আউশ"))) {
    const unsuppParts = [];
    if (foundUnsupportedDistrict) unsuppParts.push(`${foundUnsupportedDistrict} জেলা`);
    if (foundUnsupportedCrop) unsuppParts.push(`${foundUnsupportedCrop} ফসল`);
    const unsuppName = unsuppParts.join(" ও ");

    answer = `বর্তমানে কৃষি মামা সিস্টেমে কেবল 'কুমিল্লা' এবং 'চট্টগ্রাম' জেলার উপাত্ত এবং রোপা আমন, বোরো ধান, আউশ ধান ও সরিষা ফসলের সরকারি শস্যপঞ্জিকা যাচাইকৃত রয়েছে।\n\n` +
      `${unsuppName}-এর উপাত্ত বর্তমানে আমাদের গবেষণায় অন্তর্ভুক্ত নয়। কোনো কাল্পনিক বা অনুমাননির্ভর উপাত্ত তৈরি না করে, আমরা কেবল যাচাইকৃত উপাত্ত প্রদানে দায়বদ্ধ। অনুগ্রহ করে কুমিল্লা বা চট্টগ্রাম জেলার অনুমোদিত ফসল সম্পর্কে প্রশ্ন করুন।`;

    sources.push("BBS / Krishi Mama Supported District Registry");
    dataDate = "Active Registry";
    dataQuality = "district_unsupported";
    provenance.push("Administrative boundary & crop scope filter");
    limitations.push("Only Cumilla (BD2019) and Chattogram (BD2015) are actively validated.");

    return {
      answer,
      executedTools,
      sources,
      dataDate,
      dataQuality,
      provenance,
      limitations,
      modelUsed: "deterministic-grounded-engine",
    };
  }

  const isPowerQuery = normMessage.includes("nasa power") || normMessage.includes("power");
  const unsupportedPowerTerms = ["ozone", "wind", "pressure", "evapotranspiration", "uv index", "ওজোন", "বায়ুচাপ", "বাতাসের গতি"];
  const unsupportedPowerTerm = unsupportedPowerTerms.find((term) => normMessage.includes(term));
  if (isPowerQuery && unsupportedPowerTerm) {
    const isBangla = isBanglaMessage(message);
    answer = isBangla
      ? `NASA POWER-এর ${unsupportedPowerTerm} বিষয়ে এই সহকারীর যাচাইকৃত query নেই। কোনো মান অনুমান করা হচ্ছে না।`
      : `The deterministic assistant has no verified NASA POWER query for ${unsupportedPowerTerm}. No value is inferred.`;
    dataDate = null;
    dataQuality = "unsupported_parameter";
    sources.push("NASA POWER parameter scope");
    provenance.push("Deterministic assistant capability registry");
    limitations.push("Only implemented and validated parameter queries are answered by the deterministic fallback.");
    return {
      answer,
      executedTools,
      sources,
      dataDate,
      dataQuality,
      provenance,
      limitations,
      language: isBangla ? "bn" : "en",
      modelUsed: "deterministic-grounded-engine",
    };
  }

  // 0b. Check for Real-time Weather Forecasting Refusal (আজ বৃষ্টি / কাল বৃষ্টি / আবহাওয়া পূর্বাভাস)
  if (normMessage.includes("আজ বৃষ্টি") || normMessage.includes("আজকে বৃষ্টি") || normMessage.includes("কাল বৃষ্টি") || normMessage.includes("আজকের বৃষ্টি") || normMessage.includes("পূর্বাভাস") || normMessage.includes("লাইভ বৃষ্টি") || normMessage.includes("will it rain today") || normMessage.includes("weather forecast") || normMessage.includes("live weather")) {
    const rainfallData = await toolExecutors.getClimateRainfall({ district: validDistrict, grouping: "annual" });
    executedTools.push({ toolName: "getClimateRainfall", result: rainfallData });

    sources.push("NASA POWER Daily Point (2001-2025)");
    dataDate = "2001-2025";
    dataQuality = "satellite_reanalysis";
    provenance.push("NASA POWER Daily Historical Climate Grid");
    limitations.push("নাসা পাওয়ার জলবায়ু পুনর্বিশ্লেষণ উপাত্ত কেবল দীর্ঘমেয়াদী ঐতিহাসিক স্বাভাবিকতা নির্দেশ করে, এটি তাৎক্ষণিক দৈনিক আবহাওয়া পূর্বাভাস নয়।");

    const districtBn = validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম";
    const meanMm = getAnnualRainfallMean(rainfallData);
    language = isBanglaMessage(message) ? "bn" : "en";
    if (meanMm == null) {
      dataQuality = "unavailable";
      dataDate = null;
    }

    answer = language === "bn"
      ? `NASA POWER-এর সংরক্ষিত ঐতিহাসিক জলবায়ু উপাত্ত আজকের লাইভ আবহাওয়া বা পূর্বাভাস নয়। আজকের পূর্বাভাসের জন্য বাংলাদেশ আবহাওয়া অধিদপ্তর (BMD) দেখুন।\n\n` +
        (meanMm == null ? `${districtBn} জেলার যাচাইকৃত ঐতিহাসিক বার্ষিক বৃষ্টিপাতের গড় পাওয়া যায়নি; কোনো মান অনুমান করা হচ্ছে না।` : `NASA POWER-এর ২০০১–২০২৫ ঐতিহাসিক রেকর্ডে ${districtBn} জেলার গড় বার্ষিক বৃষ্টিপাত ${meanMm.toFixed(2)} মিমি।`)
      : `NASA POWER provides archived climate observations, not today's live weather or a forecast. Check the Bangladesh Meteorological Department (BMD) for today's forecast.\n\n` +
        (meanMm == null ? `A verified historical annual rainfall mean is unavailable for ${validDistrict}; no value is inferred.` : `In NASA POWER's 2001–2025 historical record, mean annual rainfall for ${validDistrict} is ${meanMm.toFixed(2)} mm.`);

    return {
      answer,
      executedTools,
      sources,
      dataDate,
      dataQuality,
      provenance,
      limitations,
      language,
      modelUsed: "deterministic-grounded-engine",
    };
  }

  // 0c. Check for Historical vs Live Question (লাইভ অবস্থা / আজকের লাইভ / ঐতিহাসিক বনাম লাইভ)
  if (normMessage.includes("লাইভ অবস্থা") || normMessage.includes("আজকের অবস্থা") || normMessage.includes("লাইভ পরিস্থিতি") || normMessage.includes("লাইভ তথ্য")) {
    sources.push("NASA Earth Science Data Systems (SMAP / MODIS / POWER)");
    dataDate = "2001-2025";
    dataQuality = "historical_satellite_record";
    provenance.push("NASA Satellite Observation Archive");
    limitations.push("Satellite observations reflect validated historical snapshots, not real-time IoT sensors.");

    answer = `না, কৃষি মামা সিস্টেমে প্রদর্শিত নাসার উপাত্ত আজকের মুহূর্তের লাইভ পরিস্থিতি নয়। এটি নাসার সংরক্ষিত ঐতিহাসিক স্যাটেলাইট পর্যবেক্ষণ।\n\n` +
      `- মাটির আর্দ্রতা (SMAP): ২০২৩-২০২৪ সালের স্যাটেলাইট পাসের নির্দিষ্ট সংরক্ষিত রেকর্ড।\n` +
      `- উদ্ভিদের সবুজতা (MODIS): ১৬ দিনের কম্পোজিট ঐতিহাসিক রেকর্ড।\n` +
      `- বৃষ্টিপাত ও জলবায়ু (NASA POWER): বিগত ২০০১ থেকে ২০২৫ সালের ২৫ বছরের দীর্ঘমেয়াদী জলবায়ু পুনর্বিশ্লেষণ উপাত্ত।\n\n` +
      `কৃষি মামা ঐতিহাসিক স্বাভাবিকতা ও জলবায়ু প্রবণতা বিশ্লেষণের মাধ্যমে কৃষকের দীর্ঘমেয়াদী সিদ্ধান্ত গ্রহণে সহায়তা করে; এটি কোনো তাৎক্ষণিক লাইভ সেন্সর পর্যবেক্ষণ নয়।`;

    return {
      answer,
      executedTools,
      sources,
      dataDate,
      dataQuality,
      provenance,
      limitations,
      modelUsed: "deterministic-grounded-engine",
    };
  }

  // 0d. Check for Scientific Limitations & Sowing Feasibility (বীজ বোনা যাবে কি / জমিতে বীজ / মাটির আর্দ্রতা দেখে বীজ)
  if (normMessage.includes("বীজ বোনা যাবে") || normMessage.includes("বীজ বপন") || normMessage.includes("নিশ্চিত জমিতে বীজ") || normMessage.includes("বোনা যাবে কি") || normMessage.includes("বীজ বোনা")) {
    const smapData = await toolExecutors.getSoilMoistureLatest({ district: validDistrict });
    executedTools.push({ toolName: "getSoilMoistureLatest", result: smapData });

    sources.push("NASA SMAP SPL3SMP_E V006", "BARI / DAE Agricultural Extension Guidelines");
    dataDate = smapData.date || null;
    dataQuality = smapData.qualityClassification || "recommended";
    provenance.push(smapData.provenance || "NASA SMAP Radiometer");
    limitations.push(
      "Top 0-5 cm surface soil layer only. Satellite moisture alone cannot substitute field-level soil workability (মাটির জো) inspection."
    );

    answer = `না, স্যাটেলাইটের মাটির আর্দ্রতা একাই জমিতে বীজ বোনার শতভাগ নিশ্চয়তা দেয় না। এর দুটি প্রধান বৈজ্ঞানিক কারণ রয়েছে:\n\n` +
      `১. পরিমাপের গভীরতা: নাসা স্ম্যাপ (SMAP) স্যাটেলাইট কেবল মাটির উপরিভাগের ০ থেকে ৫ সেন্টিমিটার গভীরতার আর্দ্রতা পরিমাপ করে। এটি বীজের নিচের শিকড় অঞ্চল বা গভীর মাটির রস নির্দেশ করে না।\n` +
      `২. মাটির জো (Workability): বীজ বপনের জন্য মাটিতে পরিমিত 'জো' (পর্যাপ্ত নরম কিন্তু অতিরিক্ত কাদাময় নয়) থাকা আবশ্যক। অতিরিক্ত আর্দ্রতায় বীজ পচে যায় এবং কম আর্দ্রতায় অঙ্কুরোদগম ব্যাহত হয়।\n\n` +
      `পরামর্শ: স্যাটেলাইটের আর্দ্রতা অঞ্চলের সাধারণ অবস্থা বুঝতে সাহায্য করে, তবে জমিতে বীজ বোনার চূড়ান্ত সিদ্ধান্ত নেওয়ার আগে নিজের জমির মাটির জো সরাসরি হাত দিয়ে পরীক্ষা করা অপরিহার্য।`;

    return {
      answer,
      executedTools,
      sources,
      dataDate,
      dataQuality,
      provenance,
      limitations,
      modelUsed: "deterministic-grounded-engine",
    };
  }

  // 1. Summarize only actual stored historical transition results; do not turn them into forecast advice.
  if ((normMessage.includes("আমন") && normMessage.includes("সরিষা")) || normMessage.includes("হ্যান্ডঅফ") || normMessage.includes("handoff") || (normMessage.includes("বোরো") && normMessage.includes("আউশ")) || (normMessage.includes("aman") && normMessage.includes("mustard")) || (normMessage.includes("boro") && normMessage.includes("aus"))) {
    const isBoroAus = (normMessage.includes("বোরো") && normMessage.includes("আউশ")) || (normMessage.includes("boro") && normMessage.includes("aus"));
    const transition = isBoroAus ? "boro-aus" : "aman-mustard";
    const handoffData = await toolExecutors.getHandoffPlan({ transition, district: validDistrict });
    executedTools.push({ toolName: "getHandoffPlan", result: handoffData });
    language = isBanglaMessage(message) ? "bn" : "en";
    dataQuality = handoffData.error ? "unavailable" : "historical_descriptive";
    if (handoffData.provenance) provenance.push(`Handoff planner: ${handoffData.provenance}`);
    if (handoffData.yearsUsed != null) dataDate = `Historical sample: ${handoffData.yearsUsed} years`;
    if (handoffData.scientificDisclaimer) limitations.push(handoffData.scientificDisclaimer);
    if (handoffData.sampleSizeNote) limitations.push(handoffData.sampleSizeNote);

    if (handoffData.error) {
      answer = language === "bn"
        ? "এই ফসল পরিবর্তনের জন্য যাচাইকৃত ঐতিহাসিক পরিকল্পনা-তথ্য এখন পাওয়া যাচ্ছে না। তাই কোনো সময়, হার বা কাজের পরামর্শ দেওয়া হচ্ছে না।"
        : "Validated historical planning data for this crop transition is currently unavailable. No timing, rate, or action recommendation is provided.";
    } else {
      sources.push("Krishi Mama Handoff Window Planner");
      const title = isBoroAus ? (language === "bn" ? "বোরো–আউশ" : "Boro–Aus") : (language === "bn" ? "আমন–সরিষা" : "Aman–Mustard");
      const rate = handoffData.historicalOpportunityRate || (language === "bn" ? "অনুপলব্ধ" : "unavailable");
      const window = handoffData.planningWindow || (language === "bn" ? "উল্লেখ নেই" : "not specified");
      const years = handoffData.yearsUsed == null
        ? (language === "bn" ? "নমুনার বছর অনুপলব্ধ" : "sample years unavailable")
        : language === "bn" ? `${handoffData.yearsUsed} বছরের ঐতিহাসিক নমুনা` : `${handoffData.yearsUsed}-year historical sample`;
      const caveat = language === "bn"
        ? "এটি অতীতের বর্ণনামূলক পরিকল্পনা-তথ্য, আসন্ন আবহাওয়ার পূর্বাভাস নয়; পরিকল্পনা-উইন্ডোর উৎস যাচাই বাকি থাকতে পারে। এটিকে একা চাষের সিদ্ধান্ত হিসেবে ব্যবহার করবেন না।"
        : "This is historical descriptive planning information, not a forecast; the planning-window source may still require verification. Do not use it alone to make a crop decision.";
      answer = language === "bn"
        ? `${title} পরিবর্তনের সংরক্ষিত ঐতিহাসিক পরিকল্পনা-তথ্য:\n- পরিকল্পনা-উইন্ডো: ${window}\n- ঐতিহাসিক সুযোগের হার: ${rate}\n- নমুনা: ${years}\n\n${caveat}`
        : `Stored historical planning information for the ${title} transition:\n- Planning window: ${window}\n- Historical opportunity rate: ${rate}\n- Sample: ${years}\n\n${caveat}`;
    }
  }
  // 2. Check for Soil Moisture query (মাটির আর্দ্রতা / SMAP)
  else if (normMessage.includes("মাটির আর্দ্রতা") || normMessage.includes("আর্দ্রতা") || normMessage.includes("soil moisture") || normMessage.includes("smap") || normMessage.includes("স্ম্যাপ")) {
    const smapData = await toolExecutors.getSoilMoistureLatest({ district: validDistrict });
    executedTools.push({ toolName: "getSoilMoistureLatest", result: smapData });

    language = isBanglaMessage(message) ? "bn" : "en";
    if (smapData.error) {
      dataQuality = "unavailable";
      answer = language === "bn"
        ? `NASA SMAP-এর যাচাইকৃত মাটির আর্দ্রতা পর্যবেক্ষণ ${validDistrict} জেলার জন্য সংরক্ষিত নেই। কোনো মান অনুমান করা হচ্ছে না।`
        : `No validated NASA SMAP soil-moisture observation is stored for ${validDistrict}. No value is inferred.`;
    } else {
      dataDate = smapData.date;
      dataQuality = smapData.qualityClassification;
      sources.push("NASA SMAP SPL3SMP_E V006");
      provenance.push(smapData.provenance);
      limitations.push(smapData.measurementDepth);

      const districtBn = validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম";
      answer = language === "bn"
        ? `NASA SMAP SPL3SMP_E V006-এর ঐতিহাসিক পর্যবেক্ষণ (${smapData.date}) অনুযায়ী ${districtBn} জেলার পৃষ্ঠমাটির আর্দ্রতা ${smapData.soilMoisture} ${smapData.unit} (${smapData.percentage})। Retrieval quality flag ${smapData.retrievalQualityFlag}: ${smapData.qualityClassification === "recommended" ? "সুপারিশকৃত" : "সতর্কতামূলক"}। এটি লাইভ সেন্সর নয় এবং কেবল উপরিভাগের ০–৫ সেমি বোঝায়।`
        : `The stored historical NASA SMAP SPL3SMP_E V006 observation for ${validDistrict} is ${smapData.soilMoisture} ${smapData.unit} (${smapData.percentage}) on ${smapData.date}. Retrieval quality flag ${smapData.retrievalQualityFlag}: ${smapData.qualityClassification}. This is a satellite estimate of the top 0–5 cm, not a live sensor reading.`;
    }
  }
  // 3. Check for Vegetation / Greenness (NDVI / EVI / সবুজতা / গাছপালা / উদ্ভিদ)
  else if (normMessage.includes("ndvi") || normMessage.includes("evi") || normMessage.includes("vegetation") || normMessage.includes("সবুজতা") || normMessage.includes("modis") || normMessage.includes("মোডিস") || normMessage.includes("গাছপালা") || normMessage.includes("উদ্ভিদ") || normMessage.includes("ক্যানোপি") || normMessage.includes("গাছপালার অবস্থা") || normMessage.includes("ফসলের অবস্থা")) {
    const modisData = await toolExecutors.getVegetationLatest({ district: validDistrict });
    executedTools.push({ toolName: "getVegetationLatest", result: modisData });
    language = isBanglaMessage(message) ? "bn" : "en";

    if (modisData.error) {
      dataQuality = "unavailable";
      answer = language === "bn"
        ? `${validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম"} জেলার জন্য NASA MODIS-এর যাচাইকৃত উদ্ভিদ পর্যবেক্ষণ সংরক্ষিত নেই। কোনো মান অনুমান করা হচ্ছে না।`
        : `No validated NASA MODIS vegetation observation is stored for ${validDistrict}. No value is inferred.`;
    } else {
      dataDate = modisData.date;
      dataQuality = modisData.qualityClassification;
      sources.push("NASA MODIS MOD13Q1.061");
      provenance.push(modisData.provenance);
      limitations.push(modisData.scientificMeaning);

      const districtBn = validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম";
      answer = `নাসা মোডিস (NASA MODIS) স্যাটেলাইটের সংরক্ষিত ঐতিহাসিক রেকর্ড অনুযায়ী (${modisData.date}, ডেস অফ ইয়ার ${modisData.compositeDayOfYear}) — এটি তৎকালীন স্যাটেলাইট পর্যবেক্ষণ, বর্তমান মুহূর্তের লাইভ অবস্থা নয়।\n\n` +
        `উক্ত তারিখে ${districtBn} জেলায় উদ্ভিদের সবুজতা সূচক:\n` +
        `- এনডিভিআই (NDVI): ${modisData.ndvi}\n` +
        `- ইভিআই (EVI): ${modisData.evi}\n` +
        `- পিক্সেল নির্ভরযোগ্যতা: Rank ${modisData.pixelReliability} (${modisData.qualityClassification})\n\n` +
        `বৈজ্ঞানিক অর্থ ও সীমাবদ্ধতা: NDVI এবং EVI সূচক উদ্ভিদের ক্লোরোফিল শোষণ এবং পাতার ঘনত্ব প্রকাশ করে। এটি ফসলের সরাসরি রোগ নির্ণয় বা মোট ফলন পূর্বাভাস নয়।`;
      if (language === "en") {
        answer = `Stored historical NASA MODIS MOD13Q1.061 observation for ${validDistrict} (${modisData.date}, composite day ${modisData.compositeDayOfYear}):\n` +
          `- NDVI: ${modisData.ndvi}\n- EVI: ${modisData.evi}\n` +
          `- Pixel reliability: rank ${modisData.pixelReliability} (${modisData.qualityClassification})\n\n` +
          `This is a historical 16-day composite. NDVI/EVI are greenness indices, not direct disease diagnoses or yield forecasts.`;
      }
    }
  }
  // 4. Latest GPM satellite precipitation requests must use interval-backed observations.
  else if (normMessage.includes("gpm") || normMessage.includes("imerg") || normMessage.includes("latest rainfall") || normMessage.includes("latest rain") || normMessage.includes("সর্বশেষ বৃষ্টিপাত") || normMessage.includes("সর্বশেষ বৃষ্টি") || normMessage.includes("সাম্প্রতিক বৃষ্টিপাত")) {
    const gpmData = await toolExecutors.getPrecipitationLatest({ district: validDistrict });
    executedTools.push({ toolName: "getPrecipitationLatest", result: gpmData });
    sources.push(gpmData.source || "NASA GPM IMERG Final V07");
    provenance.push(gpmData.datasetKey || "nasa:gpm:imerg:3imerghh:v07");
    dataDate = gpmData.observationDate || null;

    const daily = gpmData.dailySummary;
    const validIntervals = Number.isInteger(daily?.validIntervals) ? daily.validIntervals : null;
    const isComplete = daily?.completeness === "complete" && validIntervals === 48 && Number.isFinite(daily?.totalPrecipitationMm);
    dataQuality = isComplete ? "complete_48_of_48" : "incomplete_or_unavailable";
    limitations.push(gpmData.limitation || "Regional ~0.1° grid estimate; not a farm rain-gauge measurement.");

    const districtBn = validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম";
    const districtEn = validDistrict === "cumilla" ? "Cumilla" : "Chattogram";
    const isBangla = /[\u0980-\u09FF]/.test(message);
    const ingestedText = gpmData.ingestedAt
      ? new Date(gpmData.ingestedAt).toISOString()
      : null;
    if (gpmData.status !== "AVAILABLE" || !daily) {
      answer = isBangla
        ? `${districtBn} জেলার জন্য যাচাইকৃত GPM IMERG বৃষ্টিপাতের পর্যবেক্ষণ বর্তমানে সংরক্ষিত নেই। কোনো মান অনুমান করা হচ্ছে না।`
        : `No validated GPM IMERG precipitation observations are stored for ${districtEn}. No value is inferred.`;
    } else {
      const intervalText = validIntervals == null
        ? (isBangla ? "বৈধ ব্যবধানের সংখ্যা অনুপলব্ধ" : "valid interval count unavailable")
        : isBangla ? `${validIntervals}/48 বৈধ অর্ধঘণ্টা ব্যবধান` : `${validIntervals}/48 valid half-hour intervals`;
      const dailyValue = isComplete
        ? `${daily.totalPrecipitationMm.toFixed(2)} mm`
        : isBangla
          ? `প্রকাশযোগ্য নয় (${intervalText})`
          : `withheld (${intervalText})`;
      answer = isBangla
        ? `NASA GPM IMERG Final V07-এর সংরক্ষিত ঐতিহাসিক পর্যবেক্ষণ অনুযায়ী ${districtBn} জেলার সর্বশেষ পর্যবেক্ষণ তারিখ ${gpmData.observationDate}।` +
          `\nদৈনিক বৃষ্টিপাত: ${dailyValue}; ${intervalText}।` +
          `${ingestedText ? `\nডেটাবেসে অন্তর্ভুক্তির সময়: ${ingestedText}।` : ""}` +
          `\nএটি প্রায় ০.১° (~১০ কিমি) গ্রিডের আঞ্চলিক অনুমান, খামারের বৃষ্টিমাপক নয়; এটি লাইভ আবহাওয়া নয়।`
        : `According to the stored historical NASA GPM IMERG Final V07 record, the latest observation for ${districtEn} is dated ${gpmData.observationDate}.` +
          `\nDaily precipitation: ${dailyValue}; ${intervalText}.` +
          `${ingestedText ? `\nDatabase ingestion time: ${ingestedText}.` : ""}` +
          `\nThis is a regional ~0.1° (~10 km) grid estimate, not a farm rain gauge or live weather.`;
    }
    return {
      answer,
      language: isBangla ? "bn" : "en",
      executedTools,
      sources,
      dataDate,
      dataQuality,
      provenance,
      limitations,
      modelUsed: "deterministic-grounded-engine",
    };
  }
  // 5. Check for Rainfall / Climate (বৃষ্টিপাত / জলবায়ু / আবহাওয়া)
  else if (normMessage.includes("বৃষ্টি") || normMessage.includes("বৃষ্টিপাত") || normMessage.includes("বৃষ্টি কেমন") || normMessage.includes("তাপমাত্রা") || normMessage.includes("rainfall") || normMessage.includes("precipitation") || normMessage.includes("nasa power")) {
    const rainfallData = await toolExecutors.getClimateRainfall({ district: validDistrict, grouping: "annual" });
    executedTools.push({ toolName: "getClimateRainfall", result: rainfallData });

    sources.push("NASA POWER Daily Point (2001-2025)");
    dataDate = "2001-2025";
    dataQuality = "satellite_reanalysis";
    provenance.push("NASA Langley Research Center POWER Project");
    limitations.push("0.5 x 0.625 degree spatial resolution grid; reflects 25-year historical normals, not daily weather forecast.");

    const districtBn = validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম";
    const meanMm = getAnnualRainfallMean(rainfallData);
    language = isBanglaMessage(message) ? "bn" : "en";

    if (meanMm == null) {
      answer = language === "bn"
        ? `${districtBn} জেলার জন্য NASA POWER-এর যাচাইকৃত ঐতিহাসিক বার্ষিক বৃষ্টিপাতের পরিসংখ্যান পাওয়া যায়নি। কোনো মান অনুমান করা হচ্ছে না।`
        : `No validated historical annual rainfall statistic is available from NASA POWER for ${validDistrict}. No value is inferred.`;
      dataQuality = "unavailable";
      dataDate = null;
    } else {
      answer = language === "bn"
        ? `NASA POWER Daily Point-এর ২০০১–২০২৫ ঐতিহাসিক রেকর্ড অনুযায়ী ${districtBn} জেলার গড় বার্ষিক বৃষ্টিপাত ${meanMm.toFixed(2)} মিমি। এটি ঐতিহাসিক গড়, দৈনিক পূর্বাভাস নয়।`
        : `According to the 2001–2025 historical NASA POWER Daily Point record, mean annual rainfall for ${validDistrict} is ${meanMm.toFixed(2)} mm. This is a historical average, not a daily forecast.`;
    }
  }
  // 5. Answer crop-calendar questions only from the existing district calendar response.
  else if (normMessage.includes("সরিষা") || normMessage.includes("আমন") || normMessage.includes("বোরো") || normMessage.includes("আউশ") || normMessage.includes("ক্যালেন্ডার") || normMessage.includes("বপন") || normMessage.includes("mustard") || normMessage.includes("aman") || normMessage.includes("boro rice") || normMessage.includes("aus rice") || normMessage.includes("crop calendar") || normMessage.includes("sowing period") || normMessage.includes("planting period") || normMessage.includes("harvest period")) {
    let targetCrop = crop && crop !== "all" ? crop : null;
    if (normMessage.includes("আমন") || normMessage.includes("aman")) targetCrop = "monsoon_aman";
    else if (normMessage.includes("বোরো") || normMessage.includes("boro")) targetCrop = "boro_rice";
    else if (normMessage.includes("আউশ") || normMessage.includes("aus")) targetCrop = "aus_rice";
    else if (normMessage.includes("সরিষা") || normMessage.includes("mustard")) targetCrop = "mustard";
    if (!targetCrop) {
      language = isBanglaMessage(message) ? "bn" : "en";
      answer = language === "bn"
        ? "কোন ফসলের পঞ্জিকা জানতে চান? আমন, বোরো, আউশ বা সরিষার নাম বলুন।"
        : "Which crop calendar do you need? Please specify Aman, Boro, Aus, or mustard.";
      dataQuality = "clarification_needed";
      return { answer, executedTools, sources, dataDate: null, dataQuality, provenance, limitations, language, modelUsed: "deterministic-grounded-engine" };
    }

    const calData = await toolExecutors.getCropCalendarAdvisory({ crop: targetCrop, district: validDistrict });
    executedTools.push({ toolName: "getCropCalendarAdvisory", result: calData });
    language = isBanglaMessage(message) ? "bn" : "en";
    sources.push(...(Array.isArray(calData.officialSources) && calData.officialSources.length
      ? calData.officialSources
      : calData.provenance ? [calData.provenance] : []));
    dataQuality = calData.error ? "unavailable" : "official_calendar";
    if (calData.provenance) provenance.push(calData.provenance);
    limitations.push(language === "bn"
      ? "পঞ্জিকার সময়সীমা সাধারণ নির্দেশনা; মাঠের অবস্থা ও স্থানীয় কৃষি কর্মকর্তার পরামর্শ মিলিয়ে নিন।"
      : "Calendar periods are general guidance; consider field conditions and advice from a local agricultural officer.");

    if (calData.error) {
      answer = language === "bn"
        ? "এই ফসল ও জেলার জন্য যাচাইকৃত পঞ্জিকার তথ্য এখন পাওয়া যাচ্ছে না। কোনো তারিখ বা সুপারিশ অনুমান করা হয়নি।"
        : "Verified calendar information for this crop and district is currently unavailable. No dates or recommendations were inferred.";
    } else {
      const varieties = Array.isArray(calData.typicalVarieties) && calData.typicalVarieties.length
        ? calData.typicalVarieties.join(", ")
        : null;
      const stages = (calData.criticalStages || []).slice(0, 3).map((stage) =>
        language === "bn"
          ? `- ${stage.nameBn || stage.nameEn}${stage.durationDays == null ? "" : `: ${stage.durationDays} দিন`}`
          : `- ${stage.nameEn || stage.nameBn}${stage.durationDays == null ? "" : `: ${stage.durationDays} days`}`
      ).join("\n");
      answer = language === "bn"
        ? `${calData.nameBn || calData.nameEn} ফসলের ${calData.district} জেলার পঞ্জিকা তথ্য:\n- বপনের সময়: ${calData.sowingPeriod || "উল্লেখ নেই"}\n` +
          (calData.transplantingPeriod ? `- চারা রোপণের সময়: ${calData.transplantingPeriod}\n` : "") +
          `- কাটার সময়: ${calData.harvestPeriod || "উল্লেখ নেই"}\n- ফসলের সময়কাল: ${calData.totalDurationDays == null ? "উল্লেখ নেই" : `${calData.totalDurationDays} দিন`}\n` +
          `- উল্লেখিত জাত: ${varieties || "উল্লেখ নেই"}${stages ? `\nগুরুত্বপূর্ণ পর্যায়:\n${stages}` : ""}\n\n` +
          "এটি পঞ্জিকা-ভিত্তিক তথ্য; বর্তমান আবহাওয়া বা ব্যক্তিগত ফলনের নিশ্চয়তা নয়।"
        : `Crop-calendar information for ${calData.nameEn || calData.nameBn} in ${calData.district}:\n- Sowing period: ${calData.sowingPeriod || "not specified"}\n` +
          (calData.transplantingPeriod ? `- Transplanting period: ${calData.transplantingPeriod}\n` : "") +
          `- Harvest period: ${calData.harvestPeriod || "not specified"}\n- Crop duration: ${calData.totalDurationDays == null ? "not specified" : `${calData.totalDurationDays} days`}\n` +
          `- Listed varieties: ${varieties || "not specified"}${stages ? `\nKey stages:\n${stages}` : ""}\n\n` +
          "This is calendar guidance, not a current weather forecast or yield guarantee.";
    }
    dataDate = null;
  }  // 6. Generic or Greeting / Fallback
  else {
    const supported = await toolExecutors.getSupportedDistrictsAndCrops();
    executedTools.push({ toolName: "getSupportedDistrictsAndCrops", result: supported });

    sources.push("Krishi Mama assistant capability registry");
    dataDate = null;
    dataQuality = "capability_help";
    provenance.push("Krishi Mama assistant capability registry");
    language = isBanglaMessage(message) ? "bn" : "en";
    answer = language === "bn"
      ? "আমি আপনার নির্বাচিত খামারের সংরক্ষিত ফসল, কার্যক্রম ও জীবনচক্রের তথ্য, উপলভ্য NASA পর্যবেক্ষণ, আবহাওয়া এবং ফসল পঞ্জিকা নিয়ে সাহায্য করতে পারি। কোনো তথ্য না থাকলে তা স্পষ্ট করে জানাব। আপনি কোন বিষয়টি জানতে চান?"
      : "I can help with your selected farm's saved crop, activities and lifecycle, available NASA observations, weather, and crop-calendar information. I will say when information is unavailable. What would you like to know?";
  }

  return {
    answer,
    executedTools,
    sources,
    dataDate,
    dataQuality,
    provenance,
    limitations,
    language,
    modelUsed: "deterministic-grounded-engine",
  };
}

export class AssistantChatService {
  /**
   * Process a farmer chat request.
   */
  async handleChat({
    message,
    district = "cumilla",
    crop = null,
    farmId = null,
    userId = null,
    conversationId = null,
    customHistory = null,
  }) {
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      throw new Error("EMPTY_MESSAGE: A valid non-empty message string is required.");
    }

    const trimmedMessage = message.trim();
    const effectiveConversationId = conversationId || crypto.randomUUID();
    const history = (Array.isArray(customHistory) && customHistory.length > 0)
      ? customHistory
      : getConversationHistory(effectiveConversationId);

    // Validate district against supported list
    const lowerDistrict = (district || "cumilla").trim().toLowerCase();
    if (district && !VALID_DISTRICT_CODES.has(lowerDistrict)) {
      const unsupportedAnswer = `বর্তমানে কৃষি মামা সিস্টেমে কেবল 'কুমিল্লা' এবং 'চট্টগ্রাম' জেলার উপাত্ত যাচাইকৃত রয়েছে। '${district}' জেলার উপাত্ত ভবিষ্যতে যুক্ত করা হবে। অনুগ্রহ করে কুমিল্লা বা চট্টগ্রাম জেলা নির্বাচন করুন।`;
      return {
        answer: unsupportedAnswer,
        language: "bn",
        sources: ["BBS / Krishi Mama Supported District Registry"],
        dataDate: new Date().toISOString().slice(0, 10),
        dataQuality: "district_unsupported",
        provenance: ["Administrative boundary filter"],
        limitations: ["Only Cumilla (BD2019) and Chattogram (BD2015) are actively validated."],
        conversationId: effectiveConversationId,
        meta: {
          model: "krishi-district-validator",
          toolsCalled: [],
        },
      };
    }

    let responsePayload = null;

    // Try Gemini Function Calling if configured
    if (geminiAssistantClient.isConfigured()) {
      try {
        const geminiResult = await geminiAssistantClient.generateGroundedResponse({
          message: trimmedMessage,
          district: lowerDistrict,
          crop,
          farmId,
          userId,
          conversationHistory: history,
        });

        // Extract metadata from executed tools
        const sources = new Set(["Google Gemini 2.5 Flash"]);
        let dataDate = null;
        let dataQuality = "grounded";
        const provenance = [];
        const limitations = [];

        for (const call of geminiResult.executedTools) {
          const res = call.result;
          if (!res) continue;

          if (call.toolName === "getSoilMoistureLatest") {
            sources.add("NASA SMAP SPL3SMP_E V006");
            if (res.date) dataDate = res.date;
            if (res.qualityClassification) dataQuality = res.qualityClassification;
            if (res.provenance) provenance.push(res.provenance);
            if (res.measurementDepth) limitations.push(res.measurementDepth);
          } else if (call.toolName === "getVegetationLatest") {
            sources.add("NASA MODIS MOD13Q1.061");
            if (res.date) dataDate = res.date;
            if (res.qualityClassification) dataQuality = res.qualityClassification;
            if (res.provenance) provenance.push(res.provenance);
            if (res.scientificMeaning) limitations.push(res.scientificMeaning);
          } else if (call.toolName === "getClimateNormals" || call.toolName === "getClimateRainfall") {
            sources.add("NASA POWER Daily Point (2001-2025)");
            if (!dataDate) dataDate = "2001-2025";
            provenance.push("NASA Langley Research Center POWER Project");
          } else if (call.toolName === "getPrecipitationLatest") {
            sources.add(res.source || "NASA GPM IMERG Final V07");
            if (res.observationDate) dataDate = res.observationDate;
            dataQuality = res.dailySummary?.completeness === "complete" && res.dailySummary?.validIntervals === 48
              ? "complete_48_of_48"
              : "incomplete_or_unavailable";
            if (res.datasetKey) provenance.push(res.datasetKey);
            if (res.limitation) limitations.push(res.limitation);
          } else if (call.toolName === "getCropCalendarAdvisory") {
            sources.add("BAMIS (DAE) & BRRI/BARI Research Bulletins");
            if (res.provenance) provenance.push(res.provenance);
          } else if (call.toolName === "getHandoffPlan") {
            sources.add("Krishi Mama Handoff Window Planner");
            if (res.scientificDisclaimer) limitations.push(res.scientificDisclaimer);
          } else if (call.toolName === "getMyFarmDetails") {
            sources.add("Krishi Mama My Farm Registry");
            provenance.push("Farmer Authenticated Profile");
          } else if (call.toolName === "getMyFarmLifecycle") {
            sources.add("BAMIS Agro-Meteorological Crop Calendar");
            if (res.provenance?.publisher) provenance.push(res.provenance.publisher);
          } else if (call.toolName === "getMyFarmActivities") {
            sources.add("Krishi Mama Farm Activity Tracker");
            provenance.push("Official DAE/BAMIS Crop Schedule");
          } else if (call.toolName === "getMyFarmEnvironmentalContext") {
            sources.add("NASA SMAP & MODIS Satellite Observations");
            provenance.push("NASA Earth Science Data Systems");
            if (res.scientificSafeguards?.rootZoneDisclaimer) limitations.push(res.scientificSafeguards.rootZoneDisclaimer);
            if (res.scientificSafeguards?.vegetationDisclaimer) limitations.push(res.scientificSafeguards.vegetationDisclaimer);
          } else if (call.toolName === "getOfficialCropGuidance") {
            sources.add("BAMIS, DAE, BRRI & BARI Official Guidance");
            if (res.source?.publisher) provenance.push(res.source.publisher);
          } else if (call.toolName === "getFarmActivityHistory") {
            sources.add("Krishi Mama Farm Activity Log");
            provenance.push("Farmer Operational History");
          } else if (call.toolName === "getLocationWeatherForecast") {
            sources.add("Open-Meteo High-Resolution NWP API");
            if (res.current?.date) dataDate = res.current.date;
            if (res.meta?.numericalModel) provenance.push(res.meta.numericalModel);
            limitations.push("1–7 day deterministic NWP; extended days 8–16 have elevated uncertainty.");
          } else if (call.toolName === "getActiveWeatherAlerts") {
            sources.add("Agro-Meteorological Risk Engine");
            const issuingAuthorities = Array.isArray(res.alerts)
              ? [...new Set(res.alerts.filter(alert => alert.isGovernmentNotice && alert.issuingAuthority).map(alert => alert.issuingAuthority))]
              : [];
            for (const authority of issuingAuthorities) {
              sources.add(`${authority} Official Bulletins`);
            }
            provenance.push("Krishi Mama deterministic agro-weather risk engine");
            limitations.push("Alerts strictly distinguish official government bulletins from internal agro-weather risks.");
            if (res.officialWarningsStatus === "UNAVAILABLE") {
              limitations.push("Official warning storage was unavailable; absence of returned bulletins does not establish that no government warning exists.");
            }
          } else if (call.toolName === "getAgriculturalRiskAssessment") {
            sources.add("Krishi Mama Agricultural Risk Engine");
            const issuingAuthorities = Array.isArray(res.alerts)
              ? [...new Set(res.alerts.filter(alert => alert.isGovernmentNotice && alert.issuingAuthority).map(alert => alert.issuingAuthority))]
              : [];
            for (const authority of issuingAuthorities) {
              sources.add(`${authority} Official Bulletins`);
            }
            provenance.push("DAE / BRRI Agronomic Thresholds");
          } else if (call.toolName === "getWeeklyWeatherOutlook") {
            sources.add("Open-Meteo Seasonal Forecast API");
            provenance.push(res.source || "Open-Meteo Sub-seasonal Outlook");
            if (res.spatialResolution) limitations.push(res.spatialResolution);
            if (!dataDate) dataDate = res.weeklyTendencies?.find(week => week.status === "AVAILABLE")?.startDate || null;
          } else if (call.toolName === "getSeasonalCropOutlook") {
            sources.add("Open-Meteo Seasonal Forecast API");
            provenance.push(res.source || "Open-Meteo Seasonal Forecast API");
            if (res.spatialResolution) limitations.push(res.spatialResolution);
            if (!dataDate) dataDate = res.monthlyOutlooks?.find(month => month.status === "AVAILABLE")?.startDate || null;
          }
        }

        responsePayload = {
          answer: geminiResult.answer,
          language: /[\u0980-\u09FF]/.test(trimmedMessage) ? "bn" : "en",
          sources: Array.from(sources),
          dataDate: dataDate || null,
          dataQuality,
          provenance: provenance.length > 0 ? Array.from(new Set(provenance)) : ["Krishi Mama Unified Intelligence Service"],
          limitations: limitations.length > 0 ? Array.from(new Set(limitations)) : ["Agricultural satellite and historical data subject to regional microclimates."],
          conversationId: effectiveConversationId,
          meta: {
            model: geminiResult.modelUsed,
            toolsCalled: geminiResult.executedTools.map((t) => t.toolName),
          },
        };
      } catch (err) {
        // Fallback gracefully on Gemini error (rate limit, timeout, network failure)
        console.warn(`[chat.service] Gemini invocation failed, falling back to deterministic engine: ${err.message}`);
        responsePayload = null;
      }
    }

    // If Gemini was not configured or threw an error, use the deterministic grounded engine
    if (!responsePayload) {
      const fallbackResult = await generateDeterministicFallback({
        message: trimmedMessage,
        district: lowerDistrict,
        crop,
        farmId,
        userId,
      });

      responsePayload = {
        answer: fallbackResult.answer,
        language: fallbackResult.language || "bn",
        sources: fallbackResult.sources,
        dataDate: fallbackResult.dataDate ?? null,
        dataQuality: fallbackResult.dataQuality,
        provenance: fallbackResult.provenance,
        limitations: fallbackResult.limitations,
        conversationId: effectiveConversationId,
        meta: {
          model: fallbackResult.modelUsed,
          toolsCalled: fallbackResult.executedTools.map((t) => t.toolName),
        },
      };
    }

    // Update conversation session
    updateConversationHistory(effectiveConversationId, trimmedMessage, responsePayload.answer);

    return responsePayload;
  }
}

export const assistantChatService = new AssistantChatService();
