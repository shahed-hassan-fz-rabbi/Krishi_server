/**
 * NASA POWER request + response validation (pure functions, no I/O).
 *
 * Validated against the live POWER Daily API v2.10.3 contract:
 *   envelope: { type, geometry: Point{coordinates:[lon,lat,elev]},
 *               properties: { parameter: { PARAM: { "YYYYMMDD": number } } },
 *               header: { title, api{version}, sources[], fill_value, time_standard, start, end },
 *               messages: [] }
 *
 * Sentinel/integrity rules (binding):
 * - fill_value (-999 family) and any date key missing from a returned series are
 *   classified as quality flags — never defaulted, never converted to 0.
 * - header.time_standard must equal the configured standard ("LST").
 */

import {
  DISTRICTS,
  PARAMETER_CATALOG,
  PARAMETER_NAMES,
  POWER,
  TARGET_RANGE,
} from "../config/climate.config.js";

const DISTRICT_CODES = new Set(DISTRICTS.map((d) => d.code));
const DATE_KEY_RE = /^\d{8}$/; // YYYYMMDD
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YYYYMMDD_RE = /^\d{4}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

/** Normalizes an ISO YYYY-MM-DD date to the POWER YYYYMMDD key format. */
export function toPowerDateKey(isoDate) {
  return isoDate.replaceAll("-", "");
}

/** Converts a POWER YYYYMMDD key to an ISO YYYY-MM-DD label. */
export function toIsoDateLabel(dateKey) {
  if (!DATE_KEY_RE.test(dateKey)) return null;
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

/** True where the string is a strict ISO YYYY-MM-DD date (calendar-validated, no roll-over). */
export function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  // JS Date silently rolls over impossible dates (e.g. 2025-02-30 → Mar 02),
  // so validate components explicitly before trusting the constructor.
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  return true;
}

/** Validates a district code against the two configured districts. */
export function validateDistrictCode(code, errors = []) {
  if (typeof code !== "string" || !DISTRICT_CODES.has(code)) {
    errors.push(
      `district must be one of: ${[...DISTRICT_CODES].join(", ")} (got: ${String(code)})`
    );
  }
  return errors;
}

/** Validates a requested parameter list [subset of the six approved parameters]. */
export function validateParameterList(parameters, errors = []) {
  if (!Array.isArray(parameters) || parameters.length === 0) {
    errors.push("parameters must be a non-empty array");
    return errors;
  }
  if (parameters.length > 20) {
    errors.push("POWER daily API allows at most 20 parameters per request");
  }
  for (const p of parameters) {
    if (!(p in PARAMETER_CATALOG)) {
      errors.push(
        `unknown parameter "${p}" — approved Phase 3 set: ${PARAMETER_NAMES.join(", ")}`
      );
    }
  }
  const dupes = parameters.filter((p, i) => parameters.indexOf(p) !== i);
  if (dupes.length > 0) errors.push(`duplicate parameters: ${[...new Set(dupes)].join(", ")}`);
  return errors;
}

/** Validates an ISO date range against the target historical window (never silently extended). */
export function validateDateRange(startIso, endIso, errors = []) {
  if (!isIsoDate(startIso)) errors.push(`start must be an ISO date YYYY-MM-DD (got: ${startIso})`);
  if (!isIsoDate(endIso)) errors.push(`end must be an ISO date YYYY-MM-DD (got: ${endIso})`);
  if (errors.length > 0) return errors;
  if (startIso > endIso) errors.push(`start (${startIso}) is after end (${endIso})`);
  if (startIso < TARGET_RANGE.start) {
    errors.push(
      `start (${startIso}) precedes the approved target range start (${TARGET_RANGE.start}); ` +
        "extending it silently is not allowed"
    );
  }
  if (endIso > TARGET_RANGE.end) {
    errors.push(
      `end (${endIso}) exceeds the approved target range end (${TARGET_RANGE.end}); ` +
        "extending it silently is not allowed"
    );
  }
  // bounds sanity: <= 120 days per request chunk is enforced by the calling job
  return errors;
}

/** Builds and validates the full POWER point request; returns {errors, url}. */
export function buildPowerUrl({ latitude, longitude, parameters, startIso, endIso }) {
  const errors = [];
  if (typeof latitude !== "number" || latitude < -90 || latitude > 90) {
    errors.push(`latitude must be a number in [-90, 90] (got: ${latitude})`);
  }
  if (typeof longitude !== "number" || longitude < -180 || longitude > 180) {
    errors.push(`longitude must be a number in [-180, 180] (got: ${longitude})`);
  }
  validateParameterList(parameters, errors);
  validateDateRange(startIso, endIso, errors);
  if (errors.length > 0) return { errors, url: null };

  const url = new URL(POWER.endpoint);
  url.searchParams.set("community", POWER.community);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("parameters", parameters.join(","));
  url.searchParams.set("start", toPowerDateKey(startIso));
  url.searchParams.set("end", toPowerDateKey(endIso));
  url.searchParams.set("format", POWER.format);
  return { errors: [], url: url.toString() };
}

/** Enumerates everyDateString between two POWER date keys (function is pure). */
export function enumerateDays(startIso, endIso) {
  const days = [];
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  for (let d = start.getTime(); d <= end.getTime(); d += 86400000) {
    const dt = new Date(d);
    days.push(dt.toISOString().slice(0, 10).replaceAll("-", ""));
  }
  return days;
}

/**
 * Validates the POWER JSON envelope and classifies each daily observation.
 * Returns { errors, data } where data.series[parameter][isoDate] is one of:
 *   { quality: "ok", value }
 *   { quality: "missing_sentinel", sentinelValue }   (value === fill_value)
 *   { quality: "absent" }                             (date key missing from response)
 */
export function validatePowerResponse(raw, { latitude, longitude, parameters, startIso, endIso }) {
  const errors = [];
  if (raw === null || typeof raw !== "object") {
    errors.push("response is not a JSON object");
    return { errors, data: null };
  }
  const header = raw.header;
  const props = raw.properties;
  if (!header || typeof header !== "object") errors.push("missing response envelope `header`");
  if (!props || typeof props !== "object") errors.push("missing response envelope `properties`");
  if (errors.length > 0) return { errors, data: null };

  // header provenance integrity
  if (!header.api || typeof header.api.version !== "string") {
    errors.push("header.api.version missing — provenance cannot be recorded");
  }
  if (!Array.isArray(header.sources) || header.sources.length === 0) {
    errors.push("header.sources missing — provenance cannot be recorded");
  }
  if (typeof header.fill_value !== "number") {
    errors.push(`header.fill_value missing (expected ${POWER.fillValue})`);
  }
  if (header.time_standard !== POWER.timeStandard) {
    errors.push(
      `header.time_standard mismatch: expected "${POWER.timeStandard}", got "${header.time_standard}". ` +
        "Refusing to ingest mixed time standards."
    );
  }
  if (header.start !== toPowerDateKey(startIso) || header.end !== toPowerDateKey(endIso)) {
    errors.push(
      `header echo mismatch: requested ${toPowerDateKey(startIso)}..${toPowerDateKey(endIso)}, ` +
        `got ${header.start}..${header.end}`
    );
  }

  // geometry echo (POWER rounds to 3 decimals; we accept that but record both requested & echoed)
  let echoedCoordinates = null;
  if (raw.geometry && raw.geometry.type === "Point" && Array.isArray(raw.geometry.coordinates)) {
    echoedCoordinates = raw.geometry.coordinates.slice(0, 2); // [lon, lat]
  }

  const params = props.parameter;
  if (!params || typeof params !== "object") {
    errors.push("properties.parameter missing");
    return { errors, data: null };
  }

  const expectedKeys = enumerateDays(startIso, endIso);
  // Server echoes may exclude trailing days beyond its publication edge; any gap is
  // recorded as an `absent` quality flag with the full accounting (never silent).
  const series = {};
  const perParameter = {};
  for (const param of parameters) {
    const source = params[param];
    if (!source || typeof source !== "object") {
      errors.push(`parameter "${param}" absent from response`);
      continue;
    }
    const fillValue = header.fill_value ?? POWER.fillValue;
    const observations = {};
    let okCount = 0;
    let sentinelCount = 0;
    let absentCount = 0;
    for (const dateKey of expectedKeys) {
      const iso = toIsoDateLabel(dateKey);
      if (!(dateKey in source)) {
        observations[iso] = { quality: "absent" };
        absentCount += 1;
        continue;
      }
      const value = source[dateKey];
      if (typeof value !== "number" || Number.isNaN(value)) {
        errors.push(`parameter "${param}" date ${dateKey} is not a number (got: ${String(value)})`);
        continue;
      }
      if (value === fillValue || value <= -900) {
        observations[iso] = { quality: "missing_sentinel", sentinelValue: value };
        sentinelCount += 1;
        continue;
      }
      observations[iso] = { quality: "ok", value };
      okCount += 1;
    }
    series[param] = observations;
    perParameter[param] = {
      okCount,
      sentinelCount,
      absentCount,
      totalCount: expectedKeys.length,
    };
  }

  // top-level `parameters` unit block (units + long names per response)
  const unitBlock = {};
  if (raw.parameters && typeof raw.parameters === "object") {
    for (const [p, meta] of Object.entries(raw.parameters)) {
      if (meta && typeof meta === "object") {
        unitBlock[p] = { units: meta.units ?? null, longname: meta.longname ?? null };
      }
    }
  }

  return {
    errors,
    data: {
      header: {
        title: header.title ?? null,
        apiVersion: header.api?.version ?? null,
        apiName: header.api?.name ?? null,
        sources: header.sources ?? [],
        fillValue: header.fill_value ?? null,
        timeStandard: header.time_standard ?? null,
        start: header.start ?? null,
        end: header.end ?? null,
      },
      units: unitBlock,
      geometryEchoed: echoedCoordinates,
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      series,
      perParameter,
      expectedDayCount: expectedKeys.length,
    },
  };
}
