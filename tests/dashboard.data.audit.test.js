import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildDistrictCoverage } from "../src/controllers/datasources.controller.js";

const controllerPath = new URL("../src/controllers/datasources.controller.js", import.meta.url);

test("source catalog computes per-district counts and dates from quality-filtered observations", async () => {
  const source = await readFile(controllerPath, "utf8");
  assert.match(source, /quality: "ok", value: \{ \$type: "number" \}/);
  assert.match(source, /sourceQuality: "valid", precipitationMm: \{ \$type: "number", \$gte: 0 \}/);
  assert.match(source, /retrievalQualityFlag: \{ \$in: \[0, 8\] \}.*qualityClassification: "recommended"/);
  assert.match(source, /isReliableQuality: true, qualityClassification: "good_data", pixelReliability: 0/);
  assert.match(source, /\$group: \{ _id: "\$districtCode", count: \{ \$sum: 1 \}, first: \{ \$min: "\$" \+ ds\.datePath \}, last: \{ \$max: "\$" \+ ds\.datePath \} \}/);
  assert.match(source, /districtValidCoverage: validCoverage/);
});

test("catalog still distinguishes product-wide stored count from district valid coverage", async () => {
  const source = await readFile(controllerPath, "utf8");
  assert.match(source, /observationCount, validObservationCount, districtCoverage:/);
  assert.match(source, /districtValidCoverage:/);
  assert.match(source, /firstObservationDate: d\.first, lastObservationDate: d\.last/);
});

test("district coverage carries independent valid counts, dates, quality, and availability", () => {
  const result = buildDistrictCoverage({
    districtCodes: ["cumilla", "chattogram"],
    storedRows: [{ _id: "cumilla", count: 4 }, { _id: "chattogram", count: 3 }],
    validRows: [
      { _id: "cumilla", count: 3, first: "2024-01-02", last: "2024-01-08" },
      { _id: "chattogram", count: 2, first: "2024-02-18", last: "2024-03-05" },
    ],
    qualityRows: [
      { _id: { districtCode: "cumilla", quality: "recommended" }, count: 3 },
      { _id: { districtCode: "cumilla", quality: "not_recommended" }, count: 1 },
      { _id: { districtCode: "chattogram", quality: "recommended" }, count: 2 },
      { _id: { districtCode: "chattogram", quality: "not_recommended" }, count: 1 },
    ],
  });
  assert.deepEqual(result.validCoverage.cumilla, {
    districtCode: "cumilla", count: 3, firstObservationDate: "2024-01-02", lastObservationDate: "2024-01-08",
    qualityCounts: { recommended: 3, not_recommended: 1 }, availability: "available",
    storedRecordCount: 4, validRecordCount: 3, firstValidObservationDate: "2024-01-02", lastValidObservationDate: "2024-01-08",
  });
  assert.deepEqual(result.validCoverage.chattogram, {
    districtCode: "chattogram", count: 2, firstObservationDate: "2024-02-18", lastObservationDate: "2024-03-05",
    qualityCounts: { recommended: 2, not_recommended: 1 }, availability: "available",
    storedRecordCount: 3, validRecordCount: 2, firstValidObservationDate: "2024-02-18", lastValidObservationDate: "2024-03-05",
  });
  assert.equal(result.districtAvailability.chattogram.districtCode, "chattogram");
  assert.notEqual(result.validCoverage.cumilla.firstObservationDate, result.validCoverage.chattogram.firstObservationDate);
});

test("district catalog reports invalid-only and empty districts without claiming availability", () => {
  const result = buildDistrictCoverage({
    districtCodes: ["cumilla", "chattogram"],
    storedRows: [{ _id: "cumilla", count: 2 }],
    validRows: [],
    qualityRows: [{ _id: { districtCode: "cumilla", quality: "not_recommended" }, count: 2 }],
  });
  assert.equal(result.districtAvailability.cumilla.availability, "no_valid_observations");
  assert.equal(result.districtAvailability.cumilla.validRecordCount, 0);
  assert.equal(result.districtAvailability.cumilla.qualityCounts.not_recommended, 2);
  assert.equal(result.districtAvailability.chattogram.availability, "not_ingested");
  assert.equal(result.districtAvailability.chattogram.firstValidObservationDate, null);
  assert.equal(result.validCoverage.chattogram, undefined);
});

test("latest controllers constrain product and district in database filters", async () => {
  const [gpm, smap, modis, climate, powerService] = await Promise.all([
    readFile(new URL("../src/controllers/gpm.controller.js", import.meta.url), "utf8"),
    readFile(new URL("../src/controllers/smap.controller.js", import.meta.url), "utf8"),
    readFile(new URL("../src/controllers/modis.controller.js", import.meta.url), "utf8"),
    readFile(new URL("../src/controllers/climate.controller.js", import.meta.url), "utf8"),
    readFile(new URL("../src/services/climate/analysis.service.js", import.meta.url), "utf8"),
  ]);
  assert.match(gpm, /gpmFinalDistrictFilter\(v\.district\)/);
  assert.match(gpm, /sourceQuality: "valid",\s*precipitationMm: \{ \$type: "number", \$gte: 0 \}/);
  assert.match(smap, /findOne\(recommendedFilter\)/);
  assert.match(modis, /const reliableFilter = \{\s*districtCode: district,\s*datasetKey: MODIS\.datasetKey,\s*isReliableQuality: true,\s*qualityClassification: "good_data",\s*pixelReliability: 0,/);
  assert.match(modis, /findOne\(reliableFilter\)/);
  assert.match(climate, /countDocuments\(\{\s*datasetKey: DATASET_KEY,\s*districtCode: district/);
  assert.match(powerService, /const query = \{\s*datasetKey: POWER\.datasetKey,\s*districtCode/);
});
