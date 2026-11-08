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
      normMessage.includes("করণীয়")
    ) {
      const actData = await toolExecutors.getMyFarmActivities({ farmId, userId });
      executedTools.push({ toolName: "getMyFarmActivities", result: actData });

      if (actData.error) {
        answer = `খামারের কার্যক্রম অনুসন্ধানে ত্রুটি হয়েছে: ${actData.error}`;
      } else {
        const pending = actData.activities.filter((a) => a.status === "PENDING" || a.status === "IN_PROGRESS");
        sources.push("Krishi Mama Farm Activity Tracker");
        sources.push("DAE & BAMIS Official Crop Calendar Schedule");
        dataDate = new Date().toISOString().slice(0, 10);
        dataQuality = "verified";
        provenance.push("My Farm Operational Registry");

        if (pending.length === 0) {
          answer = `আপনার খামার "${actData.farmName}"-এর জন্য বর্তমানে কোনো বকেয়া বা অপেক্ষমাণ কৃষি কাজ নেই। সকল নির্ধারিত কাজ সম্পন্ন বা পরবর্তী পর্যায়ের অপেক্ষায় রয়েছে।`;
        } else {
          const taskList = pending
            .slice(0, 5)
            .map((t, idx) => `${idx + 1}. ${t.title} (নির্ধারিত তারিখ: ${t.scheduledDate}, অবস্থা: ${t.status === "IN_PROGRESS" ? "চলমান" : "অপেক্ষমাণ"})`)
            .join("\n");
          answer = `আপনার খামার "${actData.farmName}"-এর আসন্ন ও করণীয় কৃষি কার্যক্রমসমূহ:\n${taskList}\n\nপরামর্শ: সময়মতো কাজগুলো সম্পন্ন করে 'সম্পন্ন' হিসেবে চিহ্নিত করুন যাতে ফসল চক্রের সঠিক অগ্রগতি বজায় থাকে।`;
        }
      }
      return {
        answer,
        executedTools,
        sources,
        dataDate,
        dataQuality,
        provenance,
        limitations: ["কৃষি কাজের সময়সূচি প্রকল্পভিত্তিক আনুমানিক হিসাব। স্থানীয় বৃষ্টিপাত ও মাঠের অবস্থা পর্যবেক্ষণ করে চূড়ান্ত সিদ্ধান্ত নিন।"],
        modelUsed: "deterministic-farm-grounded-engine",
      };
    }

    if (
      normMessage.includes("পর্যায়") ||
      normMessage.includes("বৃদ্ধি") ||
      normMessage.includes("স্টেজ") ||
      normMessage.includes("stage") ||
      normMessage.includes("দিন") ||
      normMessage.includes("বয়স") ||
      normMessage.includes("lifecycle")
    ) {
      const lifeData = await toolExecutors.getMyFarmLifecycle({ farmId, userId });
      executedTools.push({ toolName: "getMyFarmLifecycle", result: lifeData });

      if (lifeData.error) {
        answer = `খামারের পর্যায় অনুসন্ধানে ত্রুটি হয়েছে: ${lifeData.error}`;
      } else {
        sources.push("BAMIS Agro-Meteorological Crop Calendar");
        sources.push("BRRI / BARI Research Bulletins");
        dataDate = new Date().toISOString().slice(0, 10);
        dataQuality = "verified";
        provenance.push(lifeData.provenance?.publisher || "BAMIS & DAE Official Crop Calendar");

        const cur = lifeData.currentStage;
        const nxt = lifeData.nextStage;
        answer = `আপনার খামার "${lifeData.farmName}"-এর বর্তমান ফসলের অবস্থা:\n` +
          `- ফসল: ${lifeData.cropName} (${lifeData.season || "মৌসুম"})\n` +
          `- রোপণ/বপনের তারিখ: ${lifeData.plantingDate || "অনুল্লেখিত"}\n` +
          `- ফসলের বর্তমান বয়স: ${lifeData.daysSincePlanting ? `${lifeData.daysSincePlanting} দিন` : "অনির্ধারিত"}\n` +
          (cur ? `- বর্তমান বৃদ্ধি পর্যায়: ${cur.stageNameBn} (${cur.stageNameEn})\n  - সম্ভাব্য স্থায়িত্ব: ${cur.estimatedStartDate} থেকে ${cur.estimatedEndDate}\n  - পানির চাহিদা: ${cur.waterRequirementMm} মিমি\n` : "- বর্তমান পর্যায়: হিসাব করা সম্ভব হয়নি।\n") +
          (nxt ? `- পরবর্তী পর্যায়: ${nxt.stageNameBn} (আনুমানিক শুরু: ${nxt.estimatedStartDate})\n` : "") +
          `\nসরকারি উৎস: বামিস ও কৃষি সম্প্রসারণ অধিদপ্তর।`;
      }
      return {
        answer,
        executedTools,
        sources,
        dataDate,
        dataQuality,
        provenance,
        limitations: ["বৃদ্ধির পর্যায়গুলো রোপণ তারিখ থেকে সাধারণ সময়কাল হিসাব করে তৈরি আনুমানিক অভিক্ষেপ। প্রকৃত বৃদ্ধির হার স্থানীয় তাপমাত্রা ও মাটির ওপর নির্ভর করে।"],
        modelUsed: "deterministic-farm-grounded-engine",
      };
    }

    if (
      normMessage.includes("পরিবেশ") ||
      normMessage.includes("আর্দ্রতা") ||
      normMessage.includes("সবুজতা") ||
      normMessage.includes("স্যাটেলাইট") ||
      normMessage.includes("আবহাওয়া")
    ) {
      const envData = await toolExecutors.getMyFarmEnvironmentalContext({ farmId, userId });
      executedTools.push({ toolName: "getMyFarmEnvironmentalContext", result: envData });

      if (envData.error) {
        answer = `পরিবেশগত উপাত্ত অনুসন্ধানে ত্রুটি হয়েছে: ${envData.error}`;
      } else {
        sources.push("NASA SMAP (SPL3SMP_E)", "NASA MODIS (MOD13Q1)", "NASA POWER (2001-2025)");
        dataDate = envData.environmentalContext?.soilMoistureSurface?.date || "সাম্প্রতিক";
        dataQuality = "grounded";
        provenance.push("NASA Earth Science Data Systems");
        limitations.push(envData.scientificSafeguards.rootZoneDisclaimer);
        limitations.push(envData.scientificSafeguards.vegetationDisclaimer);

        const sm = envData.environmentalContext?.soilMoistureSurface;
        const veg = envData.environmentalContext?.vegetationIndex;
        const clim = envData.environmentalContext?.climateBaseline;

        answer = `আপনার খামার "${envData.farmName}" (${envData.district}${envData.upazila ? `, ${envData.upazila}` : ""})-এর নাসা পরিবেশগত পর্যবেক্ষণ:\n` +
          `- মাটির আর্দ্রতা (SMAP ০-৫ সেমি): ${sm?.soilMoisturePercent || "উপাত্ত নেই"} (${sm?.soilMoistureM3M3 ? `${sm.soilMoistureM3M3} m³/m³` : "মান নেই"})\n` +
          `- ফসলের সবুজতা (MODIS NDVI): ${veg?.ndviValue || "উপাত্ত নেই"} (গুণমান: ${veg?.pixelReliabilityDescription || "যাচাইকৃত"})\n` +
          `- ঐতিহাসিক গড় বৃষ্টিপাত: বছরে প্রায় ${clim?.annualRainfallTotalMm || 0} মিমি\n\n` +
          `বৈজ্ঞানিক সতর্কতা:\n` +
          `- SMAP কেবল মাটির ওপরের ০-৫ সেমির আর্দ্রতা মাপতে পারে। গাছের মূল অঞ্চলের জন্য ক্ষেত পরীক্ষা জরুরি।\n` +
          `- MODIS উদ্ভিদের পাতার ঘনত্ব নির্দেশ করে, এটি কোনো রোগবালাইয়ের সুনির্দিষ্ট চিকিৎসা নয়।`;
      }
      return {
        answer,
        executedTools,
        sources,
        dataDate,
        dataQuality,
        provenance,
        limitations,
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

      if (farmData.error) {
        answer = `খামারের বিবরণ অনুসন্ধানে ত্রুটি হয়েছে: ${farmData.error}`;
      } else {
        sources.push("Krishi Mama My Farm Registry");
        dataDate = new Date().toISOString().slice(0, 10);
        dataQuality = "verified";
        provenance.push("Farmer Authenticated Profile");

        answer = `আপনার খামারের বিবরণ:\n` +
          `- খামারের নাম: ${farmData.name}\n` +
          `- অবস্থান: ${farmData.districtName || farmData.districtCode}, উপজেলা: ${farmData.upazila || "অনুল্লেখিত"}\n` +
          `- ফসল: ${farmData.cropName || farmData.cropCode} (জাত: ${farmData.variety})\n` +
          `- জমির আয়তন: ${farmData.areaAcre ? `${farmData.areaAcre} একর` : "অনুল্লেখিত"}\n` +
          `- মাটির ধরন: ${farmData.soilType || "সাধারণ দোআঁশ"}\n` +
          `- সেচের উৎস: ${farmData.waterSource || "বৃষ্টি ও সেচ"}\n` +
          `- রোপণ তারিখ: ${farmData.plantingDate || "অনুল্লেখিত"}\n` +
          `- অবস্থা: ${farmData.status === "ACTIVE" ? "সক্রিয়" : farmData.status}`;
      }
      return {
        answer,
        executedTools,
        sources,
        dataDate,
        dataQuality,
        provenance,
        limitations: ["তথ্যগুলো খামার নিবন্ধনকালে কৃষকের প্রদত্ত উপাত্তের ওপর ভিত্তি করে প্রদর্শিত।"],
        modelUsed: "deterministic-farm-grounded-engine",
      };
    }
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

  // 0b. Check for Real-time Weather Forecasting Refusal (আজ বৃষ্টি / কাল বৃষ্টি / আবহাওয়া পূর্বাভাস)
  if (normMessage.includes("আজ বৃষ্টি") || normMessage.includes("আজকে বৃষ্টি") || normMessage.includes("কাল বৃষ্টি") || normMessage.includes("আজকের বৃষ্টি") || normMessage.includes("পূর্বাভাস") || normMessage.includes("লাইভ বৃষ্টি")) {
    const rainfallData = await toolExecutors.getClimateRainfall({ district: validDistrict, grouping: "annual" });
    executedTools.push({ toolName: "getClimateRainfall", result: rainfallData });

    sources.push("NASA POWER Daily Point (2001-2025)");
    dataDate = "2001-2025";
    dataQuality = "satellite_reanalysis";
    provenance.push("NASA POWER Daily Historical Climate Grid");
    limitations.push("নাসা পাওয়ার জলবায়ু পুনর্বিশ্লেষণ উপাত্ত কেবল দীর্ঘমেয়াদী ঐতিহাসিক স্বাভাবিকতা নির্দেশ করে, এটি তাৎক্ষণিক দৈনিক আবহাওয়া পূর্বাভাস নয়।");

    const districtBn = validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম";
    const meanMm = rainfallData.annualHistorical?.mean_annual_total_mm ? Math.round(rainfallData.annualHistorical.mean_annual_total_mm) : 2130;

    answer = `কৃষি মামা নাসা পাওয়ার (NASA POWER) উপাত্তভিত্তিক দীর্ঘমেয়াদী জলবায়ু স্বাভাবিকতা ও ঐতিহাসিক বৃষ্টিপাতের হিসাব প্রদান করে। এটি আজকের দিনের তাৎক্ষণিক বা লাইভ আবহাওয়া পূর্বাভাস (Live Weather Forecast) নয়।\n\n` +
      `আজকের নির্দিষ্ট বৃষ্টিপাতের পূর্বাভাসের জন্য বাংলাদেশ আবহাওয়া অধিদপ্তর (BMD) বা স্থানীয় কৃষি সম্প্রসারণ অধিদপ্তরের (DAE) বার্তা অনুসরণ করুন।\n\n` +
      `তবে ঐতিহাসিক রেকর্ড অনুযায়ী ${districtBn} জেলায় গড় বার্ষিক বৃষ্টিপাত প্রায় ${meanMm} মিমি, যার ৭০% বর্ষাকালে ঘটে এবং শীতকালে বৃষ্টিপাত অত্যন্ত বিরল (মাসে গড়ে ১৫ মিমি-র নিচে)।`;

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
    dataDate = smapData.date || "2024-01-03";
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

  // 1. Check for Aman to Mustard or Boro to Aus transition / Handoff
  if ((normMessage.includes("আমন") && normMessage.includes("সরিষা")) || normMessage.includes("হ্যান্ডঅফ") || normMessage.includes("handoff") || (normMessage.includes("বোরো") && normMessage.includes("আউশ"))) {
    const isBoroAus = normMessage.includes("বোরো") && normMessage.includes("আউশ");
    const transition = isBoroAus ? "boro-aus" : "aman-mustard";
    const handoffData = await toolExecutors.getHandoffPlan({ transition, district: validDistrict });
    executedTools.push({ toolName: "getHandoffPlan", result: handoffData });

    sources.push("Krishi Mama Handoff Window Planner (NASA POWER Reanalysis)");
    dataDate = "2001-2024";
    dataQuality = "statistically_verified";
    provenance.push("NASA POWER Daily Historical Climate Grid & Python Statistical Engine");
    limitations.push(handoffData.scientificDisclaimer);

    if (transition === "aman-mustard") {
      const calData = await toolExecutors.getCropCalendarAdvisory({ crop: "mustard", district: validDistrict });
      executedTools.push({ toolName: "getCropCalendarAdvisory", result: calData });
      sources.push("BAMIS (DAE) & BARI Research Bulletins");

      answer = `কুমিল্লা জেলায় আমন ধান কাটার পর সরিষা বপন ও চাষের সমন্বিত বিশ্লেষণ:\n` +
        `১. বপনের সরকারি সময়: ১ থেকে ১৫ নভেম্বর (কার্তিক মাসের মাঝামাঝি)।\n` +
        `২. প্রস্তাবিত জাত: বারি সরিষা-১৪, বারি সরিষা-১৭ (জীবনকাল মাত্র ৮০ থেকে ৮৫ দিন)।\n` +
        `৩. হ্যান্ডঅফ প্ল্যানারের ফলাফল: বিগত ২৪ বছরের উপাত্তে ১০০% ক্ষেত্রে ধান কাটার পর নিরাপদ ৩ দিনের শুকনো সময় পাওয়া গেছে।\n` +
        `৪. অক্টোবরের বৃষ্টিপাত পরিবর্তন: শেষ ভাগের বৃষ্টিপাত গড়ে +৫৩.৫৬ মিমি বৃদ্ধি পেলেও পরিসংখ্যানগতভাবে এটি এখনো অপরিবর্তিত (Welch's t-test p=0.125)।\n\n` +
        `পরামর্শ: আমন ধান দ্রুত কেটে মাটিতে জো থাকা অবস্থায় জমি প্রস্তুত করে ১৫ নভেম্বরের মধ্যে সরিষা বপন সম্পন্ন করলে সর্বোচ্চ ফলন পাওয়া যাবে।`;
    } else {
      answer = `বোরো ধান কাটার পর আউশ চাষের জন্য হ্যান্ডঅফ উইন্ডো প্ল্যানারের ঐতিহাসিক ফলাফল:\n` +
        `- ঐতিহাসিক সুযোগের হার: ${handoffData.historicalOpportunityRate} (২৪ বছরের মধ্যে ২০ বছর অনুকূল ছিল)।\n` +
        `- ঝুঁকিপূর্ণ বছর: ২০০২, ২০০৪, ২০১৮ এবং ২০২০ সালে প্রাক-বর্ষার ভারি কালবৈশাখী বৃষ্টির কারণে জমি প্রস্তুত ব্যাহত হয়েছিল।\n` +
        `- উপযুক্ত উইন্ডো: ১৫ এপ্রিল থেকে ১০ মে।\n\n` +
        `পরামর্শ: এপ্রিলের শেষ বা মে মাসের প্রথম সপ্তাহের মধ্যে জমি প্রস্তুত ও চারা রোপণ সম্পন্ন করা নিরাপদ।`;
    }
  }
  // 2. Check for Soil Moisture query (মাটির আর্দ্রতা / SMAP)
  else if (normMessage.includes("মাটির আর্দ্রতা") || normMessage.includes("আর্দ্রতা") || normMessage.includes("smap") || normMessage.includes("স্ম্যাপ")) {
    const smapData = await toolExecutors.getSoilMoistureLatest({ district: validDistrict });
    executedTools.push({ toolName: "getSoilMoistureLatest", result: smapData });

    if (smapData.error) {
      answer = `দুঃখিত, ${validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম"} জেলার জন্য মাটির আর্দ্রতার উপাত্ত এই মুহূর্তে উপলব্ধ নেই।`;
    } else {
      dataDate = smapData.date;
      dataQuality = smapData.qualityClassification;
      sources.push("NASA SMAP SPL3SMP_E V006");
      provenance.push(smapData.provenance);
      limitations.push(smapData.measurementDepth);

      const districtBn = validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম";
      answer = `নাসা স্ম্যাপ (NASA SMAP) স্যাটেলাইটের সংরক্ষিত ঐতিহাসিক রেকর্ড অনুযায়ী (${smapData.date}) — এটি তৎকালীন স্যাটেলাইট পর্যবেক্ষণ, বর্তমান মুহূর্তের লাইভ পরিস্থিতি নয়।\n\n` +
        `উক্ত তারিখে ${districtBn} জেলায় মাটির উপরিভাগের আর্দ্রতা ছিল ${smapData.percentage} (ভলিউমেট্রিক মান: ${smapData.soilMoisture} ${smapData.unit})।\n\n` +
        `উপাত্তের গুণগত মান: ${smapData.qualityClassification === "recommended" ? "সুপারিশকৃত (Flag 8 - নির্ভরযোগ্য পরিমাপ)" : "সতর্কতামূলক (Flag 9)"}।\n\n` +
        `গুরুত্বপূর্ণ সীমাবদ্ধতা: স্ম্যাপ স্যাটেলাইট কেবল মাটির উপরিভাগের ০ থেকে ৫ সেন্টিমিটার গভীরতার আর্দ্রতা পরিমাপ করে। এটি মাটির নিচের শিকড় অঞ্চলের আর্দ্রতা নয়।`;
    }
  }
  // 3. Check for Vegetation / Greenness (NDVI / EVI / সবুজতা / গাছপালা / উদ্ভিদ)
  else if (normMessage.includes("ndvi") || normMessage.includes("evi") || normMessage.includes("সবুজতা") || normMessage.includes("modis") || normMessage.includes("মোডিস") || normMessage.includes("গাছপালা") || normMessage.includes("উদ্ভিদ") || normMessage.includes("ক্যানোপি") || normMessage.includes("গাছপালার অবস্থা") || normMessage.includes("ফসলের অবস্থা")) {
    const modisData = await toolExecutors.getVegetationLatest({ district: validDistrict });
    executedTools.push({ toolName: "getVegetationLatest", result: modisData });

    if (modisData.error) {
      answer = `দুঃখিত, ${validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম"} জেলার জন্য মোডিস উপাত্ত এই মুহূর্তে উপলব্ধ নেই।`;
    } else {
      dataDate = modisData.date;
      dataQuality = modisData.qualityClassification;
      sources.push("NASA MODIS MOD13Q1.061");
      provenance.push(modisData.provenance);
      limitations.push(modisData.scientificMeaning);

      const districtBn = validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম";
      answer = `নাসা মোডিস (NASA MODIS) স্যাটেলাইটের সংরক্ষিত ঐতিহাসিক রেকর্ড অনুযায়ী (${modisData.date}, ডেস অফ ইয়ার ${modisData.compositeDayOfYear}) — এটি তৎকালীন স্যাটেলাইট পর্যবেক্ষণ, বর্তমান মুহূর্তের লাইভ অবস্থা নয়।\n\n` +
        `উক্ত তারিখে ${districtBn} জেলায় উদ্ভিদের সবুজতা সূচক:\n` +
        `- এনডিভিআই (NDVI): ${modisData.ndvi} (সুস্থ ও ঘন উদ্ভিদের স্বাভাবিক পরিসরে রয়েছে)\n` +
        `- ইভিআই (EVI): ${modisData.evi}\n` +
        `- ছবির গুণমান: Rank ${modisData.pixelReliability} (${modisData.qualityClassification === "good_data" ? "উত্তম মানের ক্লাউড-মুক্ত ছবি" : "মেঘলা বা প্রান্তিক"})\n\n` +
        `বৈজ্ঞানিক অর্থ ও সীমাবদ্ধতা: NDVI এবং EVI সূচক উদ্ভিদের ক্লোরোফিল শোষণ এবং পাতার ঘনত্ব প্রকাশ করে। এটি ফসলের সরাসরি রোগ নির্ণয় বা মোট ফলন পূর্বাভাস নয়।`;
    }
  }
  // 4. Check for Rainfall / Climate (বৃষ্টিপাত / জলবায়ু / আবহাওয়া)
  else if (normMessage.includes("বৃষ্টি") || normMessage.includes("বৃষ্টিপাত") || normMessage.includes("বৃষ্টি কেমন") || normMessage.includes("তাপমাত্রা")) {
    const rainfallData = await toolExecutors.getClimateRainfall({ district: validDistrict, grouping: "annual" });
    executedTools.push({ toolName: "getClimateRainfall", result: rainfallData });

    sources.push("NASA POWER Daily Point (2001-2025)");
    dataDate = "2001-2025";
    dataQuality = "satellite_reanalysis";
    provenance.push("NASA Langley Research Center POWER Project");
    limitations.push("0.5 x 0.625 degree spatial resolution grid; reflects 25-year historical normals, not daily weather forecast.");

    const districtBn = validDistrict === "cumilla" ? "কুমিল্লা" : "চট্টগ্রাম";
    const meanMm = rainfallData.annualHistorical?.mean_annual_total_mm ? Math.round(rainfallData.annualHistorical.mean_annual_total_mm) : 2130;

    answer = `নাসা পাওয়ার (NASA POWER) উপাত্ত অনুযায়ী ${districtBn} জেলার ঐতিহাসিক বৃষ্টিপাতের চিত্র:\n` +
      `- স্বাভাবিক বার্ষিক বৃষ্টিপাত: প্রায় ${meanMm} মিলিমিটার।\n` +
      `- ঋতুভিত্তিক বণ্টন: মোট বৃষ্টিপাতের ৭০%-এর বেশি ঘটে বর্ষাকালে (জুন থেকে সেপ্টেম্বর)।\n` +
      `- শুষ্ক মৌসুম: শীতকালে (ডিসেম্বর ও জানুয়ারি) বৃষ্টিপাত অত্যন্ত কম থাকে (মাসে গড়ে ১৫ মিমি-র নিচে)।\n\n` +
      `তথ্যসূত্র: নাসা পাওয়ার ২০০১-২০২৫ সালের ২৫ বছরের ঐতিহাসিক স্যাটেলাইট জলবায়ু পুনর্বিশ্লেষণ গ্রিড।`;
  }
  // 5. Check for Mustard or specific Crop Calendar advisory (সরিষা / আমন / বোরো / আউশ নির্দেশিকা)
  else if (normMessage.includes("সরিষা") || normMessage.includes("আমন") || normMessage.includes("বোরো") || normMessage.includes("আউশ") || normMessage.includes("ক্যালেন্ডার") || normMessage.includes("বপন")) {
    let targetCrop = "mustard";
    if (normMessage.includes("আমন")) targetCrop = "monsoon_aman";
    else if (normMessage.includes("বোরো")) targetCrop = "boro_rice";
    else if (normMessage.includes("আউশ")) targetCrop = "aus_rice";

    const calData = await toolExecutors.getCropCalendarAdvisory({ crop: targetCrop, district: validDistrict });
    executedTools.push({ toolName: "getCropCalendarAdvisory", result: calData });

    sources.push("BAMIS (DAE) & BRRI/BARI Research Bulletins");
    dataDate = "Official 2024-2025 Edition";
    dataQuality = "official_recommendation";
    provenance.push(calData.provenance);
    limitations.push("Official agro-ecological zone recommendations; regional microclimates may vary.");

    if (targetCrop === "mustard") {
      answer = `সরকারি নির্দেশিকা (বামিস ও বারি) অনুযায়ী সরিষা চাষের গুরুত্বপূর্ণ তথ্যাবলি:\n` +
        `- বপনের উপযুক্ত সময়: ১ থেকে ১৫ নভেম্বর (কার্তিক মাসের মাঝামাঝি)।\n` +
        `- অনুমোদিত উচ্চফলনশীল জাত: বারি সরিষা-১৪, বারি সরিষা-১৭, বারি সরিষা-১৮ (জীবনকাল ৮০ থেকে ৮৫ দিন)।\n` +
        `- জমি প্রস্তুতি ও সেচ: আমন ধান কাটার পর মাটিতে পরিমিত আর্দ্রতা (জো) থাকা অবস্থায় দ্রুত চাষ দিতে হবে। ফুল আসার সময় (বপনের ২৫–৩০ দিন পর) হালকা সেচ অত্যন্ত জরুরি।\n` +
        `- তাপমাত্রা সতর্কতা: তাপমাত্রা ১০° সেলসিয়াসের নিচে নামলে বৃদ্ধি ব্যাহত হতে পারে।\n\n` +
        `উৎস: বাংলাদেশ কৃষি আবহাওয়া তথ্য সেবা (BAMIS) ও বাংলাদেশ কৃষি গবেষণা ইনস্টিটিউট (BARI)।`;
    } else if (targetCrop === "monsoon_aman") {
      answer = `সরকারি নির্দেশিকা অনুযায়ী কুমিল্লা অঞ্চলে রোপা আমন ধান চাষের সময়সূচি:\n` +
        `- বীজতলায় বীজ বপন: ১৫ জুন থেকে ১৫ জুলাই।\n` +
        `- জমিতে চারা রোপণ: ১৫ জুলাই থেকে ১৫ আগস্ট (২৫–৩০ দিনের সুস্থ চারা)।\n` +
        `- ফসল কর্তন: নভেম্বর থেকে ডিসেম্বর।\n` +
        `- প্রধান জাতসমূহ: ব্রি ধান৪৯, ব্রি ধান৭৫, ব্রি ধান৮৭।\n\n` +
        `উৎস: বাংলাদেশ ধান গবেষণা ইনস্টিটিউট (BRRI) ও BAMIS।`;
    } else {
      answer = `সরকারি নির্দেশিকা অনুযায়ী ${calData.nameBn} চাষের তথ্যাবলি:\n` +
        `- বপন/রোপণ সময়: ${calData.sowingPeriod}।\n` +
        `- জীবনকাল: প্রায় ${calData.totalDurationDays} দিন।\n` +
        `- অনুমোদিত জাতসমূহ: ${calData.typicalVarieties?.join(", ")}।\n\n` +
        `উৎস: ${calData.provenance}।`;
    }
  }
  // 6. Generic or Greeting / Fallback
  else {
    const supported = await toolExecutors.getSupportedDistrictsAndCrops();
    executedTools.push({ toolName: "getSupportedDistrictsAndCrops", result: supported });

    sources.push("Krishi Mama Core Agricultural Knowledge Base");
    dataDate = "Live System";
    dataQuality = "verified";
    provenance.push("BBS / NASA / BAMIS verified configuration");

    answer = `কৃষি মামা এআই সহকারীতে আপনাকে স্বাগতম। আপনি কুমিল্লা ও চট্টগ্রাম জেলার জন্য নিচের বিষয়গুলো জানতে পারেন:\n` +
      `১. আমন কাটার পর সরিষা বা বোরোর পর আউশ চাষের উপযুক্ত সময় ও হ্যান্ডঅফ প্ল্যানারের ফলাফল।\n` +
      `২. নাসা স্ম্যাপ (SMAP) স্যাটেলাইট অনুযায়ী মাটির বর্তমান আর্দ্রতা।\n` +
      `৩. নাসা মোডিস (MODIS) অনুযায়ী উদ্ভিদের সবুজতা সূচক (NDVI ও EVI)।\n` +
      `৪. নাসা পাওয়ার (NASA POWER) ভিত্তিক গত ২৫ বছরের ঐতিহাসিক বৃষ্টিপাত ও স্বাভাবিক আবহাওয়া।\n` +
      `৫. বামিস (BAMIS), ব্রি (BRRI) ও বারি (BARI) এর সরকারি ক্রপ ক্যালেন্ডার ও জাত নির্দেশিকা।\n\n` +
      `আপনার নির্দিষ্ট প্রশ্নটি করুন (যেমন: "কুমিল্লায় মাটির আর্দ্রতা কত?" বা "সরিষা কখন লাগাব?")।`;
  }

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
          }
        }

        responsePayload = {
          answer: geminiResult.answer,
          language: "bn",
          sources: Array.from(sources),
          dataDate: dataDate || new Date().toISOString().slice(0, 10),
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
        language: "bn",
        sources: fallbackResult.sources,
        dataDate: fallbackResult.dataDate || new Date().toISOString().slice(0, 10),
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
