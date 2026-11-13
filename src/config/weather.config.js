/**
 * Krishi Mama — Agricultural Weather Intelligence & Hazard Threshold Configuration.
 * Grounded in official Bangladesh Meteorological Department (BMD) and DAE/BRRI guidelines.
 */

import { DISTRICTS } from "./climate.config.js";
import { DIVISIONS } from "./division.config.js";

export const WEATHER_CONFIG = {
  openMeteo: {
    forecastUrl: "https://api.open-meteo.com/v1/forecast",
    seasonalUrl: "https://seasonal-api.open-meteo.com/v1/seasonal",
    timeoutMs: 10000,
    forecastCacheTtlMs: 2 * 60 * 60 * 1000, // 2 hours
    seasonalCacheTtlMs: 24 * 60 * 60 * 1000, // 24 hours
    timezone: "Asia/Dhaka",
  },
  
  // BMD Official Rainfall Classification (24h)
  rainfallThresholds: {
    lightMm: 2.5,          // 2.5 - 10 mm
    moderateMm: 10.0,      // 10 - 22 mm
    moderatelyHeavyMm: 22.0, // 22 - 43 mm
    heavyMm: 44.0,         // 44 - 88 mm (BMD Heavy Rain alert)
    veryHeavyMm: 89.0,     // >= 89 mm (BMD Very Heavy Rain alert)
  },

  // BMD Official Heatwave Classification (Daily Max Temperature)
  heatwaveThresholds: {
    mildCelsius: 36.0,     // 36.0 - 37.9 °C
    moderateCelsius: 38.0, // 38.0 - 39.9 °C
    severeCelsius: 40.0,   // 40.0 - 41.9 °C
    extremeCelsius: 42.0,  // >= 42.0 °C
  },

  // BMD Official Cold Wave Classification (Daily Min Temperature)
  coldwaveThresholds: {
    mildCelsius: 10.0,     // 8.1 - 10.0 °C
    moderateCelsius: 8.0,  // 6.1 - 8.0 °C
    severeCelsius: 6.0,    // 4.0 - 6.0 °C
    verySevereCelsius: 4.0,// < 4.0 °C
  },

  // Squall / High Wind Thresholds (Kalbaishakhi)
  windThresholds: {
    gustAdvisoryKmH: 40.0, // Gust >= 40 km/h
    gustWarningKmH: 55.0,  // Gust >= 55 km/h (Strong Kalbaishakhi)
    gustDangerKmH: 70.0,   // Gust >= 70 km/h
  },

  // Drought / Deficit: consecutive dry days (< 1mm)
  droughtThresholds: {
    consecutiveDryDaysAdvisory: 10,
    consecutiveDryDaysSevere: 18,
  },
};

const KNOWN_DISTRICT_DIVISIONS = Object.freeze({
  cumilla: "Chattogram",
  chattogram: "Chattogram",
});

export function resolveWarningDivision(locationIdentifier) {
  if (typeof locationIdentifier !== "string") return null;
  const normalized = locationIdentifier.trim().toLowerCase();
  if (KNOWN_DISTRICT_DIVISIONS[normalized]) return KNOWN_DISTRICT_DIVISIONS[normalized];
  return DIVISIONS.find(division => division.code === normalized || division.nameEn.toLowerCase() === normalized)?.nameEn || null;
}

export function resolveWarningDistrict(locationIdentifier) {
  if (typeof locationIdentifier !== "string") return null;
  const normalized = locationIdentifier.trim().toLowerCase();
  return DISTRICTS.find(district => district.code === normalized || district.nameEn.toLowerCase() === normalized)?.nameEn || null;
}

// Official Bangladesh Meteorological Department (BMD) Thresholds
// Documented in BMD Meteorological Glossary & Standard Operational Procedures
export const BMD_THRESHOLDS = {
  // 24-hour rainfall classification
  rainfall: {
    lightMinMm: 1.0,
    lightMaxMm: 10.0,
    moderateMinMm: 11.0,
    moderateMaxMm: 22.0,
    moderatelyHeavyMinMm: 23.0,
    moderatelyHeavyMaxMm: 43.0,
    heavyMinMm: 44.0,
    heavyMaxMm: 88.0,
    veryHeavyMinMm: 89.0, // > 88 mm
  },
  // Daily maximum temperature heatwave classification
  heatwave: {
    mildMinC: 36.0,
    mildMaxC: 37.9,
    moderateMinC: 38.0,
    moderateMaxC: 39.9,
    severeMinC: 40.0,
    severeMaxC: 41.9,
    verySevereMinC: 42.0,
  },
  // Daily minimum temperature cold wave classification
  coldwave: {
    mildMinC: 8.1,
    mildMaxC: 10.0,
    moderateMinC: 6.1,
    moderateMaxC: 8.0,
    severeMinC: 4.1,
    severeMaxC: 6.0,
    verySevereMaxC: 4.0,
  },
};

// DAE / BRRI Agronomic Lodging & Water Stress Indicators
// These represent agronomic crop vulnerability, NOT statutory BMD warning signals
export const AGRONOMIC_THRESHOLDS = {
  windLodging: {
    advisoryGustKmH: 40.0,
    squallLodgingDangerGustKmH: 55.0,
    galeLodgingDangerKmH: 70.0,
    source: "BRRI & DAE Rice Lodging Studies",
  },
  drought: {
    dryDaysAdvisory: 7, // 7 consecutive days with < 1mm rainfall during vegetative/reproductive stage
    dryDaysSevere: 14,
    source: "BARC Agricultural Drought Criteria",
  },
  spraying: {
    maxSafeWindSpeedKmH: 15.0, // Foliar chemical drift risk: sustained wind >= 15 km/h or gusts >= 25 km/h
    maxSafeWindGustKmH: 25.0,
    maxRain3dMm: 5.0, // Wash-off loss risk: cumulative 3-day precipitation >= 5 mm
    source: "DAE & FAO Good Agricultural Practices (GAP) for Pesticide Application",
  },
};

/**
 * WMO Weather Interpretation Codes (WW) with English and Bengali translations.
 */
export const WMO_WEATHER_CODES = {
  0: { en: "Clear sky", bn: "পরিষ্কার আকাশ", icon: "Sun", isHazard: false },
  1: { en: "Mainly clear", bn: "প্রধানত পরিষ্কার", icon: "Sun", isHazard: false },
  2: { en: "Partly cloudy", bn: "আংশিক মেঘলা", icon: "CloudSun", isHazard: false },
  3: { en: "Overcast", bn: "মেঘলা আকাশ", icon: "Cloud", isHazard: false },
  45: { en: "Fog", bn: "কুয়াশা", icon: "CloudFog", isHazard: false },
  48: { en: "Depositing rime fog", bn: "ঘন কুয়াশা", icon: "CloudFog", isHazard: true },
  51: { en: "Light drizzle", bn: "হালকা গুঁড়ি গুঁড়ি বৃষ্টি", icon: "CloudDrizzle", isHazard: false },
  53: { en: "Moderate drizzle", bn: "মাঝারি গুঁড়ি গুঁড়ি বৃষ্টি", icon: "CloudDrizzle", isHazard: false },
  55: { en: "Dense drizzle", bn: "ঘন গুঁড়ি গুঁড়ি বৃষ্টি", icon: "CloudDrizzle", isHazard: false },
  61: { en: "Slight rain", bn: "হালকা বৃষ্টি", icon: "CloudRain", isHazard: false },
  63: { en: "Moderate rain", bn: "মাঝারি বৃষ্টি", icon: "CloudRain", isHazard: false },
  65: { en: "Heavy rain", bn: "ভারী বৃষ্টি", icon: "CloudRain", isHazard: true },
  80: { en: "Slight rain showers", bn: "হালকা পশলা বৃষ্টি", icon: "CloudRain", isHazard: false },
  81: { en: "Moderate rain showers", bn: "মাঝারি পশলা বৃষ্টি", icon: "CloudRain", isHazard: false },
  82: { en: "Violent rain showers", bn: "প্রবল বর্ষণ", icon: "CloudRain", isHazard: true },
  95: { en: "Thunderstorm", bn: "বজ্রঝড়", icon: "CloudLightning", isHazard: true },
  96: { en: "Thunderstorm with slight hail", bn: "শিলাবৃষ্টিসহ বজ্রঝড়", icon: "CloudLightning", isHazard: true },
  99: { en: "Thunderstorm with heavy hail", bn: "তীব্র শিলাবৃষ্টিসহ বজ্রঝড়", icon: "CloudLightning", isHazard: true },
};

/**
 * Resolves location coordinates:
 * Checks farm coordinates first, then district config, then division config.
 */
export function resolveLocationCoordinates(identifier) {
  if (!identifier) return null;

  // If object with lat/lng passed directly
  if (typeof identifier === "object" && Number.isFinite(identifier.latitude) && Number.isFinite(identifier.longitude)) {
    return {
      latitude: identifier.latitude,
      longitude: identifier.longitude,
      locationName: identifier.locationName || identifier.farmName || "Farm Location",
      locationNameBn: identifier.locationNameBn || identifier.farmName || "খামারের অবস্থান",
      type: "farm_coordinates",
      isRepresentative: false,
    };
  }

  const code = String(identifier).toLowerCase().trim();

  // Check District
  const district = DISTRICTS.find((d) => d.code === code);
  if (district) {
    return {
      latitude: district.latitude,
      longitude: district.longitude,
      locationName: district.nameEn,
      locationNameBn: district.nameBn,
      type: "district_centroid",
      isRepresentative: false,
    };
  }

  return null;
}
