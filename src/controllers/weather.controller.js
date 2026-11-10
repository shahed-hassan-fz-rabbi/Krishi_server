/**
 * Krishi Mama — Agricultural Weather Controller.
 * Handles short-range forecasts, sub-seasonal/seasonal outlooks, BMD official warnings,
 * and deterministic agricultural risk assessments with in-app notification synchronization.
 */

import { getLiveForecast } from "../services/weather/forecast.service.js";
import { getSeasonalOutlook } from "../services/weather/seasonal.service.js";
import {
  getActiveOfficialWarnings,
  createOfficialWarningDraft,
  verifyOfficialWarning,
  revokeOfficialWarning,
  getAdminWarnings,
} from "../services/weather/warning.service.js";
import { assessAgriculturalRisks } from "../services/weather/risk.engine.js";
import { Farm } from "../models/farm.model.js";
import { FarmNotification } from "../models/farmnotification.model.js";
import { resolveLocationCoordinates } from "../config/weather.config.js";

/**
 * Resolves location parameter from query, farm context, or division/district
 */
async function resolveLocationContext(req) {
  let { latitude, longitude, location, division, district, farmId, crop, stage } = req.query;
  let farm = null;

  if (farmId && req.user?._id) {
    try {
      farm = await Farm.findOne({ _id: farmId, userId: req.user._id }).lean();
      if (farm) {
        if (!location && farm.location?.district) {
          location = farm.location.district;
        }
        if (!crop && farm.crop?.cropCode) {
          crop = farm.crop.cropCode;
        }
      }
    } catch {
      // Non-blocking fallback
    }
  }

  const hasLatitude = latitude !== undefined && latitude !== "";
  const hasLongitude = longitude !== undefined && longitude !== "";
  const parsedLat = hasLatitude ? Number(latitude) : null;
  const parsedLon = hasLongitude ? Number(longitude) : null;

  if (hasLatitude !== hasLongitude || (hasLatitude && (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)))) {
    const error = new Error("Latitude and longitude must be supplied together as valid coordinates");
    error.statusCode = 400;
    throw error;
  }

  if (hasLatitude && (parsedLat < -90 || parsedLat > 90 || parsedLon < -180 || parsedLon > 180)) {
    const error = new Error("Latitude or longitude is outside the valid coordinate range");
    error.statusCode = 400;
    throw error;
  }

  const locationIdentifier =
    Number.isFinite(parsedLat) && Number.isFinite(parsedLon)
      ? { latitude: parsedLat, longitude: parsedLon }
      : location || district || division || "chattogram";

  if (typeof locationIdentifier === "string" &&
      resolveLocationCoordinates(locationIdentifier).type === "default_fallback") {
    const error = new Error("Unknown weather location");
    error.statusCode = 400;
    throw error;
  }

  return {
    latitude: parsedLat,
    longitude: parsedLon,
    locationIdentifier,
    crop: crop || (farm?.crop?.cropCode ? farm.crop.cropCode : null),
    stage: stage || null,
    farm,
  };
}

export async function getForecast(req, res) {
  try {
    const ctx = await resolveLocationContext(req);
    const forecast = await getLiveForecast({
      latitude: ctx.latitude,
      longitude: ctx.longitude,
      locationIdentifier: ctx.locationIdentifier,
    });

    return res.status(200).json({
      success: true,
      data: forecast,
    });
  } catch (err) {
    console.error("Error in getForecast controller:", err.message, err.cause);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: "Failed to fetch live weather forecast",
      error: err.cause ? `${err.message}: ${err.cause.code || err.cause.message || err.cause}` : err.message,
    });
  }
}

export async function getOutlook(req, res) {
  try {
    const ctx = await resolveLocationContext(req);
    const outlook = await getSeasonalOutlook({
      latitude: ctx.latitude,
      longitude: ctx.longitude,
      locationIdentifier: ctx.locationIdentifier,
    });

    return res.status(200).json({
      success: true,
      data: outlook,
    });
  } catch (err) {
    console.error("Error in getOutlook controller:", err.message, err.cause);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: "Failed to fetch seasonal weather outlook",
      error: err.cause ? `${err.message}: ${err.cause.code || err.cause.message || err.cause}` : err.message,
    });
  }
}

export async function getAlerts(req, res) {
  try {
    const ctx = await resolveLocationContext(req);

    // Fetch live forecast and official warnings in parallel
    const [forecast, officialWarnings] = await Promise.all([
      getLiveForecast({
        latitude: ctx.latitude,
        longitude: ctx.longitude,
        locationIdentifier: ctx.locationIdentifier,
      }),
      getActiveOfficialWarnings({
        division: req.query.division || (typeof ctx.locationIdentifier === "string" ? ctx.locationIdentifier : null),
        district: req.query.district || (ctx.farm?.location?.district || null),
      }),
    ]);

    const assessment = assessAgriculturalRisks({
      forecast,
      officialWarnings,
      crop: ctx.crop,
      cropStage: ctx.stage,
    });

    // If farm context and user exist, optionally sync high/severe alerts into notifications idempotently
    if (ctx.farm && req.user?._id && assessment.alerts?.length > 0 && assessment.overallRiskLevel !== "DATA_INSUFFICIENT") {
      const now = new Date();
      const highAlerts = assessment.alerts.filter(
        a => (a.severity === "HIGH" || a.severity === "SEVERE") &&
             a.status !== "DATA_INSUFFICIENT" &&
             a.hazardType !== "INSUFFICIENT_DATA"
      );
      if (highAlerts.length > 0) {
        const ops = [];
        for (const alert of highAlerts) {
          const expiresAt = alert.validUntil
            ? new Date(alert.validUntil)
            : alert.date
            ? new Date(`${alert.date}T23:59:59.999Z`)
            : new Date(Date.now() + 24 * 60 * 60 * 1000);

          // Prevent creating expired notifications
          if (expiresAt <= now) continue;

          const deduplicationKey = `${req.user._id}_${ctx.farm._id}_weather_${alert.id}`;
          ops.push({
            updateOne: {
              filter: { deduplicationKey, userId: req.user._id, farmId: ctx.farm._id },
              update: {
                $setOnInsert: {
                  userId: req.user._id,
                  farmId: ctx.farm._id,
                  type: alert.isGovernmentNotice ? "OFFICIAL_WARNING" : "WEATHER_ALERT",
                  title: alert.titleEn,
                  message: alert.actionAdviceEn || alert.descriptionEn,
                  sourceType: alert.isGovernmentNotice ? "OFFICIAL_GUIDANCE" : "PROJECT_GENERATED",
                  scheduledFor: alert.date || now.toISOString().split("T")[0],
                  expiresAt,
                  isRead: false,
                  deduplicationKey,
                  metadata: {
                    hazardType: alert.hazardType,
                    severity: alert.severity,
                    metric: alert.metric || null,
                    sourceType: alert.isGovernmentNotice ? "OFFICIAL_GOVERNMENT_WARNING" : "METEOROLOGICAL_FORECAST",
                    validUntil: alert.validUntil || null,
                  },
                },
              },
              upsert: true,
            },
          });
        }

        if (ops.length > 0) {
          FarmNotification.bulkWrite(ops).catch(e => {
            console.warn("Weather alert notification sync warning:", e.message);
          });
        }
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        ...assessment,
        location: forecast.location,
        officialWarningsCount: officialWarnings.length,
      },
    });
  } catch (err) {
    console.error("Error in getAlerts controller:", err.message);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: "Failed to evaluate agricultural weather alerts",
      error: err.message,
    });
  }
}

export async function getCropPlanning(req, res) {
  try {
    const ctx = await resolveLocationContext(req);

    const [forecast, outlook, officialWarnings] = await Promise.all([
      getLiveForecast({
        latitude: ctx.latitude,
        longitude: ctx.longitude,
        locationIdentifier: ctx.locationIdentifier,
      }),
      getSeasonalOutlook({
        latitude: ctx.latitude,
        longitude: ctx.longitude,
        locationIdentifier: ctx.locationIdentifier,
      }),
      getActiveOfficialWarnings({
        division: req.query.division || (typeof ctx.locationIdentifier === "string" ? ctx.locationIdentifier : null),
        district: req.query.district || (ctx.farm?.location?.district || null),
      }),
    ]);

    const risks = assessAgriculturalRisks({
      forecast,
      officialWarnings,
      crop: ctx.crop,
      cropStage: ctx.stage,
    });

    // Synthesize Operational Windows
    // Sowing feasibility, chemical spraying window, irrigation demand, harvest safety
    const shortRange = forecast?.shortRangeForecast;
    const isForecastAvailable = Array.isArray(shortRange) && shortRange.length >= 3;
    const next3Days = isForecastAvailable ? shortRange.slice(0, 3) : [];
    const hasValidRain3d = isForecastAvailable && next3Days.every(d =>
      typeof d.precipitationSumMm === "number" && Number.isFinite(d.precipitationSumMm)
    );
    const hasValidGust3d = isForecastAvailable && next3Days.every(d =>
      typeof d.windGustsMaxKmH === "number" && Number.isFinite(d.windGustsMaxKmH)
    );
    const hasValidWind3d = isForecastAvailable && next3Days.every(d =>
      typeof d.windSpeedMaxKmH === "number" && Number.isFinite(d.windSpeedMaxKmH)
    );
    const hasValid3d = hasValidRain3d && hasValidGust3d && hasValidWind3d;

    let sprayWindow;
    let irrigationWindow;
    let harvestWindow;

    if (!hasValid3d) {
      const missingInputs = [];
      if (!hasValidRain3d) missingInputs.push("precipitationSumMm");
      if (!hasValidGust3d) missingInputs.push("windGustsMaxKmH");
      if (!hasValidWind3d) missingInputs.push("windSpeedMaxKmH");

      sprayWindow = {
        isSuitable: false,
        isAvailable: false,
        status: "DATA_INSUFFICIENT",
        missingInputs,
        verdictEn: "Spraying Feasibility Unavailable (Insufficient wind or rainfall forecast data)",
        verdictBn: "স্প্রে করার উপযুক্ততা নির্ধারণ সম্ভব নয় (বাতাস বা বৃষ্টির পূর্বাভাস উপাত্ত অনুপস্থিত)",
        detailsEn: `At least 3 consecutive days of reliable wind speed, gust, and precipitation forecasts are required to evaluate chemical spraying windows. Missing: ${missingInputs.join(", ")}.`,
        detailsBn: `কীটনাশক বা বালাইনাশক স্প্রে করার উইন্ডো মূল্যায়নের জন্য নির্ভরযোগ্য বাতাস, দমকা হাওয়া ও বৃষ্টিপাতের পূর্বাভাস প্রয়োজন। অনুপস্থিত: ${missingInputs.join(", ")}।`,
      };
      irrigationWindow = {
        isNeeded: null,
        isAvailable: false,
        status: "DATA_INSUFFICIENT",
        verdictEn: "Irrigation Scheduling Unavailable (Insufficient forecast data)",
        verdictBn: "সেচ প্রয়োগের সময়সূচি নির্ধারণ সম্ভব নয় (পূর্বাভাস উপাত্ত অনুপস্থিত)",
        detailsEn: "Cannot assess topsoil moisture deficit without short-range precipitation forecast.",
        detailsBn: "বৃষ্টিপাতের পূর্বাভাস ছাড়া সেচের প্রয়োজনীয়তা নির্ধারণ সম্ভব নয়।",
      };
      harvestWindow = {
        isSafe: null,
        isAvailable: false,
        status: "DATA_INSUFFICIENT",
        verdictEn: "Harvesting Feasibility Unavailable (Insufficient forecast data)",
        verdictBn: "ফসল কর্তনের উপযুক্ততা নির্ধারণ সম্ভব নয় (পূর্বাভাস উপাত্ত অনুপস্থিত)",
        detailsEn: "Cannot assess harvest or grain drying safety without forecast data.",
        detailsBn: "পূর্বাভাস উপাত্ত ছাড়া ফসল কাটা ও মাড়াইয়ের নিরাপত্তা মূল্যায়ন সম্ভব নয়।",
      };
    } else {
      const next3DaysRain = next3Days.reduce((acc, d) => acc + d.precipitationSumMm, 0);
      const maxGust3d = Math.max(...next3Days.map(d => d.windGustsMaxKmH));
      const maxWind3d = Math.max(...next3Days.map(d => d.windSpeedMaxKmH));

      // Wind criteria: Any squall/wind alert (MODERATE, HIGH, or SEVERE) OR gust >= 25 km/h OR wind >= 15 km/h
      const hasSquallAlert = risks.alerts.some(a => a.category === "SQUALL_AND_WIND");
      const isWindUnsuitable = hasSquallAlert || maxGust3d >= 25.0 || maxWind3d >= 15.0;
      const isRainUnsuitable = next3DaysRain >= 5.0;

      const sprayWindowSuitable = !isWindUnsuitable && !isRainUnsuitable;
      let sprayVerdictEn = "Favorable Spraying Window (Low wind drift and wash-off risk)";
      let sprayVerdictBn = "কীটনাশক/স্প্রে করার জন্য অনুকূল সময় (বাতাস ও বৃষ্টির ঝুঁকি কম)";
      let sprayDetailsEn = `Next 3 days cumulative rain: ${next3DaysRain.toFixed(1)} mm, peak gust: ${maxGust3d.toFixed(1)} km/h, max wind: ${maxWind3d.toFixed(1)} km/h.`;
      let sprayDetailsBn = `আগামী ৩ দিনে সম্ভাব্য মোট বৃষ্টি: ${next3DaysRain.toFixed(1)} মিমি, সর্বোচ্চ দমকা হাওয়া: ${maxGust3d.toFixed(1)} কিমি/ঘণ্টা, সর্বোচ্চ বাতাস: ${maxWind3d.toFixed(1)} কিমি/ঘণ্টা।`;

      if (isWindUnsuitable && isRainUnsuitable) {
        sprayVerdictEn = "Unfavorable for Spraying (Rain wash-off and squall/wind drift hazard)";
        sprayVerdictBn = "স্প্রে করা থেকে বিরত থাকুন (বৃষ্টিতে ধুয়ে যাওয়া এবং তীব্র বাতাসের ঝুঁকি)";
      } else if (isWindUnsuitable) {
        sprayVerdictEn = "Unfavorable for Spraying (Elevated wind drift or squall hazard)";
        sprayVerdictBn = "স্প্রে করা থেকে বিরত থাকুন (তীব্র বাতাস ও কেমিক্যাল ছড়িয়ে পড়ার ঝুঁকি)";
      } else if (isRainUnsuitable) {
        sprayVerdictEn = "Unfavorable for Spraying (Precipitation wash-off loss)";
        sprayVerdictBn = "স্প্রে করা থেকে বিরত থাকুন (বৃষ্টিতে ধুয়ে যাওয়ার ঝুঁকি)";
      }

      sprayWindow = {
        isSuitable: sprayWindowSuitable,
        isAvailable: true,
        verdictEn: sprayVerdictEn,
        verdictBn: sprayVerdictBn,
        detailsEn: sprayDetailsEn,
        detailsBn: sprayDetailsBn,
      };

      const irrigationNeeded = next3DaysRain < 2.0;
      irrigationWindow = {
        isNeeded: irrigationNeeded,
        isAvailable: true,
        verdictEn: irrigationNeeded ? "Irrigation Recommended (Rainfall deficit projected)" : "Irrigation Postponement Feasible (Natural precipitation expected)",
        verdictBn: irrigationNeeded ? "সেচ প্রয়োগ প্রয়োজন (মাটিতে আর্দ্রতার ঘাটতি)" : "সেচ স্থগিত রাখা সম্ভব (প্রাকৃতিক বৃষ্টির সম্ভাবনা)",
        detailsEn: irrigationNeeded ? `Expected rainfall in next 72h is only ${next3DaysRain.toFixed(1)} mm.` : `Natural rain of ${next3DaysRain.toFixed(1)} mm expected in next 72h.`,
        detailsBn: irrigationNeeded ? `আগামী ৭২ ঘণ্টায় সম্ভাব্য বৃষ্টি মাত্র ${next3DaysRain.toFixed(1)} মিমি।` : `আগামী ৭২ ঘণ্টায় প্রায় ${next3DaysRain.toFixed(1)} মিমি বৃষ্টি হতে পারে।`,
      };

      const harvestSafe = next3DaysRain < 10.0 && !hasSquallAlert;
      harvestWindow = {
        isSafe: harvestSafe,
        isAvailable: true,
        verdictEn: harvestSafe ? "Safe for Harvesting & Open-Air Drying" : "Harvest Caution (Rain or squall damage risk)",
        verdictBn: harvestSafe ? "ফসল কাটা ও খোলা জায়গায় মাড়াইয়ের অনুকূল সময়" : "সতর্কতা: বৃষ্টি বা ঝড়ে ধান শুকাতে ও মাড়াইয়ে বিঘ্ন ঘটতে পারে",
      };
    }

    const operationalGuidance = {
      sprayWindow,
      irrigationWindow,
      harvestWindow,
    };

    const shortRangeDays = forecast?.shortRangeForecast || [];
    const hasFull7Days = shortRangeDays.length >= 7;
    const first7Days = hasFull7Days ? shortRangeDays.slice(0, 7) : [];

    const hasFull7DaysRain = hasFull7Days && first7Days.every(d => typeof d.precipitationSumMm === "number" && Number.isFinite(d.precipitationSumMm));
    const sevenDayRainTotalMm = hasFull7DaysRain
      ? Number(first7Days.reduce((acc, d) => acc + d.precipitationSumMm, 0).toFixed(1))
      : null;

    const hasFull7DaysMaxTemp = hasFull7Days && first7Days.every(d => typeof d.temperatureMaxC === "number" && Number.isFinite(d.temperatureMaxC));
    const sevenDayMaxTemp = hasFull7DaysMaxTemp
      ? Math.max(...first7Days.map(d => d.temperatureMaxC))
      : null;

    const hasFull7DaysMinTemp = hasFull7Days && first7Days.every(d => typeof d.temperatureMinC === "number" && Number.isFinite(d.temperatureMinC));
    const sevenDayMinTemp = hasFull7DaysMinTemp
      ? Math.min(...first7Days.map(d => d.temperatureMinC))
      : null;

    return res.status(200).json({
      success: true,
      data: {
        location: forecast.location,
        crop: ctx.crop || "General",
        shortRangeForecast: forecast.shortRangeForecast,
        extendedForecast: forecast.extendedForecast,
        shortRangeSummary: {
          currentCondition: forecast.currentConditions,
          sevenDayRainTotalMm,
          sevenDayMaxTemp,
          sevenDayMinTemp,
        },
        risks,
        operationalGuidance,
        subSeasonalOutlookSummary: outlook.subSeasonalWeeklyOutlook || [],
        seasonalOutlookSummary: outlook.seasonalMonthlyOutlook || [],
        provenance: {
          weatherForecast: "Open-Meteo Short-Range Forecast API (Asia/Dhaka)",
          forecastModel: forecast?.meta?.numericalModel || "Open-Meteo Best Match (Deterministic NWP Combination)",
          forecastReferenceTime: forecast?.meta?.forecastGenerationTime || null,
          seasonalModel: outlook?.meta?.sourceSystem || "Open-Meteo Seasonal Model Forecast",
          spatialResolution: outlook?.meta?.spatialResolution || "Coarse regional grid (~36 km)",
          officialAdvisories: officialWarnings.length > 0
            ? "Bangladesh Meteorological Department (BMD) Active Bulletins"
            : "No Active BMD Bulletins",
          officialBulletinsActiveCount: officialWarnings.length,
          agronomicRules: "BRRI & DAE Crop Production Standards",
          fetchTimestamp: new Date().toISOString(),
          isForecastCached: forecast?.meta?.isCached || false,
          isSeasonalCached: outlook?.meta?.isCached || false,
        },
      },
    });
  } catch (err) {
    console.error("Error in getCropPlanning controller:", err.message);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: "Failed to generate crop weather planning",
      error: err.message,
    });
  }
}

/**
 * Admin: Create an unverified official warning draft.
 * Requires authenticated admin.
 */
export async function createAdminWarningDraft(req, res) {
  try {
    const warning = await createOfficialWarningDraft({
      data: req.body,
      adminUserId: req.user?._id,
    });
    return res.status(201).json({
      success: true,
      message: "Official warning draft created successfully (unverified / inactive)",
      data: warning,
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      success: false,
      message: err.message || "Failed to create official warning draft",
    });
  }
}

/**
 * Admin: Verify and publish an official government warning bulletin.
 * Requires authenticated admin.
 */
export async function verifyAdminWarning(req, res) {
  try {
    const { id } = req.params;
    const { notes } = req.body || {};
    const warning = await verifyOfficialWarning({
      warningId: id,
      adminUserId: req.user?._id,
      notes,
    });
    return res.status(200).json({
      success: true,
      message: "Official warning bulletin authenticated and published successfully",
      data: warning,
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      success: false,
      message: err.message || "Failed to verify official warning",
    });
  }
}

/**
 * Admin: Revoke / unpublish an official government warning.
 * Requires authenticated admin.
 */
export async function revokeAdminWarning(req, res) {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const warning = await revokeOfficialWarning({
      warningId: id,
      adminUserId: req.user?._id,
      reason,
    });
    return res.status(200).json({
      success: true,
      message: "Official warning bulletin revoked successfully",
      data: warning,
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      success: false,
      message: err.message || "Failed to revoke official warning",
    });
  }
}

/**
 * Admin: List all warning records for inspection.
 * Requires authenticated admin.
 */
export async function listAdminWarnings(req, res) {
  try {
    const warnings = await getAdminWarnings();
    return res.status(200).json({
      success: true,
      data: warnings,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to list official warnings",
    });
  }
}
