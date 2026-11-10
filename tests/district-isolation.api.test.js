import test from "node:test";
import assert from "node:assert/strict";
import { getLatestGpm } from "../src/controllers/gpm.controller.js";
import { getLatestSoilMoisture } from "../src/controllers/smap.controller.js";
import { getLatestVegetation } from "../src/controllers/modis.controller.js";
import { GPM } from "../src/config/gpm.config.js";
import { SMAP } from "../src/config/smap.config.js";
import { MODIS } from "../src/config/modis.config.js";
import { GpmObservation } from "../src/models/gpmobservation.model.js";
import { SmapObservation } from "../src/models/smapobservation.model.js";
import { ModisObservation } from "../src/models/modisobservation.model.js";
import { snapshotService } from "../src/services/snapshot.service.js";

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("GPM, SMAP, and MODIS latest controllers isolate both districts", async (t) => {
  t.mock.method(snapshotService, "isDbConnected", () => true);
  const fixtures = {
    cumilla: {
      gpm: { districtCode: "cumilla", dateLabel: "2024-01-01", intervalStartUtc: new Date("2023-12-31T18:00:00Z"), intervalEndUtc: new Date("2023-12-31T18:30:00Z"), precipitationRateMmHr: 2, precipitationMm: 1, sourceQuality: "valid" },
      smap: { districtCode: "cumilla", datasetKey: SMAP.datasetKey, dateLabel: "2024-01-03", orbit: "AM", soilMoisture: 0.31, retrievalQualityFlag: 8, isRecommendedQuality: true, qualityClassification: "recommended" },
      modis: { districtCode: "cumilla", datasetKey: MODIS.datasetKey, dateLabel: "2023-12-19", ndvi: 0.42, evi: 0.21, pixelReliability: 0, isReliableQuality: true, qualityClassification: "good_data" },
    },
    chattogram: {
      gpm: { districtCode: "chattogram", dateLabel: "2024-01-02", intervalStartUtc: new Date("2024-01-01T18:00:00Z"), intervalEndUtc: new Date("2024-01-01T18:30:00Z"), precipitationRateMmHr: 3, precipitationMm: 1.5, sourceQuality: "valid" },
      smap: { districtCode: "chattogram", datasetKey: SMAP.datasetKey, dateLabel: "2024-01-08", orbit: "PM", soilMoisture: 0.28, retrievalQualityFlag: 0, isRecommendedQuality: true, qualityClassification: "recommended" },
      modis: { districtCode: "chattogram", datasetKey: MODIS.datasetKey, dateLabel: "2024-02-18", ndvi: 0.68, evi: 0.39, pixelReliability: 0, isReliableQuality: true, qualityClassification: "good_data" },
    },
  };

  t.mock.method(GpmObservation, "countDocuments", async (filter) => {
    assert.ok(["cumilla", "chattogram"].includes(filter.districtCode));
    assert.equal(filter.datasetKey, GPM.datasetKey);
    return 1;
  });
  t.mock.method(GpmObservation, "findOne", (filter) => {
    assert.equal(filter.districtCode, filter.districtCode.trim().toLowerCase());
    assert.equal(filter.datasetKey, GPM.datasetKey);
    return { sort() { return this; }, lean: async () => fixtures[filter.districtCode].gpm };
  });
  t.mock.method(GpmObservation, "find", (filter) => ({
    sort() { return this; },
    lean: async () => [fixtures[filter.districtCode].gpm],
  }));

  t.mock.method(SmapObservation, "countDocuments", async (filter) => {
    assert.equal(filter.datasetKey, SMAP.datasetKey);
    assert.deepEqual(filter.retrievalQualityFlag.$in, [0, 8]);
    return 1;
  });
  t.mock.method(SmapObservation, "findOne", (filter) => ({
    sort() { return this; },
    lean: async () => fixtures[filter.districtCode].smap,
  }));
  t.mock.method(SmapObservation, "find", (filter) => ({
    lean: async () => [fixtures[filter.districtCode].smap],
  }));

  t.mock.method(ModisObservation, "countDocuments", async (filter) => {
    assert.equal(filter.datasetKey, MODIS.datasetKey);
    assert.equal(filter.pixelReliability, 0);
    return 1;
  });
  t.mock.method(ModisObservation, "findOne", (filter) => ({
    sort() { return this; },
    lean: async () => fixtures[filter.districtCode].modis,
  }));

  for (const district of ["cumilla", "chattogram"]) {
    const gpmRes = responseRecorder();
    await getLatestGpm({ query: { district } }, gpmRes, (error) => { throw error; });
    assert.equal(gpmRes.statusCode, 200);
    assert.equal(gpmRes.body.data.districtCode, district);
    assert.equal(gpmRes.body.data.latestInterval.observationDate, fixtures[district].gpm.dateLabel);

    const smapRes = responseRecorder();
    await getLatestSoilMoisture({ query: { district } }, smapRes, (error) => { throw error; });
    assert.equal(smapRes.statusCode, 200);
    assert.equal(smapRes.body.data.districtCode, district);
    assert.equal(smapRes.body.data.dateLabel, fixtures[district].smap.dateLabel);
    assert.equal(smapRes.body.data.isRecommendedQuality, true);

    const modisRes = responseRecorder();
    await getLatestVegetation({ query: { district } }, modisRes, (error) => { throw error; });
    assert.equal(modisRes.statusCode, 200);
    assert.equal(modisRes.body.data.districtCode, district);
    assert.equal(modisRes.body.data.dateLabel, fixtures[district].modis.dateLabel);
    assert.equal(modisRes.body.data.isReliableQuality, true);
  }
});

test("latest environmental endpoints return unavailable when the district has no valid observation", async (t) => {
  t.mock.method(snapshotService, "isDbConnected", () => true);
  t.mock.method(GpmObservation, "countDocuments", async () => 0);
  t.mock.method(SmapObservation, "countDocuments", async () => 0);
  t.mock.method(ModisObservation, "countDocuments", async () => 0);

  const cases = [
    [getLatestGpm, "district", "chattogram"],
    [getLatestSoilMoisture, "district", "chattogram"],
    [getLatestVegetation, "district", "chattogram"],
  ];
  for (const [controller, parameter, value] of cases) {
    const res = responseRecorder();
    await controller({ query: { [parameter]: value } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, "DATA_NO_VALID_OBSERVATIONS");
    assert.equal(res.body.data, undefined);
  }
});
