/**
 * Krishi Mama — Deterministic Agricultural Weather Risk Engine.
 * Implements Bangladesh Meteorological Department (BMD) meteorological thresholds
 * combined with Bangladesh Rice Research Institute (BRRI) & Department of Agricultural
 * Extension (DAE) crop stage vulnerability matrices.
 */

import { BMD_THRESHOLDS, AGRONOMIC_THRESHOLDS } from "../../config/weather.config.js";

/**
 * Analyzes weather forecast and active official warnings against crop vulnerability matrices
 * to produce deterministic, evidence-grounded agricultural risk alerts and operational advice.
 */
export function assessAgriculturalRisks({ forecast, officialWarnings = [], crop = null, cropStage = null }) {
  const alerts = [];
  const operationalRecommendationsEn = [];
  const operationalRecommendationsBn = [];
  const pauseActionsEn = [];
  const pauseActionsBn = [];

  const daily = forecast?.shortRangeForecast;
  const isForecastProvided = Boolean(forecast && Array.isArray(daily) && daily.length > 0);
  const normalizedCrop = (crop || "").toLowerCase().trim();
  const normalizedStage = (cropStage || "").toLowerCase().trim();

  // 1. Incorporate active Official Warnings first
  if (Array.isArray(officialWarnings) && officialWarnings.length > 0) {
    for (const w of officialWarnings) {
      alerts.push({
        id: `official_${w.bulletinNumber}`,
        source: "OFFICIAL_GOVERNMENT_WARNING",
        category: "GOVERNMENT_BULLETIN",
        hazardType: w.hazardType,
        severity: w.severity === "GREAT_DANGER" ? "SEVERE" : w.severity === "DANGER" ? "HIGH" : "MODERATE",
        titleEn: `[Official BMD] ${w.titleEn}`,
        titleBn: `[সরকারি বিএমডি] ${w.titleBn}`,
        descriptionEn: w.descriptionEn,
        descriptionBn: w.descriptionBn,
        actionAdviceEn: w.actionAdviceEn,
        actionAdviceBn: w.actionAdviceBn,
        date: w.issuedAt,
        signal: w.signalNumber || null,
        isGovernmentNotice: true,
      });

      if (w.actionAdviceEn) operationalRecommendationsEn.push(w.actionAdviceEn);
      if (w.actionAdviceBn) operationalRecommendationsBn.push(w.actionAdviceBn);
    }
  }

  // If forecast is completely missing or empty, do NOT evaluate to LOW risk
  if (!isForecastProvided) {
    let overallRiskLevel = "DATA_INSUFFICIENT";
    if (alerts.some(a => a.severity === "SEVERE")) {
      overallRiskLevel = "SEVERE";
    } else if (alerts.some(a => a.severity === "HIGH")) {
      overallRiskLevel = "HIGH";
    } else if (alerts.some(a => a.severity === "MODERATE")) {
      overallRiskLevel = "MODERATE";
    }

    return {
      overallRiskLevel,
      status: "INSUFFICIENT_DATA",
      dataAvailability: {
        isForecastAvailable: false,
        daysEvaluated: 0,
        reasonEn: "Numerical weather forecast data is missing or incomplete.",
        reasonBn: "সংখ্যাভিত্তিক আবহাওয়া পূর্বাভাসের উপাত্ত অনুপস্থিত বা অসম্পূর্ণ।",
      },
      crop: crop || "General Agriculture",
      cropStage: cropStage || "Active Season",
      activeAlertsCount: alerts.length,
      alerts,
      operationalRecommendationsEn: alerts.length > 0 ? Array.from(new Set(operationalRecommendationsEn)) : ["Forecast data unavailable. Agronomic weather risk cannot be evaluated without forecast observations."],
      operationalRecommendationsBn: alerts.length > 0 ? Array.from(new Set(operationalRecommendationsBn)) : ["পূর্বাভাস উপাত্ত অনুপস্থিত থাকায় কৃষিজ আবহাওয়া ঝুঁকি মূল্যায়ন সম্ভব নয়।"],
      pauseActionsEn: Array.from(new Set(pauseActionsEn)),
      pauseActionsBn: Array.from(new Set(pauseActionsBn)),
      evaluatedAt: new Date().toISOString(),
      evaluationModel: "BMD Meteorological Thresholds + BRRI/DAE Agronomic Criteria",
    };
  }

  // 2. Evaluate Forecast-based Meteorological Hazards (Next 7 days)
  let dryDaysCount = 0;
  let missingRainDaysCount = 0;
  let missingParamDaysCount = 0;

  for (const day of daily) {
    const rain = day.precipitationSumMm;
    const tMax = day.temperatureMaxC;
    const tMin = day.temperatureMinC;
    const gust = day.windGustsMaxKmH;
    const wind = day.windSpeedMaxKmH;

    const hasValidRain = typeof rain === "number" && Number.isFinite(rain);
    const hasValidTMax = typeof tMax === "number" && Number.isFinite(tMax);
    const hasValidTMin = typeof tMin === "number" && Number.isFinite(tMin);
    const hasValidGust = typeof gust === "number" && Number.isFinite(gust);
    const hasValidWind = typeof wind === "number" && Number.isFinite(wind);

    if (!hasValidRain || !hasValidTMax || !hasValidTMin || !hasValidGust || !hasValidWind) {
      missingParamDaysCount++;
    }

    // Rainfall check (BMD Standard: Heavy 44-88 mm, Very Heavy >= 89 mm)
    if (hasValidRain) {
      if (rain >= BMD_THRESHOLDS.rainfall.veryHeavyMinMm) {
        alerts.push({
          id: `forecast_rain_very_heavy_${day.date}`,
          source: "METEOROLOGICAL_FORECAST",
          category: "HEAVY_RAINFALL",
          hazardType: "VERY_HEAVY_RAINFALL",
          severity: "HIGH",
          titleEn: `Very Heavy Rainfall Alert (${rain} mm on ${day.date})`,
          titleBn: `অতি ভারী বর্ষণ সতর্কতা (${day.date}-এ ${rain} মিমি)`,
          descriptionEn: `Expected 24h precipitation of ${rain} mm reaches BMD very heavy threshold (>=89 mm). Inundation and localized waterlogging risk.`,
          descriptionBn: `২৪ ঘণ্টায় প্রত্যাশিত ${rain} মিমি বৃষ্টিপাত বিএমডি-র অতি ভারী বর্ষণ সীমা (৮৯+ মিমি) স্পর্শ করেছে। ফসলের মাঠে জলাবদ্ধতার তীব্র ঝুঁকি রয়েছে।`,
          actionAdviceEn: "Immediately clear and dig drainage channels. Do not broadcast fertilizer, urea top-dressing, or foliar pesticides.",
          actionAdviceBn: "জমির অতিরিক্ত পানি বের করে দেওয়ার জন্য নিকাশ নালা তৈরি ও পরিষ্কার রাখুন। ইউরিয়া বা কীটনাশক স্প্রে করা স্থগিত রাখুন।",
          date: day.date,
          metric: `${rain} mm`,
        });
        pauseActionsEn.push(`Pause chemical spraying & fertilizer application on ${day.date} (wash-off loss)`);
        pauseActionsBn.push(`${day.date} তারিখে সার প্রয়োগ ও কীটনাশক স্প্রে বন্ধ রাখুন (বৃষ্টিতে ধুয়ে যাওয়ার ঝুঁকি)`);
      } else if (rain >= BMD_THRESHOLDS.rainfall.heavyMinMm) {
        alerts.push({
          id: `forecast_rain_heavy_${day.date}`,
          source: "METEOROLOGICAL_FORECAST",
          category: "HEAVY_RAINFALL",
          hazardType: "HEAVY_RAINFALL",
          severity: "MODERATE",
          titleEn: `Heavy Rainfall Advisory (${rain} mm on ${day.date})`,
          titleBn: `ভারী বর্ষণ পরামর্শ (${day.date}-এ ${rain} মিমি)`,
          descriptionEn: `Expected rainfall (${rain} mm) reaches BMD heavy threshold (44–88 mm).`,
          descriptionBn: `প্রত্যাশিত বৃষ্টিপাত (${rain} মিমি) বিএমডি-র ভারী বর্ষণ সীমার (৪৪–৮৮ মিমি) অন্তর্ভুক্ত।`,
          actionAdviceEn: "Prepare field bunds to avoid overflowing into neighboring seedlings. Secure nursery beds.",
          actionAdviceBn: "বীজতলা ও উঁচু জমির আইল বেঁধে রাখুন যাতে অতিরিক্ত পানি দ্রুত বের হতে পারে।",
          date: day.date,
          metric: `${rain} mm`,
        });
      }

      // Genuine zero rainfall vs missing
      if (rain < 1.0) {
        dryDaysCount++;
      }
    } else {
      missingRainDaysCount++;
    }

    // Heatwave check (BMD Standard: Mild 36.0-37.9°C, Moderate 38.0-39.9°C, Severe 40.0-41.9°C, Very Severe >=42.0°C)
    if (hasValidTMax) {
      if (tMax >= BMD_THRESHOLDS.heatwave.verySevereMinC) {
        alerts.push({
          id: `forecast_heat_very_severe_${day.date}`,
          source: "METEOROLOGICAL_FORECAST",
          category: "TEMPERATURE_EXTREME",
          hazardType: "VERY_SEVERE_HEATWAVE",
          severity: "SEVERE",
          titleEn: `Very Severe Heatwave Alert (${tMax}°C on ${day.date})`,
          titleBn: `অতি তীব্র তাপদাহ সতর্কতা (${day.date}-এ ${tMax}°সে)`,
          descriptionEn: `Max temperature reaches ${tMax}°C (BMD Very Severe: >=42.0°C). Critical risk of extreme desiccation and permanent floral sterility in cereals.`,
          descriptionBn: `সর্বোচ্চ তাপমাত্রা ${tMax}°সে-এ পৌঁছাতে পারে (বিএমডি অতি তীব্র তাপদাহ >=৪২.০°সে)। দানাদার ফসলের ফুল বন্ধ্যাত্ব এবং চরম পানিশূন্যতার ঝুঁকি।`,
          actionAdviceEn: "Maintain 5-7 cm standing water in paddy fields. Irrigate light and frequent in early morning.",
          actionAdviceBn: "ধানক্ষেতে ৫-৭ সেমি পানি ধরে রাখুন। সকালে বা বিকেলে হালকা ও ঘনঘন সেচ দিন।",
          date: day.date,
          metric: `${tMax} °C`,
        });
      } else if (tMax >= BMD_THRESHOLDS.heatwave.severeMinC) {
        alerts.push({
          id: `forecast_heat_severe_${day.date}`,
          source: "METEOROLOGICAL_FORECAST",
          category: "TEMPERATURE_EXTREME",
          hazardType: "SEVERE_HEATWAVE",
          severity: "SEVERE",
          titleEn: `Severe Heatwave Alert (${tMax}°C on ${day.date})`,
          titleBn: `তীব্র তাপদাহ সতর্কতা (${day.date}-এ ${tMax}°সে)`,
          descriptionEn: `Max temperature reaches ${tMax}°C (BMD Severe: 40.0–41.9°C). High risk of pollen sterility and leaf scorch.`,
          descriptionBn: `সর্বোচ্চ তাপমাত্রা ${tMax}°সে পর্যন্ত উঠতে পারে (বিএমডি তীব্র তাপদাহ ৪০.০–৪১.৯°সে)। পরাগায়ন ব্যাহত হওয়া ও পাতা ঝলসে যাওয়ার তীব্র ঝুঁকি।`,
          actionAdviceEn: "Maintain standing water in paddy fields to cool root zones. Avoid mid-day cultivation.",
          actionAdviceBn: "ধানক্ষেতে পানি ধরে রাখুন যাতে শিকড় শীতল থাকে। দুপুরে কোনো মাঠের পরিচর্যা থেকে বিরত থাকুন।",
          date: day.date,
          metric: `${tMax} °C`,
        });
      } else if (tMax >= BMD_THRESHOLDS.heatwave.moderateMinC) {
        alerts.push({
          id: `forecast_heat_moderate_${day.date}`,
          source: "METEOROLOGICAL_FORECAST",
          category: "TEMPERATURE_EXTREME",
          hazardType: "MODERATE_HEATWAVE",
          severity: "MODERATE",
          titleEn: `Moderate Heatwave (${tMax}°C on ${day.date})`,
          titleBn: `মাঝারি তাপদাহ (${day.date}-এ ${tMax}°সে)`,
          descriptionEn: `Max temp reaches ${tMax}°C (BMD Moderate: 38.0–39.9°C).`,
          descriptionBn: `সর্বোচ্চ তাপমাত্রা (${tMax}°সে) বিএমডি মাঝারি তাপদাহ সীমার (৩৮.০–৩৯.৯°সে) মধ্যে রয়েছে।`,
          actionAdviceEn: "Avoid foliar spraying during peak noon heat (11 AM - 3 PM).",
          actionAdviceBn: "দুপুর ১১টা থেকে বিকেল ৩টার কড়া রোদে স্প্রে করা থেকে বিরত থাকুন।",
          date: day.date,
          metric: `${tMax} °C`,
        });
      } else if (tMax >= BMD_THRESHOLDS.heatwave.mildMinC) {
        alerts.push({
          id: `forecast_heat_mild_${day.date}`,
          source: "METEOROLOGICAL_FORECAST",
          category: "TEMPERATURE_EXTREME",
          hazardType: "MILD_HEATWAVE",
          severity: "LOW",
          titleEn: `Mild Heatwave (${tMax}°C on ${day.date})`,
          titleBn: `মৃদু তাপদাহ (${day.date}-এ ${tMax}°সে)`,
          descriptionEn: `Max temperature in BMD mild heatwave range (36.0–37.9°C).`,
          descriptionBn: `সর্বোচ্চ তাপমাত্রা বিএমডি মৃদু তাপদাহ সীমার (৩৬.০–৩৭.৯°সে) মধ্যে রয়েছে।`,
          actionAdviceEn: "Monitor topsoil moisture in vegetable and seedling nurseries.",
          actionAdviceBn: "সবজি ও চারা ক্ষেতের মাটির আর্দ্রতা নিয়মিত পর্যবেক্ষণ করুন।",
          date: day.date,
          metric: `${tMax} °C`,
        });
      }
    }

    // Coldwave check (BMD Standard: Mild 8.1-10.0°C, Moderate 6.1-8.0°C, Severe 4.1-6.0°C, Very Severe <=4.0°C)
    if (hasValidTMin) {
      if (tMin <= BMD_THRESHOLDS.coldwave.verySevereMaxC) {
        alerts.push({
          id: `forecast_cold_very_severe_${day.date}`,
          source: "METEOROLOGICAL_FORECAST",
          category: "TEMPERATURE_EXTREME",
          hazardType: "VERY_SEVERE_COLDWAVE",
          severity: "SEVERE",
          titleEn: `Very Severe Cold Wave Alert (${tMin}°C on ${day.date})`,
          titleBn: `অতি তীব্র শৈত্যপ্রবাহ সতর্কতা (${day.date}-এ ${tMin}°সে)`,
          descriptionEn: `Min temp drops to ${tMin}°C (BMD Very Severe: <=4.0°C). Extreme cold injury risk for seedlings and sensitive Rabi crops.`,
          descriptionBn: `সর্বনিম্ন তাপমাত্রা ${tMin}°সে পর্যন্ত নামতে পারে (বিএমডি অতি তীব্র শৈত্যপ্রবাহ <=৪.০°সে)। বোরো বীজতলা ও সংবেদনশীল রবি ফসলের মারাত্মক ক্ষতির ঝুঁকি।`,
          actionAdviceEn: "Cover seedbeds completely with transparent polythene sheets from sunset to sunrise. Irrigate nurseries overnight.",
          actionAdviceBn: "সন্ধ্যা থেকে সকাল পর্যন্ত বীজতলা স্বচ্ছ পলিথিন দিয়ে সম্পূর্ণ ঢেকে রাখুন। রাতে বীজতলায় পানি ধরে রাখুন এবং সকালে বের করে দিন।",
          date: day.date,
          metric: `${tMin} °C`,
        });
      } else if (tMin <= BMD_THRESHOLDS.coldwave.severeMaxC) {
        alerts.push({
          id: `forecast_cold_severe_${day.date}`,
          source: "METEOROLOGICAL_FORECAST",
          category: "TEMPERATURE_EXTREME",
          hazardType: "SEVERE_COLDWAVE",
          severity: "SEVERE",
          titleEn: `Severe Cold Wave Alert (${tMin}°C on ${day.date})`,
          titleBn: `তীব্র শৈত্যপ্রবাহ সতর্কতা (${day.date}-এ ${tMin}°সে)`,
          descriptionEn: `Min temp drops to ${tMin}°C (BMD Severe: 4.1–6.0°C). High risk of seedling yellowing and stunted Boro nurseries.`,
          descriptionBn: `সর্বনিম্ন তাপমাত্রা ${tMin}°সে পর্যন্ত নামতে পারে (বিএমডি তীব্র শৈত্যপ্রবাহ ৪.১–৬.০°সে)। চারা হলুদ হওয়া ও বৃদ্ধি স্থবির হওয়ার ঝুঁকি।`,
          actionAdviceEn: "Cover seedbeds with clear polythene sheets. Retain 3-5 cm water in nurseries overnight.",
          actionAdviceBn: "বীজতলা স্বচ্ছ পলিথিন দিয়ে ঢেকে রাখুন। রাতে বীজতলায় ৩-৫ সেমি পানি ধরে রাখুন।",
          date: day.date,
          metric: `${tMin} °C`,
        });
      } else if (tMin <= BMD_THRESHOLDS.coldwave.moderateMaxC) {
        alerts.push({
          id: `forecast_cold_moderate_${day.date}`,
          source: "METEOROLOGICAL_FORECAST",
          category: "TEMPERATURE_EXTREME",
          hazardType: "MODERATE_COLDWAVE",
          severity: "MODERATE",
          titleEn: `Moderate Cold Wave (${tMin}°C on ${day.date})`,
          titleBn: `মাঝারি শৈত্যপ্রবাহ (${day.date}-এ ${tMin}°সে)`,
          descriptionEn: `Night temp dropping into BMD moderate range (6.1–8.0°C).`,
          descriptionBn: `রাতের তাপমাত্রা বিএমডি মাঝারি শৈত্যপ্রবাহের (৬.১–৮.০°সে) মধ্যে নামতে পারে।`,
          actionAdviceEn: "Gently sweep morning dew/fog drops from seedling leaves using bamboo sticks.",
          actionAdviceBn: "সকালে বাঁশের কঞ্চি দিয়ে চারার ডগা থেকে জমে থাকা কুয়াশার পানি ঝরিয়ে দিন।",
          date: day.date,
          metric: `${tMin} °C`,
        });
      } else if (tMin <= BMD_THRESHOLDS.coldwave.mildMaxC) {
        alerts.push({
          id: `forecast_cold_mild_${day.date}`,
          source: "METEOROLOGICAL_FORECAST",
          category: "TEMPERATURE_EXTREME",
          hazardType: "MILD_COLDWAVE",
          severity: "LOW",
          titleEn: `Mild Cold Wave Advisory (${tMin}°C on ${day.date})`,
          titleBn: `মৃদু শৈত্যপ্রবাহ পরামর্শ (${day.date}-এ ${tMin}°সে)`,
          descriptionEn: `Night temperatures dipping to BMD mild cold range (8.1–10.0°C).`,
          descriptionBn: `রাতের তাপমাত্রা বিএমডি মৃদু শৈত্যপ্রবাহ (৮.১–১০.০°সে) সীমার মধ্যে থাকবে।`,
          actionAdviceEn: "Monitor nursery seedlings for cold stress.",
          actionAdviceBn: "বীজতলার চারার যত্ন নিন।",
          date: day.date,
          metric: `${tMin} °C`,
        });
      }
    }

    // Agronomic Wind Lodging check (BRRI / DAE criteria)
    if (hasValidGust) {
      if (gust >= AGRONOMIC_THRESHOLDS.windLodging.galeLodgingDangerKmH) {
        alerts.push({
          id: `forecast_wind_danger_${day.date}`,
          source: "AGRONOMIC_LODGING_CRITERIA",
          category: "SQUALL_AND_WIND",
          hazardType: "GALE_FORCE_WIND",
          severity: "HIGH",
          titleEn: `Gale-Force Wind Hazard (${gust} km/h on ${day.date})`,
          titleBn: `ঝড়ো বাতাস ও কালবৈশাখী ঝুঁকি (${day.date}-এ ${gust} কিমি/ঘণ্টা)`,
          descriptionEn: `Peak wind gusts of ${gust} km/h exceed DAE/BRRI severe lodging threshold (>=70 km/h). Severe lodging risk for panicle-stage rice, banana, and maize.`,
          descriptionBn: `সর্বোচ্চ দমকা হাওয়া ${gust} কিমি/ঘণ্টা ডিএই/ব্রি-র লজিং সীমা (৭০+ কিমি/ঘণ্টা) অতিক্রম করেছে। পরিপক্ব ধান, ভুট্টা ও কলা গাছ ভেঙে পড়ার তীব্র ঝুঁকি।`,
          actionAdviceEn: "Provide mechanical propping to banana and maize. Harvest 80% matured grains immediately.",
          actionAdviceBn: "কলা ও ভুট্টার গাছে বাঁশের খুঁটি দিন। ৮০% পাকা ধান থাকলে দ্রুত কেটে ফেলার ব্যবস্থা নিন।",
          date: day.date,
          metric: `${gust} km/h`,
        });
      } else if (gust >= AGRONOMIC_THRESHOLDS.windLodging.squallLodgingDangerGustKmH) {
        alerts.push({
          id: `forecast_wind_warning_${day.date}`,
          source: "AGRONOMIC_LODGING_CRITERIA",
          category: "SQUALL_AND_WIND",
          hazardType: "SQUALL_WARNING",
          severity: "MODERATE",
          titleEn: `Agronomic Wind Lodging Advisory (${gust} km/h on ${day.date})`,
          titleBn: `দমকা বাতাস ও ফসল হেলে পড়ার পরামর্শ (${day.date}-এ ${gust} কিমি/ঘণ্টা)`,
          descriptionEn: `Elevated wind gusts (${gust} km/h) reach BRRI/DAE squall threshold (55–69 km/h). Risk of lodging in grain-filling crops.`,
          descriptionBn: `ব্রি ও ডিএই-র মানদণ্ড অনুযায়ী ৫৫–৬৯ কিমি/ঘণ্টা দমকা বাতাসে ধানের শীষ ভারী থাকলে হেলে পড়ার ঝুঁকি থাকে।`,
          actionAdviceEn: "Secure nursery covers, polythene sheds, and delay foliar spraying.",
          actionAdviceBn: "বীজতলার পলিথিন শেড শক্ত করে বেঁধে রাখুন এবং যেকোনো স্প্রে স্থগিত রাখুন।",
          date: day.date,
          metric: `${gust} km/h`,
        });
      }
    }
  }

  // Drought / Dry Spell check (BARC Agronomic Criteria: 7+ consecutive dry days < 1mm during growth)
  // Only trigger if we have at least 7 verified valid rainfall observations without missing data
  if (dryDaysCount >= AGRONOMIC_THRESHOLDS.drought.dryDaysAdvisory && missingRainDaysCount === 0) {
    alerts.push({
      id: "forecast_dry_spell_7d",
      source: "AGRONOMIC_DROUGHT_CRITERIA",
      category: "SOIL_MOISTURE_DEFICIT",
      hazardType: "DRY_SPELL",
      severity: "MODERATE",
      titleEn: "Continuous Dry Spell (7+ Days No Significant Rain)",
      titleBn: "টানা শুষ্ক আবহাওয়া (৭ দিন বা ততোধিক কার্যকর বৃষ্টি নেই)",
      descriptionEn: "No significant rainfall expected over the 7-day forecast horizon. Evapotranspiration will steadily deplete topsoil moisture.",
      descriptionBn: "আগামী ৭ দিনের পূর্বাভাসে কোনো উল্লেখযোগ্য বৃষ্টি নেই। রোদের কারণে মাটির উপরিভাগের আর্দ্রতা দ্রুত হ্রাস পাবে।",
      actionAdviceEn: "Schedule supplemental irrigation, especially for flowering or vegetative crops. Mulch to retain soil moisture.",
      actionAdviceBn: "ফুল আসা বা বাড়ন্ত ফসলে সম্পূরক সেচের ব্যবস্থা করুন। আর্দ্রতা ধরে রাখতে খড় বা মালচিং ব্যবহার করুন।",
      date: "Next 7 Days",
      metric: `${dryDaysCount} dry days`,
    });
    operationalRecommendationsEn.push("Schedule supplementary irrigation within 48-72 hours to prevent vegetative water stress.");
    operationalRecommendationsBn.push("ফসলের পানির ঘাটতি রোধে আগামী ৪৮-৭২ ঘণ্টার মধ্যে সম্পূরক সেচ দিন।");
  }

  // 3. Crop-Specific Vulnerability Enhancements
  if (normalizedCrop.includes("rice") || normalizedCrop.includes("ধান") || normalizedCrop.includes("aman") || normalizedCrop.includes("boro") || normalizedCrop.includes("aus")) {
    if (normalizedCrop.includes("boro")) {
      operationalRecommendationsEn.push("Boro Rice: Keep water depth optimal (2-3 cm for vegetative, 5 cm for panicle initiation).");
      operationalRecommendationsBn.push("বোরো ধান: বৃদ্ধির পর্যায়ে ২-৩ সেমি এবং থোর পর্যায়ে ৫ সেমি পানি বজায় রাখুন।");
    } else if (normalizedCrop.includes("aman")) {
      operationalRecommendationsEn.push("Aman Rice: Check field drains regularly to prevent submersion during localized showers.");
      operationalRecommendationsBn.push("আমন ধান: বৃষ্টির পর জমিতে অতিরিক্ত পানি জমতে না দিয়ে নিকাশ নালা সচল রাখুন।");
    }
  } else if (normalizedCrop.includes("mustard") || normalizedCrop.includes("সরিষা")) {
    operationalRecommendationsEn.push("Mustard: High humidity and cloudy skies increase Alternaria blight risk. Inspect lower foliage.");
    operationalRecommendationsBn.push("সরিষা: মেঘলা ও আর্দ্র আবহাওয়া অল্টারনারিয়া ব্লাইট রোগের ঝুঁকি বাড়ায়। নিচের পাতা নিয়মিত পরীক্ষা করুন।");
  } else if (normalizedCrop.includes("potato") || normalizedCrop.includes("আলু")) {
    operationalRecommendationsEn.push("Potato: Foggy weather and temperatures between 12-18°C require watchful late blight scouting.");
    operationalRecommendationsBn.push("আলু: কুয়াশাচ্ছন্ন আবহাওয়া ও ১২-১৮°সে তাপমাত্রায় নাবি ধসা (Late Blight) রোগের লক্ষণ দেখা দিলে দ্রুত ব্যবস্থা নিন।");
  }

  // Overall Severity Ranking
  let overallRiskLevel = "LOW";
  if (alerts.some(a => a.severity === "SEVERE")) {
    overallRiskLevel = "SEVERE";
  } else if (alerts.some(a => a.severity === "HIGH")) {
    overallRiskLevel = "HIGH";
  } else if (alerts.some(a => a.severity === "MODERATE")) {
    overallRiskLevel = "MODERATE";
  } else if (missingParamDaysCount > 0 || daily.length < 7) {
    overallRiskLevel = "DATA_INSUFFICIENT";
  } else if (alerts.some(a => a.severity === "LOW")) {
    overallRiskLevel = "LOW";
  }

  return {
    overallRiskLevel,
    dataAvailability: {
      isForecastAvailable: true,
      daysEvaluated: daily.length,
      missingParamDaysCount,
      missingRainDaysCount,
      status: missingParamDaysCount > 0 ? "PARTIALLY_INCOMPLETE" : "COMPLETE",
    },
    crop: crop || "General Agriculture",
    cropStage: cropStage || "Active Season",
    activeAlertsCount: alerts.length,
    alerts,
    operationalRecommendationsEn: Array.from(new Set(operationalRecommendationsEn)),
    operationalRecommendationsBn: Array.from(new Set(operationalRecommendationsBn)),
    pauseActionsEn: Array.from(new Set(pauseActionsEn)),
    pauseActionsBn: Array.from(new Set(pauseActionsBn)),
    evaluatedAt: new Date().toISOString(),
    evaluationModel: "BMD Meteorological Thresholds + BRRI/DAE Agronomic Criteria",
  };
}
