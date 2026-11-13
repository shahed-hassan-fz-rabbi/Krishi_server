import { loadOfficialCropCalendars } from "./croplifecycle.service.js";
import { snapshotService } from "./snapshot.service.js";
import { checkCropClimate, describeAreaClimate } from "./rotation-climate.service.js";
import { isRecommendedSmapObservation } from "./nasa/smap.quality.js";
import { isGoodModisObservation } from "./nasa/modis.quality.js";

const CROPS = ["monsoon_aman", "boro_rice", "aus_rice", "mustard"];
const PROFILES = {
  soilType: ["unknown", "clay", "loam", "clay_loam", "sandy_loam", "sandy", "silt", "alluvial", "other"],
  drainage: ["unknown", "good", "moderate", "poor", "waterlogged"],
  irrigation: ["unknown", "available", "limited", "unavailable"],
  priority: ["water", "diversity", "calendar"],
};

function invalid() {
  const error = new Error("Invalid rotation input. Choose a supported district, 1–4 distinct verified crops and valid soil, drainage, irrigation and priority options.");
  error.statusCode = 400;
  throw error;
}

export function validateRotationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const { districtCode, baseline, soilType = "unknown", drainage = "unknown", irrigation = "unknown", priority = "water" } = input;
  if (!["cumilla", "chattogram"].includes(districtCode) || !Array.isArray(baseline) || baseline.length < 1 || baseline.length > 4 ||
      baseline.some((code) => !CROPS.includes(code)) || new Set(baseline).size !== baseline.length) invalid();
  for (const [key, value] of Object.entries({ soilType, drainage, irrigation, priority })) {
    if (!PROFILES[key].includes(value)) invalid();
  }
  return { districtCode, baseline: [...baseline], soilType, drainage, irrigation, priority };
}

// Calendar-week envelopes are conservative screening proxies, NOT exact field dates.
// Include nursery/seedbed time; overlaps require local review rather than assuming transplantation resolves them.
function weekSet(start, end) {
  const weeks = new Set();
  for (let w = start; ; w = w === 52 ? 1 : w + 1) {
    weeks.add(w);
    if (w === end) return weeks;
  }
}

export function compareRotations(rawInput) {
  const input = validateRotationInput(rawInput);
  const calendar = loadOfficialCropCalendars();
  const climate = snapshotService.getClimateSnapshot(input.districtCode);
  const details = new Map(calendar.crops.map((crop) => [crop.cropId, crop]));
  const evaluate = (codes, id, isBaseline = false) => {
    const occupied = new Set();
    const overlaps = [];
    const warnings = new Set(["local_review", "soil_health_unmeasured", "market_unknown"]);
    const timeline = codes.map((cropCode) => {
      const crop = details.get(cropCode);
      const local = crop.districts[input.districtCode];
      const [startWeek, endWeek] = local.standardWeeksRange;
      const weeks = weekSet(startWeek, endWeek);
      for (const previous of overlaps) {
        if ([...weeks].some((w) => previous.weeks.has(w))) warnings.add("calendar_overlap");
      }
      overlaps.push({ weeks });
      weeks.forEach((w) => occupied.add(w));
      if (cropCode === "boro_rice" && input.irrigation === "unavailable") warnings.add("boro_no_irrigation");
      if (cropCode === "boro_rice" && input.irrigation === "limited") warnings.add("boro_limited_irrigation");
      if (cropCode === "mustard" && ["poor", "waterlogged"].includes(input.drainage)) warnings.add("mustard_drainage");
      const climateCheck = checkCropClimate(local, climate);
      if (climateCheck.outsideTemperatureChecks > 0) warnings.add("climate_temperature_review");
      if (climateCheck.missingTemperatureChecks > 0 || !climateCheck.checks.length) warnings.add("climate_data_missing");
      return { cropCode, nameEn: crop.nameEn, nameBn: crop.nameBn, startWeek, endWeek,
        sowingPeriod: local.sowingPeriod, harvestingPeriod: local.harvestingPeriod,
        durationDays: local.totalDurationDays, waterRequirementMm: local.waterRequirementMmTotal, climateCheck,
        source: { title: local.sourceDocumentTitle, publisher: local.sourcePublisher, url: local.sourceDocumentUrl } };
    });
    if (input.soilType === "unknown") warnings.add("soil_unknown");
    if (input.drainage === "unknown") warnings.add("drainage_unknown");
    if (input.irrigation === "unknown") warnings.add("irrigation_unknown");
    const families = new Set(codes.map((c) => c === "mustard" ? "Brassicaceae" : "Poaceae"));
    return { id, isBaseline, cropCodes: codes, timeline,
      climateCheck: { checked: timeline.reduce((n, row) => n + row.climateCheck.checks.length, 0),
        outside: timeline.reduce((n, row) => n + row.climateCheck.outsideTemperatureChecks, 0),
        missing: timeline.reduce((n, row) => n + row.climateCheck.missingTemperatureChecks, 0) },
      waterRequirementMm: timeline.reduce((sum, row) => sum + row.waterRequirementMm, 0),
      cropFamilyCount: families.size, uncoveredCalendarWeeks: 52 - occupied.size,
      warnings: [...warnings], status: warnings.has("boro_no_irrigation") ? "constrained" : "review_required" };
  };
  const baseline = evaluate(input.baseline, "baseline", true);
  const templates = [["monsoon_aman", "mustard", "aus_rice"], ["monsoon_aman", "boro_rice"], ["monsoon_aman", "mustard"], ["monsoon_aman", "aus_rice"], ["monsoon_aman"]];
  // Preserve the farmer's baseline exactly, including its submitted order.
  const signature = (codes) => [...codes].sort().join("|");
  let alternatives = templates.filter((codes) => signature(codes) !== signature(input.baseline))
    .map((codes) => evaluate(codes, codes.join("-")));
  alternatives.sort((a, b) => {
    const hard = Number(a.status === "constrained") - Number(b.status === "constrained");
    if (hard) return hard;
    if (input.priority === "water") return a.waterRequirementMm - b.waterRequirementMm;
    if (input.priority === "diversity") return b.cropFamilyCount - a.cropFamilyCount || a.waterRequirementMm - b.waterRequirementMm;
    return Number(a.warnings.includes("calendar_overlap")) - Number(b.warnings.includes("calendar_overlap")) || a.waterRequirementMm - b.waterRequirementMm;
  });
  alternatives = alternatives.slice(0, 2);
  const pick = (snapshot, field, source, resolution, isValid) => {
    const observations = [...(snapshot?.observations || [])].sort((a, b) => String(b.dateLabel).localeCompare(String(a.dateLabel)));
    const latest = observations.find((row) => isValid(row, input.districtCode)) || null;
    const rawValue = latest?.[field];
    const usable = Boolean(latest && Number.isFinite(rawValue));
    return { source, resolution, provenance: latest ? "SNAPSHOT" : "UNAVAILABLE", date: latest?.dateLabel || null,
      value: usable ? rawValue : null,
      quality: latest?.qualityClassification || "unavailable", usable,
      coverage: observations.filter((row) => isValid(row, input.districtCode)).length, generatedAt: snapshot?.snapshotMetadata?.generatedAt || null };
  };
  return { version: "rotation-screening-v2", input, strategies: [baseline, ...alternatives],
    method: "calendar_and_historical_climate_screening", priority: input.priority, areaClimate: describeAreaClimate(climate),
    evidence: {
      power: { source: "NASA POWER", resolution: "~0.5° regional grid", provenance: climate ? "SNAPSHOT" : "UNAVAILABLE",
        period: climate?.snapshotMetadata?.sourceObservationDateRange || null,
        coveragePercent: climate?.meta?.coverage_percent ?? null },
      smap: pick(snapshotService.getSmapSnapshot(input.districtCode), "soilMoisture", "NASA SMAP", "9 km; surface 0–5 cm", isRecommendedSmapObservation),
      modis: pick(snapshotService.getModisSnapshot(input.districtCode), "ndvi", "NASA MODIS", "250 m; 16-day composite", isGoodModisObservation),
    },
    limitations: ["calendar_envelopes", "water_not_irrigation", "uncovered_not_bare", "regional_not_field", "historical_not_forecast", "no_yield_profit", "monthly_not_daily"],
  };
}

/** Read-only fallback: describes existing output; does not select, rerank or mutate it. */
export function explainRotationComparison(result, language = "en") {
  const bn = language === "bn";
  const lines = result.strategies.map((strategy) => {
    const names = strategy.timeline.map((row) => bn ? row.nameBn : row.nameEn).join(" → ");
    if (bn) return `${strategy.isBaseline ? "আপনি এখন যেভাবে চাষ করেন" : "অন্যভাবে চাষের উপায়"}: ${names}। ফসল পঞ্জিকার হিসাবে মোট পানির চাহিদা ${strategy.waterRequirementMm} মিমি। এর সবটাই সেচ দিয়ে দিতে হবে—এমন নয়। ${strategy.warnings.includes("calendar_overlap") ? "দুই ফসলের চাষের সময় মিলে যেতে পারে। এক ফসল তোলার পর পরেরটি লাগানোর সময় পাবেন কি না দেখে নিন।" : "পঞ্জিকার হিসাবে দুই ফসলের সময় মিলে যায়নি। তবু জাত ও নির্দিষ্ট তারিখ মিলিয়ে নিতে হবে।"} ${strategy.status === "constrained" ? "সেচের পানি না থাকায় বোরো নিয়ে সতর্ক থাকুন।" : ""} ${strategy.climateCheck?.outside > 0 ? "চাষের কিছু ধাপে এলাকার পুরোনো মাসিক গড় তাপমাত্রা পঞ্জিকায় দেওয়া পছন্দের সীমার বাইরে। জাত ও সময় স্থানীয় কৃষি কর্মকর্তার সঙ্গে মিলিয়ে নিন।" : ""}`;
    return `${strategy.isBaseline ? "How you grow now" : "Another way to grow"}: ${names}. Crop calendars give a total water requirement of ${strategy.waterRequirementMm} mm; this is not an irrigation estimate. ${strategy.warnings.includes("calendar_overlap") ? "The growing periods may overlap. Check that you can harvest one crop before planting the next." : "No overlap was found in the broad calendar; exact dates and varieties still need checking."} ${strategy.status === "constrained" ? "Boro needs a water-supply review because irrigation is unavailable." : ""} ${strategy.climateCheck?.outside > 0 ? "Some growing-stage monthly averages fall outside the calendar's preferred temperature range. Check varieties and dates with a local adviser." : ""}`;
  });
  lines.push(bn ? "পরের ধাপ: মাটি ও পানির যে তথ্য জানেন না, তা জেনে নিন। স্থানীয় কৃষি কর্মকর্তার সঙ্গে জাত ও চাষের সময় মিলিয়ে তারপর বেছে নিন। নাসার তথ্য পুরোনো বছরের এলাকার গড়; আপনার জমির আজকের অবস্থা নয়। এআই এখন পাওয়া যায়নি, তাই হিসাব থেকে এই ব্যাখ্যা দেখানো হয়েছে।" : "Next: find out any missing soil and water information, then check varieties and dates with a local agricultural adviser before choosing. NASA records are older regional averages, not today's field conditions. AI is unavailable, so this explanation comes directly from the calculation.");
  return lines.join("\n\n");
}
