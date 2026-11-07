/**
 * Known-answer + contract tests for the NASA POWER validators (zero network).
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPowerUrl,
  enumerateDays,
  isIsoDate,
  toIsoDateLabel,
  toPowerDateKey,
  validateDateRange,
  validateDistrictCode,
  validateParameterList,
  validatePowerResponse,
} from "../src/validators/power.validator.js";
import { DISTRICTS, PARAMETER_NAMES, POWER } from "../src/config/climate.config.js";

const CHATTOGRAM = DISTRICTS[0]; // exact configured coordinates
const CUMILLA = DISTRICTS[1];

/** Builds a syntactically valid POWER envelope fixture. */
function makeEnvelope({ startIso, endIso, params = PARAMETER_NAMES, fillValue = POWER.fillValue, timeStandard = "LST", omitKeys = [] }) {
  const days = enumerateDays(startIso, endIso);
  const parameter = {};
  for (const p of params) {
    parameter[p] = {};
    days.forEach((d, i) => {
      if (omitKeys.includes(`${p}:${d}`)) return; // simulate absent date key
      parameter[p][d] = i === 2 ? fillValue : 10 + i; // one sentinel per test
    });
  }
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [91.832, 22.338, 34.35] },
    properties: { parameter },
    header: {
      title: "NASA/POWER Source Native Resolution Daily Data",
      api: { version: "v2.10.3", name: "POWER Daily API" },
      sources: ["MERRA2", "SYN1DEG", "POWER"],
      fill_value: fillValue,
      time_standard: timeStandard,
      start: toPowerDateKey(startIso),
      end: toPowerDateKey(endIso),
    },
    parameters: Object.fromEntries(
      params.map((p) => [
        p,
        { units: { PRECTOTCORR: "mm/day" }[p] ?? "C", longname: "x" },
      ])
    ),
    messages: [],
  };
}

// ---------- date helpers ----------
test("toPowerDateKey/toIsoDateLabel round-trip", () => {
  assert.equal(toPowerDateKey("2001-01-01"), "20010101");
  assert.equal(toIsoDateLabel("20010101"), "2001-01-01");
  assert.equal(toIsoDateLabel("bad"), null);
});

test("isIsoDate rejects malformed input", () => {
  assert.equal(isIsoDate("2025-2-30"), false);
  assert.equal(isIsoDate("2025-02-30"), false); // impossible calendar date
  assert.equal(isIsoDate("2024-02-29"), true); // leap day valid
  assert.equal(isIsoDate(null), false);
});

test("enumerateDays counts leap years correctly", () => {
  assert.equal(enumerateDays("2001-01-01", "2001-12-31").length, 365);
  assert.equal(enumerateDays("2024-01-01", "2024-12-31").length, 366);
  assert.equal(enumerateDays("2001-01-01", "2001-01-02")[1], "20010102");
});

// ---------- request validation ----------
test("district codes accept only the two configured districts", () => {
  assert.equal(validateDistrictCode("chattogram").length, 0);
  assert.equal(validateDistrictCode("cumilla").length, 0);
  assert.equal(validateDistrictCode("dhaka").length, 1);
  assert.equal(validateDistrictCode("").length, 1);
});

test("parameter list rejects unapproved parameters and duplicates", () => {
  assert.equal(validateParameterList([...PARAMETER_NAMES]).length, 0);
  assert.equal(validateParameterList(["SMAP"]).length > 0, true);
  assert.equal(validateParameterList(["T2M", "T2M"]).length, 1);
  assert.equal(validateParameterList([]).length, 1);
});

test("date range refuses silent extension beyond the approved target window", () => {
  assert.equal(validateDateRange("2001-01-01", "2025-12-31").length, 0);
  assert.equal(validateDateRange("2000-12-31", "2025-12-31").length, 1);
  assert.equal(validateDateRange("2001-01-01", "2026-01-01").length, 1);
  assert.equal(validateDateRange("2025-12-31", "2001-01-01").length, 1);
});

test("buildPowerUrl produces the verified request contract", () => {
  const { errors, url } = buildPowerUrl({
    latitude: CHATTOGRAM.latitude,
    longitude: CHATTOGRAM.longitude,
    parameters: [...PARAMETER_NAMES],
    startIso: "2001-01-01",
    endIso: "2001-01-07",
  });
  assert.equal(errors.length, 0);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, POWER.endpoint);
  assert.equal(u.searchParams.get("community"), "AG");
  assert.equal(u.searchParams.get("latitude"), "22.3384");
  assert.equal(u.searchParams.get("longitude"), "91.8317");
  assert.equal(u.searchParams.get("parameters"), PARAMETER_NAMES.join(","));
  assert.equal(u.searchParams.get("start"), "20010101");
  assert.equal(u.searchParams.get("end"), "20010107");
  assert.equal(u.searchParams.get("format"), "JSON");
});

test("buildPowerUrl rejects non-configured coordinate substitution types", () => {
  const { errors } = buildPowerUrl({
    latitude: "22.3384", // string, not number — intent error, not a formatting one
    longitude: CUMILLA.longitude,
    parameters: [...PARAMETER_NAMES],
    startIso: "2001-01-01",
    endIso: "2001-01-07",
  });
  assert.equal(errors.length, 1);
});

// ---------- response validation ----------
function makeRequest() {
  return {
    latitude: CHATTOGRAM.latitude,
    longitude: CHATTOGRAM.longitude,
    parameters: [...PARAMETER_NAMES],
    startIso: "2001-01-01",
    endIso: "2001-01-05",
  };
}

test("a live-contract-shaped envelope validates cleanly with units echoed", () => {
  const req = makeRequest();
  const { errors, data } = validatePowerResponse(makeEnvelope(req), req);
  assert.equal(errors.length, 0);
  assert.equal(data.header.fillValue, POWER.fillValue);
  assert.equal(data.header.timeStandard, "LST");
  assert.equal(data.header.apiVersion, "v2.10.3");
  assert.deepEqual(data.units.PRECTOTCORR, { units: "mm/day", longname: "x" });
  assert.equal(data.expectedDayCount, 5);
  assert.ok(data.geometryEchoed); // [lon, lat]
  for (const [param, meta] of Object.entries(data.perParameter)) {
    assert.equal(meta.sentinelCount, 1, `${param} had one sentinel`);
    assert.equal(meta.okCount, 4);
    assert.equal(meta.absentCount, 0);
  }
  // Day index 2 is the synthetic sentinel → flagged, NOT converted to 0
  const flagged = data.series.T2M["2001-01-03"];
  assert.equal(flagged.quality, "missing_sentinel");
  assert.equal(flagged.sentinelValue, POWER.fillValue);
  assert.equal(flagged.value, undefined);
  // Valid days carry numeric values only
  assert.equal(data.series.T2M["2001-01-01"].quality, "ok");
  assert.equal(typeof data.series.T2M["2001-01-01"].value, "number");
});

test("date keys absent from the response are classified `absent`, never defaulted", () => {
  const req = makeRequest();
  const env = makeEnvelope({ ...req, omitKeys: ["PRECTOTCORR:20010104"] });
  const { errors, data } = validatePowerResponse(env, req);
  assert.equal(errors.length, 0);
  assert.equal(data.series.PRECTOTCORR["2001-01-04"].quality, "absent");
  assert.equal(data.perParameter.PRECTOTCORR.absentCount, 1);
});

test("mismatched time standard is refused (mixed standards are prohibited)", () => {
  const req = makeRequest();
  const env = makeEnvelope({ ...req, timeStandard: "UTC" });
  const { errors } = validatePowerResponse(env, req);
  assert.ok(errors.some((e) => e.includes("time_standard mismatch")));
});

test("header date echo mismatch is refused", () => {
  const req = makeRequest();
  const env = makeEnvelope({ ...req, timeStandard: "LST" });
  env.header.start = "20010110";
  const { errors } = validatePowerResponse(env, req);
  assert.ok(errors.some((e) => e.includes("header echo mismatch")));
});

test("alternate fill value from the header is honored for classification", () => {
  const req = makeRequest();
  const env = makeEnvelope({ ...req, fillValue: -99 });
  const { errors, data } = validatePowerResponse(env, req);
  assert.equal(errors.length, 0);
  assert.equal(data.series.T2M["2001-01-03"].quality, "missing_sentinel");
  assert.equal(data.series.T2M["2001-01-03"].sentinelValue, -99);
});

test("malformed envelopes are rejected without partial ingestion", () => {
  const req = makeRequest();
  assert.ok(validatePowerResponse(null, req).errors.length > 0);
  assert.ok(validatePowerResponse({}, req).errors.length >= 2); // missing header + properties
  const env = makeEnvelope(req);
  delete env.properties.parameter.T2M;
  const { errors } = validatePowerResponse(env, req);
  assert.ok(errors.some((e) => e.includes('"T2M" absent from response')));
});
