import test from "node:test";
import assert from "node:assert/strict";
import { getLatestVegetation } from "../src/controllers/modis.controller.js";
import { MODIS } from "../src/config/modis.config.js";
import { ModisObservation } from "../src/models/modisobservation.model.js";
import { snapshotService } from "../src/services/snapshot.service.js";
import { getCropCalendarAlignment } from "../src/controllers/cropcalendar.controller.js";
import { SmapObservation } from "../src/models/smapobservation.model.js";

function recorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function row(districtCode, dateLabel, overrides = {}) {
  return {
    districtCode,
    datasetKey: MODIS.datasetKey,
    dateLabel,
    ndvi: 0.4,
    evi: 0.2,
    pixelReliability: 0,
    isReliableQuality: true,
    qualityClassification: "good_data",
    ...overrides,
  };
}

function assertGoodFilter(filter, district) {
  assert.equal(filter.districtCode, district);
  assert.equal(filter.datasetKey, MODIS.datasetKey);
  assert.equal(filter.pixelReliability, 0);
  assert.equal(filter.isReliableQuality, true);
  assert.equal(filter.qualityClassification, "good_data");
  assert.equal(filter.dateLabel.$type, "string");
  assert.ok(filter.dateLabel.$regex.test("2024-02-18"));
  assert.ok(!filter.dateLabel.$regex.test(""));
  assert.equal(filter.$or.length, 2);
  for (const clause of filter.$or) {
    const name = Object.keys(clause)[0];
    assert.ok(["ndvi", "evi"].includes(name));
    assert.equal(clause[name].$type, "number");
    assert.equal(clause[name].$gte, MODIS.layers[name].validMin);
    assert.equal(clause[name].$lte, MODIS.layers[name].validMax);
  }
}

test("latest MODIS returns the newest rank-0 record per district, never a newer marginal record", async (t) => {
  t.mock.method(snapshotService, "isDbConnected", () => true);
  const validByDistrict = {
    cumilla: row("cumilla", "2023-12-19", { evi: 1.4 }),
    chattogram: row("chattogram", "2024-02-18"),
  };
  t.mock.method(ModisObservation, "countDocuments", async (filter) => {
    assertGoodFilter(filter, filter.districtCode);
    return 1;
  });
  t.mock.method(ModisObservation, "findOne", (filter) => {
    assertGoodFilter(filter, filter.districtCode);
    const district = filter.districtCode;
    // The simulated collection contains newer rank-1 rows; the quality filter
    // is what allows the older eligible row to be selected instead.
    const rows = [
      row(district, "2024-02-18", { pixelReliability: 1, isReliableQuality: false, qualityClassification: "marginal_data" }),
      validByDistrict[district],
    ].filter((observation) =>
      observation.districtCode === district &&
      observation.datasetKey === filter.datasetKey &&
      observation.pixelReliability === filter.pixelReliability &&
      observation.isReliableQuality === filter.isReliableQuality &&
      observation.qualityClassification === filter.qualityClassification &&
      filter.$or.some((clause) => {
        const key = Object.keys(clause)[0];
        return Number.isFinite(observation[key]) && observation[key] >= clause[key].$gte && observation[key] <= clause[key].$lte;
      })
    );
    return { sort() { rows.sort((a, b) => b.dateLabel.localeCompare(a.dateLabel)); return this; }, lean: async () => rows[0] || null };
  });

  for (const district of ["cumilla", "chattogram"]) {
    const res = recorder();
    await getLatestVegetation({ query: { district } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.districtCode, district);
    assert.equal(res.body.data.dateLabel, validByDistrict[district].dateLabel);
    assert.equal(res.body.data.pixelReliability, 0);
    assert.equal(res.body.data.qualityClassification, "good_data");
    assert.equal(res.body.data.evi, district === "cumilla" ? null : 0.2);
  }
});

test("latest MODIS is unavailable when no rank-0 row passes quality, date, and value filters", async (t) => {
  t.mock.method(snapshotService, "isDbConnected", () => true);
  t.mock.method(snapshotService, "getModisSnapshot", () => null);
  t.mock.method(ModisObservation, "countDocuments", async (filter) => {
    assertGoodFilter(filter, "cumilla");
    // Simulates only marginal, missing-quality, missing-date, cross-district,
    // fill, and out-of-range rows. None match the rank-0 query.
    return 0;
  });
  t.mock.method(ModisObservation, "findOne", () => { throw new Error("no latest query expected"); });

  const res = recorder();
  await getLatestVegetation({ query: { district: "cumilla" } }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, "DATA_NO_VALID_OBSERVATIONS");
  assert.equal(res.body.data, undefined);
});

test("offline snapshot skips a newer marginal record and selects the newest eligible good record", async (t) => {
  t.mock.method(snapshotService, "isDbConnected", () => false);
  const good = row("cumilla", "2023-12-19");
  const marginal = row("cumilla", "2024-02-18", { pixelReliability: 1, isReliableQuality: false, qualityClassification: "marginal_data" });
  t.mock.method(snapshotService, "getModisSnapshot", (district) => ({
    latest: marginal,
    observations: [marginal, good],
    snapshotMetadata: { limitations: "offline reference" },
  }));

  const res = recorder();
  await getLatestVegetation({ query: { district: "cumilla" } }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.meta.provenance, "SNAPSHOT");
  assert.equal(res.body.data.dateLabel, "2023-12-19");
  assert.equal(res.body.data.pixelReliability, 0);
});

test("offline snapshot with only marginal or malformed rank-0 rows remains unavailable", async (t) => {
  t.mock.method(snapshotService, "isDbConnected", () => false);
  t.mock.method(snapshotService, "getModisSnapshot", () => ({
    latest: row("cumilla", "2024-02-18", { pixelReliability: 1, isReliableQuality: false, qualityClassification: "marginal_data" }),
    observations: [
      row("cumilla", "2024-02-18", { pixelReliability: 1, isReliableQuality: false, qualityClassification: "marginal_data" }),
      row("cumilla", "not-a-date"),
      row("cumilla", "2024-02-01", { datasetKey: undefined }),
      row("cumilla", "2024-01-01", { ndvi: -3000, evi: 1.2 }),
      row("chattogram", "2024-03-01"),
    ],
  }));

  const res = recorder();
  await getLatestVegetation({ query: { district: "cumilla" } }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, "DATA_NO_VALID_OBSERVATIONS");
});

function queryResult(value) {
  return { sort() { return this; }, lean: async () => value };
}

function queryRows(values) {
  return { sort() { return this; }, lean: async () => values };
}

test("crop-calendar alignment returns district-matched rank-0 MODIS and recommended SMAP only", async (t) => {
  const goodByDistrict = {
    cumilla: row("cumilla", "2023-12-19"),
    chattogram: row("chattogram", "2024-02-18"),
  };
  const smapFilters = [];
  const modisFilters = [];
  t.mock.method(SmapObservation, "findOne", (filter) => {
    smapFilters.push(filter);
    return queryResult({ districtCode: filter.districtCode, soilMoisture: 0.31, unit: "m^3/m^3", dateLabel: "2024-01-08", retrievalQualityFlag: 8, isRecommendedQuality: true, qualityClassification: "recommended" });
  });
  t.mock.method(ModisObservation, "find", (filter) => {
    modisFilters.push(filter);
    assertGoodFilter(filter, filter.districtCode);
    return queryRows([goodByDistrict[filter.districtCode]]);
  });

  for (const district of ["cumilla", "chattogram"]) {
    const res = recorder();
    await getCropCalendarAlignment({ query: { district, crop: "monsoon_aman" } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.districtCode, district);
    assert.equal(res.body.data.satelliteContext.vegetationIndex.available, true);
    assert.equal(res.body.data.satelliteContext.vegetationIndex.quality, "good_data");
    assert.equal(res.body.data.satelliteContext.vegetationIndex.ndvi, 0.4);
    assert.equal(res.body.data.satelliteContext.vegetationIndex.date, goodByDistrict[district].dateLabel);
    assert.equal(res.body.data.satelliteContext.soilMoisture.value, 0.31);
  }
  assert.equal(smapFilters.length, 2);
  for (const filter of smapFilters) {
    assert.ok(["cumilla", "chattogram"].includes(filter.districtCode));
    assert.deepEqual(filter.retrievalQualityFlag, { $in: [0, 8] });
    assert.equal(filter.isRecommendedQuality, true);
    assert.equal(filter.qualityClassification, "recommended");
  }
  assert.deepEqual(modisFilters.map((filter) => filter.districtCode), ["cumilla", "chattogram"]);
});

test("crop-calendar alignment withholds rank-1 NDVI/EVI and exposes only its marginal date and quality", async (t) => {
  t.mock.method(SmapObservation, "findOne", () => queryResult(null));
  t.mock.method(ModisObservation, "find", (filter) => {
    if (filter.pixelReliability === 0) return queryRows([]);
    assert.equal(filter.districtCode, "cumilla");
    assert.equal(filter.pixelReliability, 1);
    return queryRows([row("cumilla", "2024-02-18", {
      pixelReliability: 1,
      isReliableQuality: false,
      qualityClassification: "marginal_data",
    })]);
  });
  const res = recorder();
  await getCropCalendarAlignment({ query: { district: "cumilla", crop: "monsoon_aman" } }, res, (error) => { throw error; });
  const vegetation = res.body.data.satelliteContext.vegetationIndex;
  assert.equal(vegetation.available, false);
  assert.equal(vegetation.ndvi, null);
  assert.equal(vegetation.evi, null);
  assert.equal(vegetation.date, "2024-02-18");
  assert.equal(vegetation.quality, "marginal_data");
  assert.equal(vegetation.pixelReliability, 1);
});

test("crop-calendar alignment does not treat missing MODIS quality metadata as good or marginal", async (t) => {
  t.mock.method(SmapObservation, "findOne", () => queryResult(null));
  t.mock.method(ModisObservation, "find", (filter) => {
    if (filter.pixelReliability === 0) return queryRows([]);
    assert.equal(filter.pixelReliability, 1);
    return queryRows([row("cumilla", "2024-02-30", {
      pixelReliability: 1,
      isReliableQuality: false,
      qualityClassification: "marginal_data",
    })]);
  });
  const res = recorder();
  await getCropCalendarAlignment({ query: { district: "cumilla", crop: "monsoon_aman" } }, res, (error) => { throw error; });
  assert.equal(res.body.data.satelliteContext.vegetationIndex, null);
});

test("MODIS quality helper rejects impossible dates and missing quality metadata", async () => {
  const { isGoodModisObservation } = await import("../src/services/nasa/modis.quality.js");
  assert.equal(isGoodModisObservation(row("cumilla", "2024-02-30"), "cumilla"), false);
  assert.equal(isGoodModisObservation(row("cumilla", "2024-02-18", { pixelReliability: undefined }), "cumilla"), false);
  assert.equal(isGoodModisObservation(row("cumilla", "2024-02-18", { qualityClassification: undefined }), "cumilla"), false);
});
