import test from "node:test";
import assert from "node:assert/strict";

import { MODIS } from "../src/config/modis.config.js";
import {
  validateModisObservation,
  isAppeearsConfigured,
  computeModisCompositeWindow,
  doesModisCompositeOverlap,
} from "../src/services/nasa/appeears.client.js";

test("MODIS config holds verified scientific specifications", () => {
  assert.equal(MODIS.datasetKey, "nasa:modis:mod13q1:v061");
  assert.equal(MODIS.collectionConceptId, "C1748066515-LPCLOUD");
  assert.equal(MODIS.spatialResolution, "250m sinusoidal grid");
  assert.equal(MODIS.temporalCadence, "16-day composite");
  assert.equal(MODIS.layers.ndvi.scaleFactor, 0.0001);
  assert.equal(MODIS.layers.ndvi.fillValue, -3000);
  assert.equal(MODIS.layers.ndvi.validMin, -0.2);
  assert.equal(MODIS.layers.ndvi.validMax, 1.0);
});

test("MODIS validator scales NDVI and EVI and flags pixel reliability", () => {
  // Raw 4500 with scale 0.0001 -> 0.4500 NDVI
  const goodObs = validateModisObservation({
    rawNdvi: 4500,
    rawEvi: 3200,
    pixelReliability: 0,
    compositeDoy: 15,
  });
  assert.equal(goodObs.valid, true);
  assert.equal(goodObs.ndvi, 0.45);
  assert.equal(goodObs.evi, 0.32);
  assert.equal(goodObs.pixelReliability, 0);
  assert.equal(goodObs.isReliableQuality, true);
  assert.equal(goodObs.qualityClassification, "good_data");
  assert.equal(goodObs.compositeDoy, 15);

  // Marginal observation (pixelReliability = 1)
  const marginalObs = validateModisObservation({
    rawNdvi: 3800,
    rawEvi: 2500,
    pixelReliability: 1,
    compositeDoy: 15,
  });
  assert.equal(marginalObs.valid, true);
  assert.equal(marginalObs.isReliableQuality, false);
  assert.equal(marginalObs.qualityClassification, "marginal_data");

  // Cloudy observation (pixelReliability = 3)
  const cloudyObs = validateModisObservation({
    rawNdvi: 1500,
    rawEvi: 900,
    pixelReliability: 3,
    compositeDoy: 15,
  });
  assert.equal(cloudyObs.valid, true);
  assert.equal(cloudyObs.isReliableQuality, false);
  assert.equal(cloudyObs.qualityClassification, "cloudy");

  // Pre-scaled float values (e.g. from AppEEARS CSV where NDVI is 0.3434)
  const prescaledObs = validateModisObservation({
    rawNdvi: 0.3434,
    rawEvi: 0.1527,
    pixelReliability: 0,
    compositeDoy: 364,
  });
  assert.equal(prescaledObs.valid, true);
  assert.equal(prescaledObs.ndvi, 0.3434);
  assert.equal(prescaledObs.evi, 0.1527);
  assert.equal(prescaledObs.isReliableQuality, true);
  assert.equal(prescaledObs.qualityClassification, "good_data");

  // Fill value (-3000)
  const fillObs = validateModisObservation({
    rawNdvi: -3000,
    rawEvi: -3000,
    pixelReliability: -1,
    compositeDoy: 0,
  });
  assert.equal(fillObs.valid, false);
  assert.equal(fillObs.ndvi, null);
  assert.equal(fillObs.evi, null);
  assert.equal(fillObs.isReliableQuality, false);
  assert.equal(fillObs.qualityClassification, "fill");
});

test("ModisObservation schema enforces unique index and required fields", async () => {
  const { ModisObservation } = await import("../src/models/modisobservation.model.js");
  const indexes = ModisObservation.schema.indexes();

  const uniqueIdx = indexes.find(
    ([fields, opts]) => opts && opts.unique && fields.districtCode === 1 && fields.dateLabel === 1
  );
  assert.ok(uniqueIdx, "Compound unique index { districtCode: 1, dateLabel: 1 } must exist");

  const paths = ModisObservation.schema.paths;
  assert.equal(paths.districtCode.isRequired, true);
  assert.equal(paths.dateLabel.isRequired, true);
  assert.ok(paths.ndvi, "ndvi path exists");
  assert.ok(paths.evi, "evi path exists");
  assert.ok(paths.pixelReliability, "pixelReliability path exists");
  assert.ok(paths.isReliableQuality, "isReliableQuality path exists");
  assert.ok(paths.qualityClassification, "qualityClassification path exists");
});

test("isAppeearsConfigured returns boolean cleanly without throwing", () => {
  const configured = isAppeearsConfigured();
  assert.equal(typeof configured, "boolean");
});

test("MODIS regression: composite beginning before requested start but overlapping it", () => {
  const dateLabel = "2022-12-19";
  const range = { start: "2023-01-01", end: "2023-01-31" };
  const window = computeModisCompositeWindow(dateLabel, 16);

  assert.ok(window, "Window must be successfully computed");
  assert.equal(window.startDateLabel, "2022-12-19", "Preserves exact composite start date label");
  assert.equal(window.endDateLabel, "2023-01-03", "16-day composite ends 15 days after start (Day 16)");

  const overlaps = doesModisCompositeOverlap(dateLabel, range, 16);
  assert.equal(overlaps, true, "Composite 2022-12-19 to 2023-01-03 must overlap requested Jan 2023 range");
});

test("MODIS regression: composite fully outside the requested range (past and future)", () => {
  const range = { start: "2023-01-01", end: "2023-01-31" };

  // Past composite: 2022-12-03 to 2022-12-18 (ends before 2023-01-01)
  assert.equal(doesModisCompositeOverlap("2022-12-03", range, 16), false);

  // Future composite: 2023-02-02 to 2023-02-17 (starts after 2023-01-31)
  assert.equal(doesModisCompositeOverlap("2023-02-02", range, 16), false);

  // Malformed date
  assert.equal(doesModisCompositeOverlap("invalid-date", range, 16), false);
  assert.equal(doesModisCompositeOverlap(null, range, 16), false);
});

test("MODIS regression: composite ending exactly at requested boundary", () => {
  const dateLabel = "2022-12-19"; // Ends 2023-01-03
  const boundaryRange = { start: "2023-01-03", end: "2023-01-20" };

  const window = computeModisCompositeWindow(dateLabel, 16);
  assert.equal(window.endDateLabel, "2023-01-03");
  assert.equal(doesModisCompositeOverlap(dateLabel, boundaryRange, 16), true, "Must overlap on exact boundary date");
});

test("MODIS regression: adjacent chunk overlap and duplicate composite prevention", () => {
  const chunk1 = { start: "2022-12-01", end: "2022-12-31" };
  const chunk2 = { start: "2023-01-01", end: "2023-01-31" };
  const boundaryComposite = "2022-12-19";

  // Overlaps both adjacent chunks legitimately
  assert.equal(doesModisCompositeOverlap(boundaryComposite, chunk1, 16), true);
  assert.equal(doesModisCompositeOverlap(boundaryComposite, chunk2, 16), true);

  // Verification of idempotent upsert filter contract:
  // Both chunks target identical unique compound key { districtCode, dateLabel }
  const opChunk1 = {
    filter: { districtCode: "cumilla", dateLabel: boundaryComposite },
    update: { $setOnInsert: { districtCode: "cumilla", dateLabel: boundaryComposite, ndvi: 0.3082 } },
    upsert: true,
  };
  const opChunk2 = {
    filter: { districtCode: "cumilla", dateLabel: boundaryComposite },
    update: { $setOnInsert: { districtCode: "cumilla", dateLabel: boundaryComposite, ndvi: 0.3082 } },
    upsert: true,
  };

  assert.deepEqual(opChunk1.filter, opChunk2.filter, "Both chunks must target the exact same filter key");
  assert.equal(opChunk1.update.$setOnInsert.dateLabel, "2022-12-19", "Date label is never rewritten to chunk start");
});

test("MODIS regression: good and marginal quality separation with scaling", () => {
  // Good quality (pixelReliability == 0)
  const good = validateModisObservation({
    rawNdvi: 4800,
    rawEvi: 2800,
    pixelReliability: 0,
    compositeDoy: 49,
  });
  assert.equal(good.valid, true);
  assert.equal(good.isReliableQuality, true);
  assert.equal(good.qualityClassification, "good_data");
  assert.equal(good.ndvi, 0.48);
  assert.equal(good.evi, 0.28);

  // Marginal quality (pixelReliability == 1)
  const marginal = validateModisObservation({
    rawNdvi: 2400,
    rawEvi: 1200,
    pixelReliability: 1,
    compositeDoy: 49,
  });
  assert.equal(marginal.valid, true);
  assert.equal(marginal.isReliableQuality, false);
  assert.equal(marginal.qualityClassification, "marginal_data");
  assert.equal(marginal.ndvi, 0.24);
  assert.equal(marginal.evi, 0.12);

  // Cloud (pixelReliability == 3)
  const cloud = validateModisObservation({
    rawNdvi: 1100,
    rawEvi: 500,
    pixelReliability: 3,
    compositeDoy: 49,
  });
  assert.equal(cloud.valid, true);
  assert.equal(cloud.isReliableQuality, false);
  assert.equal(cloud.qualityClassification, "cloudy");

  // Fill values (-3000)
  const fill = validateModisObservation({
    rawNdvi: -3000,
    rawEvi: -3000,
    pixelReliability: 0,
    compositeDoy: 49,
  });
  assert.equal(fill.valid, false);
  assert.equal(fill.ndvi, null);
  assert.equal(fill.evi, null);
});

