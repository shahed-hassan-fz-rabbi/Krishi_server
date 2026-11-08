import test from "node:test";
import assert from "node:assert/strict";

import { MODIS } from "../src/config/modis.config.js";
import { validateModisObservation, isAppeearsConfigured } from "../src/services/nasa/appeears.client.js";

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
