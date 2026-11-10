import test from "node:test";
import assert from "node:assert/strict";
import { DIVISIONS } from "../src/config/division.config.js";
import { getDivisionByCode, summarizePowerParameters } from "../src/services/regional-intelligence.service.js";

test("regional division catalog exposes eight unique, in-bounds representative points", () => {
  assert.equal(DIVISIONS.length, 8);
  assert.deepEqual(DIVISIONS.map((division) => division.code), [
    "dhaka", "chattogram", "rajshahi", "khulna", "barishal", "sylhet", "rangpur", "mymensingh",
  ]);
  assert.equal(new Set(DIVISIONS.map((division) => division.code)).size, 8);
  for (const division of DIVISIONS) {
    assert.ok(division.latitude >= 20.5 && division.latitude <= 26.7);
    assert.ok(division.longitude >= 88 && division.longitude <= 92.8);
    assert.equal(division.pointMethod, "BBS division polygon centroid");
    assert.match(division.limitation, /One representative point/);
  }
});

test("division lookup rejects unknown codes without falling back to a different division", () => {
  assert.equal(getDivisionByCode("dhaka").code, "dhaka");
  assert.equal(getDivisionByCode("cumilla"), null);
  assert.equal(getDivisionByCode("unknown"), null);
});

test("POWER summary uses only validated finite rows and retains actual date and unit metadata", () => {
  const summary = summarizePowerParameters({
    series: {
      PRECTOTCORR: {
        "2025-01-01": { quality: "ok", value: 4 },
        "2025-01-02": { quality: "missing_sentinel", sentinelValue: -999 },
        "2025-01-03": { quality: "ok", value: 2 },
        "2025-01-04": { quality: "ok", value: Infinity },
      },
    },
    units: { PRECTOTCORR: { units: "mm/day" } },
    header: { timeStandard: "LST" },
  });
  assert.equal(summary.rainfall.value, 3);
  assert.equal(summary.rainfall.firstObservationDate, "2025-01-01");
  assert.equal(summary.rainfall.observationDate, "2025-01-03");
  assert.equal(summary.rainfall.validObservationCount, 2);
  assert.equal(summary.rainfall.unit, "mm/day");
  assert.equal(summary.temperature, null);
  assert.equal(summary.timeStandard, "LST");
});
