/**
 * Krishi Mama — Sub-Seasonal & Seasonal Outlook Service.
 * Fetches and aggregates regional outlook series from the Open-Meteo Seasonal Forecast API.
 * Strictly distinguishes Weeks 1-6 sub-seasonal tendencies and Months 1-3 regional ranges
 * from short-range daily forecasts, never fabricating exact daily numbers for seasonal projections.
 */

import { WEATHER_CONFIG, resolveLocationCoordinates } from "../../config/weather.config.js";

// In-memory cache map: key -> { data, expiresAt }
const seasonalCache = new Map();

function getCacheKey(lat, lon) {
  return `${Number(lat).toFixed(3)}_${Number(lon).toFixed(3)}`;
}

/**
 * Calculates mean, min, max, and percentiles for an array of numbers
 */
function getArrayStats(numbers) {
  if (!numbers || numbers.length === 0) return null;
  const valid = numbers.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (valid.length === 0) return null;

  const sum = valid.reduce((acc, v) => acc + v, 0);
  const mean = sum / valid.length;
  const min = valid[0];
  const max = valid[valid.length - 1];
  const mid = Math.floor(valid.length / 2);
  const median = valid.length % 2 !== 0 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;

  return {
    mean: Number(mean.toFixed(2)),
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    median: Number(median.toFixed(2)),
  };
}

function providerDataError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getForecastSeries(daily) {
  const tempMembers = Object.keys(daily).filter(key => /^temperature_2m_mean_member\d+$/.test(key));
  const rainMembers = new Set(Object.keys(daily).filter(key => /^precipitation_sum_member\d+$/.test(key)));
  const memberSeries = tempMembers
    .filter(tempKey => rainMembers.has(tempKey.replace("temperature_2m_mean", "precipitation_sum")))
    .map(tempKey => ({
      temperatureKey: tempKey,
      precipitationKey: tempKey.replace("temperature_2m_mean", "precipitation_sum"),
      seriesType: "ENSEMBLE_MEMBER",
    }));

  if (memberSeries.length) return memberSeries;
  if (Array.isArray(daily.temperature_2m_mean) && Array.isArray(daily.precipitation_sum)) {
    return [{ temperatureKey: "temperature_2m_mean", precipitationKey: "precipitation_sum", seriesType: "SINGLE_SERIES" }];
  }
  return [];
}

function readFiniteValue(daily, key, index) {
  const value = daily[key]?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Fetches sub-seasonal (Weeks 1-6) and seasonal (Months 1-3) regional outlooks
 */
export async function getSeasonalOutlook({ latitude, longitude, locationIdentifier = null }) {
  const loc = resolveLocationCoordinates(
    Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { latitude, longitude }
      : locationIdentifier
  );

  const cacheKey = getCacheKey(loc.latitude, loc.longitude);
  const now = Date.now();
  const cached = seasonalCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return {
      ...cached.data,
      meta: {
        ...cached.data.meta,
        isCached: true,
        cachedUntil: new Date(cached.expiresAt).toISOString(),
      },
    };
  }

  const params = new URLSearchParams({
    latitude: loc.latitude.toString(),
    longitude: loc.longitude.toString(),
    daily: "temperature_2m_mean,precipitation_sum",
    models: "ecmwf_seasonal_seamless",
    timezone: WEATHER_CONFIG.openMeteo.timezone,
  });

  const url = `${WEATHER_CONFIG.openMeteo.seasonalUrl}?${params.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_CONFIG.openMeteo.timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      throw providerDataError(`Open-Meteo Seasonal API responded with HTTP ${res.status}: ${res.statusText}`);
    }

    const json = await res.json();
    if (!json.daily || !Array.isArray(json.daily.time)) {
      throw providerDataError("Open-Meteo seasonal response missing daily time array");
    }

    const times = json.daily.time; // ~183 days
    const totalDays = times.length;
    if (totalDays < 30) {
      throw providerDataError("Open-Meteo seasonal response does not cover a complete outlook period");
    }

    const forecastSeries = getForecastSeries(json.daily);
    const seriesType = forecastSeries.some(series => series.seriesType === "ENSEMBLE_MEMBER")
      ? "ENSEMBLE_MEMBERS"
      : forecastSeries.length
        ? "SINGLE_DETERMINISTIC_SERIES"
        : "UNAVAILABLE";

    // 1. Group into Sub-Seasonal Weeks (Weeks 1 to 6)
    const weeks = [];
    const maxWeeksAvailable = Math.floor(totalDays / 7);

    for (let w = 0; w < 6; w++) {
      if (w < maxWeeksAvailable) {
        const startIndex = w * 7;
        const endIndex = startIndex + 6;
        const startDate = times[startIndex];
        const endDate = times[endIndex];

        // Aggregate each complete provider series independently for this week.
        const weekSeriesRainTotals = [];
        const weekSeriesMeanTemps = [];

        // Missing values invalidate that series for this period; they are never treated as zero.
        for (const pair of forecastSeries) {
          let memberRainSum = 0;
          let memberTempSum = 0;
          let valid = true;

          for (let d = startIndex; d <= endIndex; d++) {
            const rain = readFiniteValue(json.daily, pair.precipitationKey, d);
            const temperature = readFiniteValue(json.daily, pair.temperatureKey, d);
            if (rain === null || rain < 0 || temperature === null) {
              valid = false;
              break;
            }
            memberRainSum += rain;
            memberTempSum += temperature;
          }

          if (valid) {
            weekSeriesRainTotals.push(memberRainSum);
            weekSeriesMeanTemps.push(memberTempSum / 7);
          }
        }

        if (!weekSeriesRainTotals.length) {
          weeks.push({
            weekNumber: w + 1,
            startDate,
            endDate,
            isAvailable: false,
            status: "DATA_UNAVAILABLE",
            expectedRainfallMeanMm: null,
            rainfallRangeMm: { min: null, max: null },
            expectedTempMeanC: null,
            tempRangeC: { min: null, max: null },
            rainTendencyEn: "Data Unavailable for this Horizon",
            rainTendencyBn: "এই মেয়াদের উপাত্ত অপ্রাপ্য",
            usableSeriesCount: 0,
            seriesType,
            forecastHorizon: w < 2 ? "subseasonal_near_term" : "subseasonal_extended",
            horizonDescriptionEn: `Sub-seasonal Week ${w + 1} (Unavailable)`,
            horizonDescriptionBn: `সাব-সিজনাল সপ্তাহ ${w + 1} (অপ্রাপ্য)`,
          });
          continue;
        }

        const rainStats = getArrayStats(weekSeriesRainTotals);
        const tempStats = getArrayStats(weekSeriesMeanTemps);

        // Qualitative Threshold-based description (rule-based thresholds, not climatological normals)
        let rainTendencyEn = "Moderate Weekly Rainfall Range (5–60 mm threshold)";
        let rainTendencyBn = "মাঝারি সাপ্তাহিক বৃষ্টিপাতের সীমা (৫–৬০ মিমি)";
        if (rainStats.mean < 5) {
          rainTendencyEn = "Low Weekly Precipitation Threshold (<5 mm)";
          rainTendencyBn = "স্বল্প বৃষ্টিপাতের সীমা (<৫ মিমি)";
        } else if (rainStats.mean > 60) {
          rainTendencyEn = "Elevated Weekly Precipitation Threshold (>60 mm)";
          rainTendencyBn = "অধিক বৃষ্টিপাতের সীমা (>৬০ মিমি)";
        }

        weeks.push({
          weekNumber: w + 1,
          startDate,
          endDate,
          isAvailable: true,
          status: "AVAILABLE",
          expectedRainfallMeanMm: rainStats.mean,
          rainfallRangeMm: { min: rainStats.min, max: rainStats.max },
          expectedTempMeanC: tempStats.mean,
          tempRangeC: { min: tempStats.min, max: tempStats.max },
          rainTendencyEn,
          rainTendencyBn,
          usableSeriesCount: weekSeriesRainTotals.length,
          seriesType,
          forecastHorizon: w < 2 ? "subseasonal_near_term" : "subseasonal_extended",
          horizonDescriptionEn: `Sub-seasonal Week ${w + 1} Outlook`,
          horizonDescriptionBn: `সাব-সিজনাল সপ্তাহ ${w + 1} দৃষ্টিভঙ্গি`,
        });
        continue;
      }

      // Explicit placeholder for missing or unavailable week slots beyond horizon
      weeks.push({
        weekNumber: w + 1,
        startDate: null,
        endDate: null,
        isAvailable: false,
        status: "DATA_UNAVAILABLE",
        expectedRainfallMeanMm: null,
        rainfallRangeMm: { min: null, max: null },
        expectedTempMeanC: null,
        tempRangeC: { min: null, max: null },
        rainTendencyEn: "Data Unavailable for this Horizon",
        rainTendencyBn: "এই মেয়াদের উপাত্ত অপ্রাপ্য",
        usableSeriesCount: 0,
        seriesType,
        forecastHorizon: "subseasonal_extended",
        horizonDescriptionEn: `Sub-seasonal Week ${w + 1} (Unavailable)`,
        horizonDescriptionBn: `সাব-সিজনাল সপ্তাহ ${w + 1} (অপ্রাপ্য)`,
      });
    }

    // 2. Group into Seasonal Outlook Months (Months 1, 2, 3 ahead)
    const monthlyOutlooks = [];
    const daysInMonthBlock = 30;
    const maxMonths = Math.min(3, Math.floor(totalDays / daysInMonthBlock));

    for (let mIdx = 0; mIdx < 3; mIdx++) {
      if (mIdx >= maxMonths) {
        monthlyOutlooks.push({
          monthIndex: mIdx + 1,
          windowLabelEn: `30-Day Outlook Block ${mIdx + 1} (Beyond Forecast Horizon)`,
          windowLabelBn: `৩০-দিনের দৃষ্টিভঙ্গি ব্লক ${mIdx + 1} (পূর্বাভাস দিগন্তের বাইরে)`,
          monthNameEn: "Beyond Horizon",
          monthNameBn: "দিগন্তের বাইরে",
          startDate: null,
          endDate: null,
          isAvailable: false,
          status: "DATA_UNAVAILABLE",
          usableSeriesCount: 0,
          seriesType,
          rainfallMeanMm: null,
          rainfallMedianMm: null,
          rainfallRangeMm: { min: null, max: null },
          temperatureMeanC: null,
          temperatureRangeC: { min: null, max: null },
          probabilityData: {
            isOmitted: true,
            reason: "The requested daily response does not provide calibrated tercile probabilities.",
          },
          rainfallThresholdStatusEn: "Threshold Unavailable (Horizon Exceeded)",
          rainfallThresholdStatusBn: "সীমা অপ্রাপ্য (দিগন্ত অতিক্রান্ত)",
        });
        continue;
      }

      const startIndex = mIdx * daysInMonthBlock;
      const endIndex = Math.min(startIndex + daysInMonthBlock - 1, totalDays - 1);
      const startDate = times[startIndex];
      const endDate = times[endIndex];

      // Compute month names immediately to avoid ReferenceError in early-exit branches
      const dateObj = new Date(startDate);
      const monthNameEn = dateObj.toLocaleString("en-US", { month: "long", year: "numeric" });
      const monthNameBn = dateObj.toLocaleString("bn-BD", { month: "long", year: "numeric" });

      const monthRainTotals = [];
      const monthMeanTemps = [];

      for (const pair of forecastSeries) {
        let memberRain = 0;
        let memberTemp = 0;
        let valid = true;

        for (let d = startIndex; d <= endIndex; d++) {
          const rain = readFiniteValue(json.daily, pair.precipitationKey, d);
          const temperature = readFiniteValue(json.daily, pair.temperatureKey, d);
          if (rain === null || rain < 0 || temperature === null) {
            valid = false;
            break;
          }
          memberRain += rain;
          memberTemp += temperature;
        }

        if (valid) {
          monthRainTotals.push(memberRain);
          monthMeanTemps.push(memberTemp / (endIndex - startIndex + 1));
        }
      }

      if (!monthRainTotals.length) {
        monthlyOutlooks.push({
          monthIndex: mIdx + 1,
          windowLabelEn: `30-Day Outlook Block ${mIdx + 1} (~${monthNameEn})`,
          windowLabelBn: `৩০-দিনের দৃষ্টিভঙ্গি ব্লক ${mIdx + 1} (~${monthNameBn})`,
          monthNameEn,
          monthNameBn,
          startDate,
          endDate,
          isAvailable: false,
          status: "DATA_UNAVAILABLE",
          usableSeriesCount: 0,
          seriesType,
          rainfallMeanMm: null,
          rainfallMedianMm: null,
          rainfallRangeMm: { min: null, max: null },
          temperatureMeanC: null,
          temperatureRangeC: { min: null, max: null },
          probabilityData: {
            isOmitted: true,
            reason: "The requested daily response does not provide calibrated tercile probabilities.",
          },
          rainfallThresholdStatusEn: "Threshold Unavailable (Data Insufficient)",
          rainfallThresholdStatusBn: "সীমা অপ্রাপ্য (উপাত্ত অপ্রতুল)",
        });
        continue;
      }

      const rainStats = getArrayStats(monthRainTotals);
      const tempStats = getArrayStats(monthMeanTemps);

      const thresholdEn =
        rainStats.mean > 60
          ? "Elevated Rainfall Threshold (>60 mm)"
          : rainStats.mean < 10
          ? "Low Rainfall Threshold (<10 mm)"
          : "Moderate Rainfall Range (10–60 mm)";
      const thresholdBn =
        rainStats.mean > 60
          ? "অধিক বৃষ্টিপাতের সীমা (>৬০ মিমি)"
          : rainStats.mean < 10
          ? "স্বল্প বৃষ্টিপাতের সীমা (<১০ মিমি)"
          : "মাঝারি বৃষ্টিপাতের সীমা (১০–৬০ মিমি)";

      monthlyOutlooks.push({
        monthIndex: mIdx + 1,
        windowLabelEn: `30-Day Outlook Block ${mIdx + 1} (~${monthNameEn})`,
        windowLabelBn: `৩০-দিনের দৃষ্টিভঙ্গি ব্লক ${mIdx + 1} (~${monthNameBn})`,
        monthNameEn,
        monthNameBn,
        startDate,
        endDate,
        isAvailable: true,
        usableSeriesCount: monthRainTotals.length,
        seriesType,
        rainfallMeanMm: rainStats.mean,
        rainfallMedianMm: rainStats.median,
        rainfallRangeMm: { min: rainStats.min, max: rainStats.max },
        temperatureMeanC: tempStats.mean,
        temperatureRangeC: { min: tempStats.min, max: tempStats.max },
        probabilityData: {
          isOmitted: true,
          reason: "The requested daily response does not provide calibrated tercile probabilities.",
        },
        rainfallThresholdStatusEn: thresholdEn,
        rainfallThresholdStatusBn: thresholdBn,
        rainfallThresholdCategory: rainStats.mean > 60 ? "ELEVATED" : rainStats.mean < 10 ? "LOW" : "MODERATE",
      });
    }

    const hasValidPeriodData = weeks.some(week => week.isAvailable) || monthlyOutlooks.some(month => month.isAvailable);
    const dataStatus = hasValidPeriodData ? "AVAILABLE" : "DATA_UNAVAILABLE";
    const result = {
      location: {
        nameEn: loc.locationName,
        nameBn: loc.locationNameBn,
        latitude: loc.latitude,
        longitude: loc.longitude,
        type: loc.type,
      },
      subSeasonalWeeklyOutlook: weeks,
      seasonalMonthlyOutlook: monthlyOutlooks,
      meta: {
        provider: "Open-Meteo Seasonal Forecast API",
        sourceSystem: seriesType === "ENSEMBLE_MEMBERS" && hasValidPeriodData
          ? `Open-Meteo ECMWF Seasonal Seamless (${forecastSeries.length} paired member series returned)`
          : seriesType === "SINGLE_DETERMINISTIC_SERIES" && hasValidPeriodData
            ? "Open-Meteo Seasonal Forecast API (single deterministic series returned)"
            : "Open-Meteo ECMWF Seasonal Seamless requested; valid forecast series unavailable",
        modelSelection: "ecmwf_seasonal_seamless",
        seriesType,
        returnedSeriesCount: forecastSeries.length,
        dataStatus,
        forecastHorizonDays: totalDays,
        spatialResolution: "Coarse regional grid (~36 km) — not calibrated for farm-level microclimates",
        spatialResolutionBn: "আঞ্চলিক গ্রিড (~৩৬ কিমি) — স্থানীয় খামার পর্যায়ের মাইক্রোক্লাইমেটের জন্য প্রযোজ্য নয়",
        fetchTimestamp: new Date().toISOString(),
        guidanceNoticeEn: seriesType === "ENSEMBLE_MEMBERS"
          ? "Regional output from the requested Open-Meteo ECMWF Seasonal Seamless selection. Period statistics summarize only returned valid member series; they are not farm-level forecasts or calibrated tercile probabilities."
          : seriesType === "SINGLE_DETERMINISTIC_SERIES"
            ? "The provider returned one deterministic series for the requested model selection; ensemble spread and calibrated tercile probabilities are unavailable. This is not a farm-level forecast."
            : "The requested provider response contained no valid series for these periods. Forecast values and probabilities are unavailable.",
        guidanceNoticeBn: seriesType === "ENSEMBLE_MEMBERS"
          ? "অনুরোধ করা Open-Meteo ECMWF Seasonal Seamless নির্বাচন থেকে আঞ্চলিক উপাত্ত। সময়ভিত্তিক পরিসংখ্যান কেবল ফেরত পাওয়া বৈধ সদস্য সিরিজের সারাংশ; এগুলো খামারভিত্তিক পূর্বাভাস বা ক্যালিব্রেটেড সম্ভাব্যতা নয়।"
          : seriesType === "SINGLE_DETERMINISTIC_SERIES"
            ? "অনুরোধ করা মডেল নির্বাচনের জন্য প্রোভাইডার একটি নির্ধারিত সিরিজ দিয়েছে; এনসেম্বল বিস্তার ও ক্যালিব্রেটেড সম্ভাব্যতা অপ্রাপ্য। এটি খামারভিত্তিক পূর্বাভাস নয়।"
            : "অনুরোধ করা প্রোভাইডার উত্তরে এই সময়গুলোর জন্য বৈধ সিরিজ নেই। পূর্বাভাসের মান ও সম্ভাব্যতা অপ্রাপ্য।",
        isCached: false,
        cachedUntil: new Date(now + WEATHER_CONFIG.openMeteo.seasonalCacheTtlMs).toISOString(),
      },
    };

    seasonalCache.set(cacheKey, {
      data: result,
      expiresAt: now + WEATHER_CONFIG.openMeteo.seasonalCacheTtlMs,
    });

    return result;
  } catch (err) {
    clearTimeout(timeout);
    if (cached) {
      return {
        ...cached.data,
        meta: {
          ...cached.data.meta,
          isCached: true,
          isStale: true,
          staleNotice: "Live Seasonal connection timed out. Showing last verified cached outlook.",
        },
      };
    }
    if (!err.statusCode) err.statusCode = 503;
    throw err;
  }
}
