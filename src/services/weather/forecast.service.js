/**
 * Krishi Mama — Weather Forecast Service.
 * Interfaces Open-Meteo Forecast API with Asia/Dhaka timezone, in-memory TTL caching,
 * structured metadata tracking, and clear separation between short-range (1-7d) and extended (8-16d).
 */

import { WEATHER_CONFIG, WMO_WEATHER_CODES, resolveLocationCoordinates } from "../../config/weather.config.js";

// In-memory cache map: key -> { data, expiresAt }
const forecastCache = new Map();

function providerDataError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Generates cache key based on coordinates rounded to 3 decimal places (~100m)
 */
function getCacheKey(lat, lon) {
  return `${Number(lat).toFixed(3)}_${Number(lon).toFixed(3)}`;
}

/**
 * Fetches short-range and extended forecast from Open-Meteo API
 */
export async function getLiveForecast({ latitude, longitude, locationIdentifier = null }) {
  const loc = resolveLocationCoordinates(
    Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { latitude, longitude }
      : locationIdentifier
  );
  if (!loc) {
    throw providerDataError("A supported location or valid coordinate pair is required", 400);
  }

  const cacheKey = getCacheKey(loc.latitude, loc.longitude);
  const now = Date.now();
  const cached = forecastCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return {
      ...cached.data,
      meta: {
        ...cached.data.meta,
        isCached: true,
        dataStatus: "AVAILABLE",
        cachedUntil: new Date(cached.expiresAt).toISOString(),
      },
    };
  }

  const params = new URLSearchParams({
    latitude: loc.latitude.toString(),
    longitude: loc.longitude.toString(),
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "precipitation_probability_max",
      "wind_speed_10m_max",
      "wind_gusts_10m_max",
      "weather_code",
    ].join(","),
    timezone: WEATHER_CONFIG.openMeteo.timezone,
    forecast_days: "16",
  });

  const url = `${WEATHER_CONFIG.openMeteo.forecastUrl}?${params.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_CONFIG.openMeteo.timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      throw providerDataError(`Open-Meteo API responded with HTTP ${res.status}: ${res.statusText}`);
    }

    const json = await res.json();
    if (!json.daily || !Array.isArray(json.daily.time) || json.daily.time.length === 0) {
      throw providerDataError("Open-Meteo response missing daily forecast array");
    }

    const times = json.daily.time;
    if (times.length < 16) {
      throw providerDataError("Open-Meteo response does not cover the requested 16-day forecast");
    }
    const requiredFields = [
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "precipitation_probability_max",
      "wind_speed_10m_max",
      "wind_gusts_10m_max",
      "weather_code",
    ];
    for (const field of requiredFields) {
      const values = json.daily[field];
      if (!Array.isArray(values) || values.length < times.length ||
          times.some((_, index) => typeof values[index] !== "number" || !Number.isFinite(values[index]))) {
        throw providerDataError(`Open-Meteo response contains incomplete ${field} values`);
      }
    }

    const dailyRecords = times.map((t, i) => {
      const code = json.daily.weather_code[i];
      const wmo = WMO_WEATHER_CODES[code] || { en: "Unknown", bn: "অজানা", icon: "Cloud", isHazard: false };

      return {
        date: t,
        dayIndex: i + 1,
        isExtended: i >= 7, // Days 8-16 are extended
        precipitationSumMm: json.daily.precipitation_sum[i],
        precipitationProbabilityMax: json.daily.precipitation_probability_max[i],
        temperatureMaxC: json.daily.temperature_2m_max[i],
        temperatureMinC: json.daily.temperature_2m_min[i],
        windSpeedMaxKmH: json.daily.wind_speed_10m_max[i],
        windGustsMaxKmH: json.daily.wind_gusts_10m_max[i],
        weatherCode: code,
        conditionEn: wmo.en,
        conditionBn: wmo.bn,
        icon: wmo.icon,
        isWeatherHazard: wmo.isHazard,
        forecastHorizon: i < 3 ? "short_range" : i < 7 ? "medium_range" : "extended_outlook",
        leadTimeDays: i < 3 ? "Days 1–3" : i < 7 ? "Days 4–7" : "Days 8–16",
        horizonDescriptionEn:
          i < 3
            ? "Short-Range Forecast (Days 1–3, standard deterministic NWP lead-time)"
            : i < 7
            ? "Medium-Range Forecast (Days 4–7, increasing synoptic uncertainty)"
            : "Extended Numerical Outlook (Days 8–16, elevated uncertainty)",
        horizonDescriptionBn:
          i < 3
            ? "স্বল্পমেয়াদী পূর্বাভাস (১–৩ দিন, প্রমিত সংখ্যাতাত্ত্বিক পূর্বাভাস)"
            : i < 7
            ? "মধ্যমেয়াদী পূর্বাভাস (৪–৭ দিন, ক্রমবর্ধমান আবহাওয়াগত অনিশ্চয়তা)"
            : "বর্ধিত দৃষ্টিভঙ্গি (৮–১৬ দিন, উচ্চ অনিশ্চয়তা)",
        // Retain uncertaintyTier for backwards compatibility with any component references
        uncertaintyTier: i < 3 ? "short_range" : i < 7 ? "medium_range" : "extended_outlook",
      };
    });

    const shortRange = dailyRecords.slice(0, 7);
    const extended = dailyRecords.slice(7, 16);

    const result = {
      location: {
        nameEn: loc.locationName,
        nameBn: loc.locationNameBn,
        latitude: loc.latitude,
        longitude: loc.longitude,
        type: loc.type,
        isRepresentative: loc.isRepresentative,
        limitation: loc.limitation || null,
      },
      currentConditions: {
        date: shortRange[0]?.date || null,
        conditionEn: shortRange[0]?.conditionEn || null,
        conditionBn: shortRange[0]?.conditionBn || null,
        temperatureMaxC: typeof shortRange[0]?.temperatureMaxC === "number" ? shortRange[0].temperatureMaxC : null,
        temperatureMinC: typeof shortRange[0]?.temperatureMinC === "number" ? shortRange[0].temperatureMinC : null,
        todayRainExpectedMm: typeof shortRange[0]?.precipitationSumMm === "number" ? shortRange[0].precipitationSumMm : null,
        todayRainProbabilityPercent: typeof shortRange[0]?.precipitationProbabilityMax === "number" ? shortRange[0].precipitationProbabilityMax : null,
        maxWindSpeedKmH: typeof shortRange[0]?.windSpeedMaxKmH === "number" ? shortRange[0].windSpeedMaxKmH : null,
      },
      shortRangeForecast: shortRange,
      extendedForecast: extended,
      meta: {
        provider: "Open-Meteo Weather Forecast API",
        numericalModel: "Open-Meteo Best Match (Deterministic NWP Combination)",
        forecastType: "Deterministic Daily Forecast with Lead-Time Horizons",
        fetchTimestamp: new Date().toISOString(),
        timezone: json.timezone || "Asia/Dhaka",
        timezoneAbbreviation: json.timezone_abbreviation || "GMT+6",
        elevationMeters: json.elevation,
        isCached: false,
        dataStatus: "AVAILABLE",
        cachedUntil: new Date(now + WEATHER_CONFIG.openMeteo.forecastCacheTtlMs).toISOString(),
      },
    };

    // Store in cache
    forecastCache.set(cacheKey, {
      data: result,
      expiresAt: now + WEATHER_CONFIG.openMeteo.forecastCacheTtlMs,
    });

    return result;
  } catch (err) {
    clearTimeout(timeout);

    // If cache has expired item, return it as emergency fallback
    if (cached) {
      return {
        ...cached.data,
        meta: {
          ...cached.data.meta,
          isCached: true,
          isStale: true,
          staleNotice: "Live Open-Meteo connection timed out. Showing last verified cached forecast.",
        },
      };
    }

    if (!err.statusCode) err.statusCode = 503;
    throw err;
  }
}
