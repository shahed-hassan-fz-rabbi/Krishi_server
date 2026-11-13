import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isRecommendedSmapObservation, latestRecommendedSmapSnapshot } from "../src/services/nasa/smap.quality.js";
import { isGoodModisObservation, latestGoodModisSnapshot } from "../src/services/nasa/modis.quality.js";
import { summarizeGpmLocalDay } from "../src/services/nasa/gpm.validation.js";

const smap = (flag, extra = {}) => ({ districtCode: "cumilla", datasetKey: "nasa:smap:spl3smp_e:v006", dateLabel: "2024-01-03", retrievalQualityFlag: flag, isRecommendedQuality: [0, 8].includes(flag), qualityClassification: [0, 8].includes(flag) ? "recommended" : "not_recommended", soilMoisture: 0.31, ...extra });
const modis = (rank, extra = {}) => ({ districtCode: "cumilla", datasetKey: "nasa:modis:mod13q1:v061", dateLabel: "2024-02-18", pixelReliability: rank, isReliableQuality: rank === 0, qualityClassification: rank === 0 ? "good_data" : rank === 1 ? "marginal_data" : rank === 2 ? "snow_ice" : "cloudy", ndvi: 0.4, evi: 0.2, ...extra });

describe("Shared NASA observation quality gates", () => {
  test("SMAP accepts recommended flags 0 and 8 and rejects 9, fill, missing metadata and other districts", () => {
    for (const flag of [0, 8]) assert.equal(isRecommendedSmapObservation(smap(flag), "cumilla"), true);
    for (const record of [
      smap(9), smap(0, { retrievalQualityFlag: undefined }), smap(0, { isRecommendedQuality: undefined }),
      smap(0, { qualityClassification: undefined }), smap(0, { soilMoisture: -9999 }), smap(0, { soilMoisture: 0.91 }),
      smap(0, { soilMoisture: null }), smap(0, { districtCode: "chattogram" }), smap(0, { dateLabel: null }),
    ]) assert.equal(isRecommendedSmapObservation(record, "cumilla"), false);
  });

  test("SMAP snapshot selection skips newer rejected rows and isolates district", () => {
    const snapshot = { observations: [smap(9, { dateLabel: "2024-01-05" }), smap(8, { dateLabel: "2024-01-03" })] };
    assert.equal(latestRecommendedSmapSnapshot(snapshot, "cumilla").dateLabel, "2024-01-03");
    assert.equal(latestRecommendedSmapSnapshot(snapshot, "chattogram"), null);
  });

  test("MODIS only rank 0 good observations pass; ranks 1/2/3 and absent metadata fail", () => {
    assert.equal(isGoodModisObservation(modis(0), "cumilla"), true);
    for (const record of [modis(1), modis(2), modis(3), modis(0, { pixelReliability: undefined }),
      modis(0, { isReliableQuality: undefined }), modis(0, { qualityClassification: undefined }),
      modis(0, { ndvi: 2, evi: null }), modis(0, { dateLabel: "2024-02-30" }), modis(0, { districtCode: "chattogram" })]) {
      assert.equal(isGoodModisObservation(record, "cumilla"), false);
    }
  });

  test("MODIS snapshot selection skips newer marginal records", () => {
    const snapshot = { observations: [modis(1, { dateLabel: "2024-02-20" }), modis(0, { dateLabel: "2024-02-18" })] };
    assert.equal(latestGoodModisSnapshot(snapshot, "cumilla").dateLabel, "2024-02-18");
    assert.equal(latestGoodModisSnapshot(snapshot, "chattogram"), null);
  });

  test("GPM preserves complete 0 mm and withholds incomplete-day total", () => {
    const day = "2024-01-07";
    const start = Date.parse(`${day}T00:00:00+06:00`);
    const rows = Array.from({ length: 48 }, (_, index) => {
      const intervalStartUtc = new Date(start + index * 30 * 60 * 1000).toISOString();
      return { districtCode: "cumilla", dateLabel: day, intervalStartUtc,
        intervalEndUtc: new Date(Date.parse(intervalStartUtc) + 30 * 60 * 1000).toISOString(),
        precipitationMm: 0, precipitationRateMmHr: 0, sourceQuality: "valid" };
    });
    const complete = summarizeGpmLocalDay("cumilla", day, rows);
    assert.equal(complete.completeness, "complete");
    assert.equal(complete.validIntervals, 48);
    assert.equal(complete.totalPrecipitationMm, 0);
    const incomplete = summarizeGpmLocalDay("cumilla", day, rows.slice(0, 47));
    assert.equal(incomplete.completeness, "incomplete");
    assert.equal(incomplete.totalPrecipitationMm, null);
  });
});
