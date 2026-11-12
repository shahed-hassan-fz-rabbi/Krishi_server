import test from "node:test";
import assert from "node:assert/strict";
import { gpmFinalDistrictFilter } from "../src/services/nasa/gpm.validation.js";
import { GPM } from "../src/config/gpm.config.js";
import { aggregateBangladeshLocalDays, summarizeGpmLocalDay, validateGpmObservation } from "../src/services/nasa/gpm.validation.js";
import { GpmObservation } from "../src/models/gpmobservation.model.js";

test("GPM config pins Final V07 product and physical fill metadata", () => {
  assert.equal(GPM.shortName, "GPM_3IMERGHH");
  assert.equal(GPM.runType, "Final");
  assert.equal(GPM.version, "07");
  assert.equal(GPM.precipitationUnit, "mm/hr");
  assert.equal(GPM.precipitationFillValue, -9999.9);
});

test("GPM API and GIS share the exact Final V07 product and district scope", () => {
  assert.deepEqual(gpmFinalDistrictFilter("cumilla"), {
    districtCode: "cumilla",
    datasetKey: GPM.datasetKey,
    runType: "Final",
    productVersion: GPM.granuleVersion,
  });
  assert.deepEqual(gpmFinalDistrictFilter("chattogram"), {
    districtCode: "chattogram",
    datasetKey: GPM.datasetKey,
    runType: "Final",
    productVersion: GPM.granuleVersion,
  });
});

test("one actual half-hour interval validates its local day and rate conversion", () => {
  const sample = {
    districtCode: "cumilla",
    intervalStartUtc: "2024-01-01T00:00:00Z",
    intervalEndUtc: "2024-01-01T00:30:00Z",
    dateLabel: "2024-01-01",
    precipitationRateMmHr: 0,
    precipitationMm: 0,
    precipitationQualityIndex: 0.63,
    probabilityLiquidPrecipitationPercent: 100,
    sourceQuality: "valid",
  };
  assert.equal(validateGpmObservation(sample).valid, true);
  assert.equal(validateGpmObservation({ ...sample, precipitationMm: 0.5 }).reason, "invalid_rate_to_interval_amount_conversion");
  assert.equal(validateGpmObservation({ ...sample, dateLabel: "2023-12-31" }).reason, "invalid_bangladesh_local_day");
  assert.equal(validateGpmObservation({ ...sample, intervalEndUtc: "2024-01-01T01:00:00Z" }).reason, "invalid_interval_duration");
});

test("fill values remain missing and never become rainfall zero", () => {
  const missing = {
    districtCode: "cumilla",
    intervalStartUtc: "2024-01-01T00:00:00Z",
    intervalEndUtc: "2024-01-01T00:30:00Z",
    dateLabel: "2024-01-01",
    precipitationRateMmHr: null,
    precipitationMm: null,
    precipitationQualityIndex: null,
    probabilityLiquidPrecipitationPercent: null,
    sourceQuality: "missing_fill",
  };
  assert.equal(validateGpmObservation(missing).valid, true);
  assert.equal(validateGpmObservation({ ...missing, precipitationMm: 0 }).reason, "fill_value_must_not_become_amount");
});

test("local-day aggregation uses UTC+6 boundaries and withholds partial totals", () => {
  const one = {
    districtCode: "cumilla", intervalStartUtc: "2024-01-01T00:00:00Z",
    precipitationMm: 0, sourceQuality: "valid",
  };
  const partial = aggregateBangladeshLocalDays([one])[0];
  assert.equal(partial.dateLabel, "2024-01-01");
  assert.equal(partial.observedIntervals, 1);
  assert.equal(partial.totalPrecipitationMm, null);
  assert.equal(partial.completeness, "incomplete");

  const complete = Array.from({ length: 48 }, (_, i) => ({
    districtCode: "cumilla",
    intervalStartUtc: new Date(Date.UTC(2024, 0, 1, 18) + i * 30 * 60 * 1000).toISOString(),
    precipitationMm: 0.5,
    sourceQuality: "valid",
  }));
  const daily = aggregateBangladeshLocalDays(complete)[0];
  assert.equal(daily.dateLabel, "2024-01-02");
  assert.equal(daily.totalPrecipitationMm, 24);
  assert.equal(daily.completeness, "complete");

  const gap = complete.map((item, index) => index === 12
    ? { ...item, intervalStartUtc: new Date(Date.parse(item.intervalStartUtc) + 30 * 60 * 1000).toISOString() }
    : item);
  const withGap = aggregateBangladeshLocalDays(gap)[0];
  assert.equal(withGap.completeness, "incomplete");
  assert.equal(withGap.totalPrecipitationMm, null);
});

test("requested daily summary reports no total when missing or incomplete", () => {
  const missing = summarizeGpmLocalDay("cumilla", "2024-01-02", []);
  assert.equal(missing.completeness, "incomplete");
  assert.equal(missing.totalPrecipitationMm, null);
  const partial = summarizeGpmLocalDay("cumilla", "2024-01-02", [{ districtCode: "cumilla", intervalStartUtc: "2024-01-01T18:00:00Z", precipitationMm: 0, sourceQuality: "valid" }]);
  assert.equal(partial.observedIntervals, 1);
  assert.equal(partial.totalPrecipitationMm, null);
});

test("GPM observation schema has an idempotent district/granule unique index", () => {
  const index = GpmObservation.schema.indexes().find(([fields, options]) => options.unique && fields.districtCode === 1 && fields.granuleId === 1);
  assert.ok(index);
  assert.ok(GpmObservation.schema.path("precipitationQualityIndex"));
  assert.ok(GpmObservation.schema.path("runType"));
  assert.ok(GpmObservation.schema.path("provenance.algorithmVersion"));
});
