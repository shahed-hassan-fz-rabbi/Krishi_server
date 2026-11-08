/**
 * MongoDB-backed API integration tests.
 * Each run is forced into a unique krishi_mama_test_<pid>_<nonce> database and
 * uses deterministic fixture observations; production collections are untouched.
 * Run explicitly with `npm run test:integration` (MONGODB_URI from server/.env).
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";

import "../src/config/env.config.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { createApp } from "../src/app.js";
import { District } from "../src/models/district.model.js";
import { NasaDataset } from "../src/models/nasadataset.model.js";
import { NasaObservation } from "../src/models/nasaobservation.model.js";
import { DISTRICTS, PARAMETER_CATALOG, POWER } from "../src/config/climate.config.js";

const fixtureRunId = `api-test-${randomUUID()}`;
const testDatabaseName = `km_api_${process.pid}_${randomUUID().slice(0, 8)}`;
let server;
let baseUrl;
let databaseConnected = false;
let fixtureObservationCount = 0;

function dateLabels(startIso, endIso) {
  const dates = [];
  const current = new Date(`${startIso}T00:00:00.000Z`);
  const end = new Date(`${endIso}T00:00:00.000Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function observation(districtCode, parameter, dateLabel, value) {
  return {
    districtCode,
    parameter,
    datasetKey: POWER.datasetKey,
    dateLabel,
    date: new Date(`${dateLabel}T00:00:00.000Z`),
    timeStandard: POWER.timeStandard,
    value,
    unit: PARAMETER_CATALOG[parameter].unit,
    quality: "ok",
    ingestionRunId: fixtureRunId,
    provenanceDatasetId: POWER.datasetKey,
  };
}

function rainfallRows(districtCode, startIso, endIso, valueForDate) {
  return dateLabels(startIso, endIso).map((dateLabel) =>
    observation(districtCode, "PRECTOTCORR", dateLabel, valueForDate(dateLabel))
  );
}

function parameterRows(districtCode, startIso, endIso, values) {
  return dateLabels(startIso, endIso).flatMap((dateLabel) =>
    Object.entries(values).map(([parameter, value]) =>
      observation(districtCode, parameter, dateLabel, value)
    )
  );
}

async function seedFixtures() {
  await District.insertMany(DISTRICTS.map(({ code, nameEn, nameBn, latitude, longitude, isDefault, enabled }) => ({
    code, nameEn, nameBn, latitude, longitude, isDefault, enabled,
  })));

  const firstObservedDate = new Date("2020-01-01T00:00:00.000Z");
  const lastObservedDate = new Date("2024-12-31T00:00:00.000Z");
  await NasaDataset.create({
    _id: POWER.datasetKey,
    datasetKey: POWER.datasetKey,
    product: POWER.productName,
    provider: "NASA POWER (test fixture)",
    endpoint: POWER.endpoint,
    community: POWER.community,
    parameters: Object.fromEntries(
      Object.entries(PARAMETER_CATALOG).map(([code, details]) => [code, {
        unit: details.unit,
        longName: details.longName,
      }])
    ),
    fillValue: POWER.fillValue,
    timeStandard: POWER.timeStandard,
    timeStandardDisclosure: POWER.timeStandardDisclosure,
    coverage: { firstObservedDate, lastObservedDate, lastVerifiedAt: new Date() },
    sourceUrls: [POWER.endpoint],
  });

  const rows = [];
  rows.push(...rainfallRows("chattogram", "2020-01-01", "2021-12-31", (dateLabel) => {
    const month = Number(dateLabel.slice(5, 7));
    return month >= 6 && month <= 9 ? 8 : 1.2;
  }));
  rows.push(...parameterRows("chattogram", "2024-01-01", "2024-12-31", {
    T2M: 25,
    T2M_MAX: 30,
    T2M_MIN: 20,
    RH2M: 70,
    ALLSKY_SFC_SW_DWN: 18,
  }));
  rows.push(...rainfallRows("chattogram", "2024-01-01", "2024-12-31", () => 4));
  rows.push(...parameterRows("cumilla", "2022-01-01", "2022-12-31", {
    T2M: 21,
    T2M_MAX: 26,
    T2M_MIN: 16,
  }));
  rows.push(...rainfallRows("cumilla", "2021-01-01", "2021-01-31", () => 3.5));
  rows.push(...rainfallRows("cumilla", "2023-01-01", "2023-01-31", () => 3.5));
  rows.push(...rainfallRows("cumilla", "2021-10-01", "2021-11-30", (dateLabel) => {
    const month = Number(dateLabel.slice(5, 7));
    const day = Number(dateLabel.slice(8, 10));
    if (month === 11 && day <= 20) return 0.2;
    if (month === 10 && day >= 16) return 3.5;
    return 1.2;
  }));
  rows.push(...rainfallRows("cumilla", "2022-10-01", "2022-11-30", (dateLabel) => {
    const month = Number(dateLabel.slice(5, 7));
    const day = Number(dateLabel.slice(8, 10));
    if (month === 11 && day <= 20) return 0.0;
    if (month === 10 && day >= 16) return 4.0;
    return 0.8;
  }));

  const inserted = await NasaObservation.insertMany(rows, { ordered: true });
  fixtureObservationCount = inserted.length;
}

before(async () => {
  // `databaseName` overrides the URI's default database, isolating all writes.
  // `required` makes an unavailable database fail setup instead of running 18
  // misleading route failures against a disconnected Mongoose connection.
  await connectDatabase({ databaseName: testDatabaseName, required: true });
  databaseConnected = true;
  assert.equal(mongoose.connection.name, testDatabaseName);
  await seedFixtures();

  server = http.createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
      resolve();
    });
  });
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (!databaseConnected) return;
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.dropDatabase();
    }
  } finally {
    await disconnectDatabase();
  }
});

test("health reports the connected fixture database and recent dataset verification", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.status, "ok");
  assert.equal(body.data.service, "krishi-mama-api");
  assert.equal(body.data.database.connected, true);
  assert.equal(body.data.dataset.configured, true);
  assert.equal(body.data.dataset.isPopulated, true);
  assert.equal(body.data.dataset.isFresh, true);
  assert.equal(body.data.dataset.observationCount, fixtureObservationCount);
});

test("district endpoint returns both exact configured districts", async () => {
  const res = await fetch(`${baseUrl}/districts`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.length, 2);

  const ctg = body.data.find((district) => district.code === "chattogram");
  assert.ok(ctg);
  assert.equal(ctg.latitude, 22.3384);
  assert.equal(ctg.longitude, 91.8317);
  assert.equal(ctg.isDefault, true);

  const cum = body.data.find((district) => district.code === "cumilla");
  assert.ok(cum);
  assert.equal(cum.latitude, 23.46186);
  assert.equal(cum.longitude, 91.18503);
  assert.equal(cum.isDefault, false);
});

test("an empty fixture range returns an explicit data-unavailable error", async () => {
  const res = await fetch(`${baseUrl}/climate/rainfall?district=cumilla&from=2020-01-01&to=2020-01-31`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, "DATA_UNAVAILABLE");
});

test("rainfall response uses complete monthly fixture observations and reports evidence metadata", async () => {
  const res = await fetch(`${baseUrl}/climate/rainfall?district=chattogram&from=2021-01-01&to=2021-12-31&grouping=monthly`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.meta.district, "chattogram");
  assert.equal(body.meta.parameter, "PRECTOTCORR");
  assert.equal(body.meta.unit, "mm/day");
  assert.equal(body.meta.time_standard, "LST");
  assert.equal(body.meta.formula_version, "v1.0.0-phase3");
  assert.equal(body.meta.dataset_provenance, POWER.datasetKey);

  const july = body.data.series.find((month) => month.year === 2021 && month.month === 7);
  assert.ok(july);
  assert.equal(july.total_mm, 248);
  assert.equal(july.expected_days, 31);
  assert.equal(july.is_complete, true);
});

test("temperature response returns Celsius values and backend diurnal range", async () => {
  const res = await fetch(`${baseUrl}/climate/temperature?district=cumilla&from=2022-01-01&to=2022-12-31&metric=t2m`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.meta.unit, "C");
  assert.equal(body.meta.district, "cumilla");
  assert.ok(body.data.monthly_series.length > 0);

  const january = body.data.monthly_series.find((month) => month.year === 2022 && month.month === 1);
  assert.ok(january);
  assert.equal(january.mean_t2m, 21);
  assert.equal(january.mean_max, 26);
  assert.equal(january.mean_min, 16);
  assert.equal(january.diurnal_range, 10);
});

test("summary coverage, units, provenance, formula, and LST metadata reflect complete fixtures", async () => {
  const res = await fetch(`${baseUrl}/climate/summary?district=chattogram&from=2024-01-01&to=2024-12-31`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.meta.district, "chattogram");
  assert.equal(body.meta.coverage_percent, 100);
  assert.equal(body.meta.valid_observations, 6 * 366);
  assert.equal(body.meta.total_observations, 6 * 366);
  assert.equal(body.meta.formula_version, "v1.0.0-phase3");
  assert.equal(body.meta.dataset_provenance, POWER.datasetKey);
  assert.equal(body.meta.time_standard, "LST");
  assert.ok(body.meta.limitations.includes("Local Solar Time (LST)"));
  assert.ok(body.data.rainfall);
  assert.ok(body.data.temperature);
  assert.equal(body.data.rainfall.unit, "mm/day");
  assert.equal(body.data.temperature.unit, "C");
});

test("data-source endpoint reports fixture count and complete source provenance", async () => {
  const res = await fetch(`${baseUrl}/data-sources`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.length, 1);

  const power = body.data.find((dataset) => dataset.datasetKey === POWER.datasetKey);
  assert.ok(power);
  assert.equal(power.timeStandard, "LST");
  assert.equal(power.fillValue, -999);
  assert.equal(power.observationCount, fixtureObservationCount);
  assert.ok(power.parameters.PRECTOTCORR);
  assert.ok(power.parameters.T2M);
});

test("scientific responses do not include unsupported risk-label fields", async () => {
  const res = await fetch(`${baseUrl}/climate/summary?district=chattogram&from=2024-01-01&to=2024-12-31`);
  assert.equal(res.status, 200);
  const bodyText = await res.text();
  assert.equal(bodyText.includes('"low_risk"'), false);
  assert.equal(bodyText.includes('"moderate_risk"'), false);
  assert.equal(bodyText.includes('"high_risk"'), false);
  assert.equal(bodyText.includes('"risk_level"'), false);
});

test("daily endpoint returns the exact stored fixture values without substitution", async () => {
  const res = await fetch(`${baseUrl}/climate/rainfall?district=chattogram&from=2021-07-01&to=2021-07-07&grouping=daily`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const series = body.data.series;
  assert.equal(series.length, 7);
  assert.deepEqual(series.map((row) => row.value), Array(7).fill(8));
  assert.ok(series.every((row) => row.quality === "ok"));
  assert.equal(body.meta.dataset_provenance, POWER.datasetKey);
});

test("winter groups December of the prior year with January and February of the ending year", async () => {
  const res = await fetch(`${baseUrl}/climate/rainfall?district=chattogram&from=2020-01-01&to=2021-12-31&grouping=seasonal`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);

  const winter2021 = body.data.historical_seasons.winter;
  assert.ok(winter2021);
  assert.deepEqual(winter2021.months, [12, 1, 2]);
  assert.equal(winter2021.stats.mean, 108);
  assert.equal(winter2021.years_used, 1);
});

test("cache uses formula and dataset keys and clears explicitly", async () => {
  const {
    getCacheKey,
    clearAnalysisCache,
    getAnalysisCacheSize,
    FORMULA_VERSION,
    DATASET_KEY,
  } = await import("../src/controllers/climate.controller.js");
  const key = getCacheKey(["rainfall", "chattogram", "2021-01-01", "2021-12-31"]);
  assert.ok(key.startsWith(`${FORMULA_VERSION}::${DATASET_KEY}`));

  clearAnalysisCache();
  assert.equal(getAnalysisCacheSize(), 0);
  const res = await fetch(`${baseUrl}/climate/rainfall?district=cumilla&from=2021-01-01&to=2021-01-31`);
  assert.equal(res.status, 200);
  assert.ok(getAnalysisCacheSize() >= 1);
  clearAnalysisCache();
  assert.equal(getAnalysisCacheSize(), 0);
});

test("single-year rainfall normals disclose insufficient sample evidence", async () => {
  const res = await fetch(`${baseUrl}/climate/rainfall?district=chattogram&from=2021-01-01&to=2021-12-31&grouping=monthly`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const january = body.data.historical_normals["1"];
  assert.ok(january);
  assert.equal(january.years_used, 1);
  assert.equal(january.stats.evidence_status, "insufficient_sample");
  assert.ok(january.stats.evidence_limitation.includes("below climatological threshold"));
});

test("handoff endpoint computes seasonal transition, sowing opportunity, and period shift for Cumilla", async () => {
  const res = await fetch(`${baseUrl}/climate/handoff?district=cumilla&transition=aman-mustard`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.transition_id, "aman-mustard");
  assert.ok(body.data.sowing_opportunity);
  assert.ok(body.data.period_comparison);
  assert.ok(body.data.period_comparison.metrics.sowing_dry_days);
  assert.ok(body.data.period_comparison.metrics.sowing_dry_days.statistical_tests.mann_whitney_u);
  assert.ok(body.data.scientific_disclosures);
  assert.ok(body.data.scientific_disclosures.wet_day_definition.includes("1.0 mm"));
});
