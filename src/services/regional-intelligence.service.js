import { DIVISIONS } from "../config/division.config.js";
import { TARGET_RANGE } from "../config/climate.config.js";
import { fetchPowerChunk } from "./nasa/power.client.js";

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();
const inflight = new Map();
const POWER_PARAMETERS = ["PRECTOTCORR", "T2M", "RH2M", "ALLSKY_SFC_SW_DWN"];

function summarizeParameter(parsed, parameter) {
  const observations = Object.entries(parsed?.series?.[parameter] || {})
    .filter(([, row]) => row?.quality === "ok" && Number.isFinite(row.value))
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB));
  if (!observations.length) return null;
  const mean = observations.reduce((sum, [, row]) => sum + row.value, 0) / observations.length;
  return {
    value: Number(mean.toFixed(3)),
    firstObservationDate: observations[0][0],
    observationDate: observations.at(-1)[0],
    validObservationCount: observations.length,
    quality: "validated_valid_rows_only",
    unit: parsed.units?.[parameter]?.units || null,
  };
}

export function getDivisionByCode(code) {
  return DIVISIONS.find((division) => division.code === code) || null;
}

export function summarizePowerParameters(parsed) {
  return {
    rainfall: summarizeParameter(parsed, "PRECTOTCORR"),
    temperature: summarizeParameter(parsed, "T2M"),
    relativeHumidity: summarizeParameter(parsed, "RH2M"),
    solarIrradiance: summarizeParameter(parsed, "ALLSKY_SFC_SW_DWN"),
    sourceMetadata: parsed?.header || null,
    timeStandard: parsed?.header?.timeStandard || null,
  };
}

async function loadRegionalIntelligence(division) {
  const key = division.code;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return {
      ...cached.payload,
      datasets: {
        ...cached.payload.datasets,
        power: { ...cached.payload.datasets.power, provenance: "CACHED" },
      },
    };
  }
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    const end = TARGET_RANGE.end;
    const endYear = Number(end.slice(0, 4));
    const start = String(endYear - 4) + "-01-01";
    const result = await fetchPowerChunk({
      latitude: division.latitude,
      longitude: division.longitude,
      parameters: POWER_PARAMETERS,
      startIso: start,
      endIso: end,
    });

    const summary = result.ok ? summarizePowerParameters(result.data) : null;
    const power = result.ok
      ? {
          status: [summary.rainfall, summary.temperature, summary.relativeHumidity, summary.solarIrradiance].some(Boolean) ? "available" : "unavailable",
          provenance: "LIVE_FETCHED",
          dataset: "NASA POWER daily point historical data",
          observationWindow: { requestedStart: start, requestedEnd: end },
          metrics: summary,
          limitations: "Five-year historical point summary; not live weather or a division-wide average. Dates use NASA POWER Local Solar Time.",
          reason: [summary.rainfall, summary.temperature, summary.relativeHumidity, summary.solarIrradiance].some(Boolean)
            ? null
            : "NASA POWER returned no valid observations for this representative point and requested window.",
        }
      : {
          status: "unavailable",
          provenance: "UNAVAILABLE",
          dataset: "NASA POWER daily point historical data",
          error: "NASA POWER could not return a validated response for this point.",
          httpStatus: result.httpStatus || null,
        };

    const unavailable = (dataset, reason) => ({
      status: "unavailable",
      provenance: "UNAVAILABLE",
      dataset,
      reason,
      metrics: null,
    });

    const payload = {
      division: {
        code: division.code,
        nameEn: division.nameEn,
        nameBn: division.nameBn,
        representativePoint: { latitude: division.latitude, longitude: division.longitude },
        pointMethod: division.pointMethod,
        limitation: division.limitation,
      },
      datasets: {
        power,
        gpm: unavailable(
          "NASA GPM IMERG V07 Final",
          "No validated GPM sample is currently stored or extracted at this division representative point. A nearby district observation is not substituted."
        ),
        smap: unavailable(
          "NASA SMAP SPL3SMP_E V006",
          "No quality-approved SMAP sample is currently stored or extracted at this division representative point."
        ),
        modis: unavailable(
          "NASA MODIS MOD13Q1.061",
          "No quality-validated MODIS composite is currently stored or extracted at this division representative point."
        ),
      },
      generatedAt: new Date().toISOString(),
    };
    cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
    return payload;
  })().finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

export async function getRegionalIntelligence(code) {
  const division = getDivisionByCode(code);
  if (!division) return null;
  return loadRegionalIntelligence(division);
}

export function clearRegionalIntelligenceCache() {
  cache.clear();
  inflight.clear();
}
