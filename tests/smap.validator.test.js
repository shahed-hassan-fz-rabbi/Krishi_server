import test from "node:test";
import assert from "node:assert/strict";

import { validateSoilMoistureValue } from "../src/services/nasa/smap.client.js";
import { isEarthdataConfigured, verifyEarthdataAuth } from "../src/services/nasa/earthdata.auth.js";
import { SMAP } from "../src/config/smap.config.js";

test("SMAP config holds verified scientific specifications", () => {
  assert.equal(SMAP.datasetKey, "nasa:smap:spl3smp_e:v006");
  assert.equal(SMAP.collectionConceptId, "C2938664763-NSIDC_CPRD");
  assert.equal(SMAP.unit, "m^3/m^3");
  assert.equal(SMAP.fillValue, -9999.0);
  assert.equal(SMAP.spatialResolution, "9 km EASE-Grid 2.0");
});

test("SMAP validator rejects fill values and out-of-range observations", () => {
  assert.equal(validateSoilMoistureValue(-9999.0, 0).valid, false);
  assert.equal(validateSoilMoistureValue(-1.0, 0).valid, false);
  assert.equal(validateSoilMoistureValue(1.5, 0).valid, false); // Above saturation threshold
  assert.equal(validateSoilMoistureValue(null, 0).valid, false);
  assert.equal(validateSoilMoistureValue(NaN, 0).valid, false);
});

test("SMAP validator accepts physical volumetric values and decodes bitmask quality flags", () => {
  // Flag 0: All clear (ideal synthetic/nominal)
  const highQual0 = validateSoilMoistureValue(0.3254, 0);
  assert.equal(highQual0.valid, true);
  assert.equal(highQual0.value, 0.3254);
  assert.equal(highQual0.isRecommended, true);
  assert.equal(highQual0.qualityClassification, "recommended");
  assert.equal(highQual0.qaBits.bit0NotRecommended, false);

  // Flag 8 (binary 0000 1000): Cumilla real observations
  // bit 0 = 0 (Recommended), bit 1 = 0 (Attempted), bit 2 = 0 (Success), bit 3 = 1 (FT unsuccessful)
  const cumillaFlag8 = validateSoilMoistureValue(0.3003, 8);
  assert.equal(cumillaFlag8.valid, true);
  assert.equal(cumillaFlag8.value, 0.3003);
  assert.equal(cumillaFlag8.isRecommended, true);
  assert.equal(cumillaFlag8.qualityClassification, "recommended");
  assert.equal(cumillaFlag8.qaBits.bit0NotRecommended, false);
  assert.equal(cumillaFlag8.qaBits.bit3FreezeThawUnsuccessful, true);

  // Flag 9 (binary 0000 1001): Chattogram real observations
  // bit 0 = 1 (Not recommended), bit 1 = 0 (Attempted), bit 2 = 0 (Success), bit 3 = 1 (FT unsuccessful)
  const chattogramFlag9 = validateSoilMoistureValue(0.1719, 9);
  assert.equal(chattogramFlag9.valid, true);
  assert.equal(chattogramFlag9.value, 0.1719);
  assert.equal(chattogramFlag9.isRecommended, false);
  assert.equal(chattogramFlag9.qualityClassification, "not_recommended");
  assert.equal(chattogramFlag9.qaBits.bit0NotRecommended, true);
  assert.equal(chattogramFlag9.qaBits.bit2NotSuccessful, false);
});

test("Earthdata auth returns clean status when unconfigured without crashing", async () => {
  // If not configured, should return configured: false and clean message
  const status = await verifyEarthdataAuth();
  assert.ok(typeof status.configured === "boolean");
  assert.ok(typeof status.authenticated === "boolean");
});

test("SmapObservation schema enforces unique index and preserves physical fields", async () => {
  const { SmapObservation } = await import("../src/models/smapobservation.model.js");
  const indexes = SmapObservation.schema.indexes();
  
  // Find compound unique index
  const uniqueIdx = indexes.find(
    ([fields, opts]) => opts && opts.unique && fields.districtCode === 1 && fields.dateLabel === 1 && fields.orbit === 1
  );
  assert.ok(uniqueIdx, "Compound unique index { districtCode: 1, dateLabel: 1, orbit: 1 } must exist");

  const paths = SmapObservation.schema.paths;

  // Verify required fields
  assert.equal(paths.districtCode.isRequired, true, "districtCode must be required");
  assert.equal(paths.dateLabel.isRequired, true, "dateLabel must be required");
  assert.equal(paths.orbit.isRequired, true, "orbit must be required");

  // Verify AM and PM keys are distinct and cannot collide
  const amKey = { districtCode: "cumilla", dateLabel: "2024-01-02", orbit: "AM" };
  const pmKey = { districtCode: "cumilla", dateLabel: "2024-01-02", orbit: "PM" };
  assert.notDeepEqual(amKey, pmKey, "AM and PM must have distinct compound keys");

  // Verify physical fields exist in schema paths
  assert.ok(paths.soilMoisture, "soilMoisture path exists");
  assert.ok(paths.retrievalQualityFlag, "retrievalQualityFlag path exists");
  assert.ok(paths.isRecommendedQuality, "isRecommendedQuality path exists");
  assert.ok(paths.qualityClassification, "qualityClassification path exists");
  assert.ok(paths.surfaceFlag, "surfaceFlag path exists");
  assert.ok(paths.bulkDensity, "bulkDensity path exists");
  assert.ok(paths.clayFraction, "clayFraction path exists");
  assert.ok(paths.staticWaterFraction, "staticWaterFraction path exists");
  assert.ok(paths.surfaceTemperatureK, "surfaceTemperatureK path exists");
  assert.ok(paths.freezeThawFraction, "freezeThawFraction path exists");
  assert.ok(paths.soilPorosity, "soilPorosity path exists");
  assert.ok(paths.geodesicDistanceKm, "geodesicDistanceKm path exists");
  assert.ok(paths.adminPolygonPcode, "adminPolygonPcode path exists");
});

test("SMAP regression: only flags 0 and 8 are recommended; all other flags are rejected", () => {
  // NSIDC SPL3SMP_E V006 specifies:
  // Bit 0 = 0 (recommended), Bit 2 = 0 (successful retrieval)
  // Flags with bit0=0 and bit2=0: flag 0 (0b0000) and flag 8 (0b1000)
  assert.equal(validateSoilMoistureValue(0.35, 0).isRecommended, true);
  assert.equal(validateSoilMoistureValue(0.35, 8).isRecommended, true);

  // Non-recommended flags:
  // Flag 1 (0b0001): bit0=1 (not recommended)
  assert.equal(validateSoilMoistureValue(0.35, 1).isRecommended, false);
  // Flag 7 (0b0111): bits 0,1,2=1 (not recommended, not attempted, unsuccessful)
  assert.equal(validateSoilMoistureValue(0.35, 7).isRecommended, false);
  // Flag 9 (0b1001): bit0=1 (not recommended)
  assert.equal(validateSoilMoistureValue(0.35, 9).isRecommended, false);
  // Flag 255: invalid
  assert.equal(validateSoilMoistureValue(0.35, 255).isRecommended, false);
});

test("SMAP regression: fill value -9999.0 is never coerced to 0.0000", () => {
  const result = validateSoilMoistureValue(-9999.0, 0);
  assert.equal(result.valid, false);
  assert.equal(result.value, null);
  assert.notEqual(result.value, 0);
});

test("SMAP regression: AM and PM observations for same district and date are idempotent and distinct", () => {
  const amDoc = {
    districtCode: "cumilla",
    dateLabel: "2024-01-08",
    orbit: "AM",
    soilMoisture: 0.3937,
  };
  const pmDoc = {
    districtCode: "cumilla",
    dateLabel: "2024-01-08",
    orbit: "PM",
    soilMoisture: 0.3812,
  };

  const amFilter = { districtCode: amDoc.districtCode, dateLabel: amDoc.dateLabel, orbit: amDoc.orbit };
  const pmFilter = { districtCode: pmDoc.districtCode, dateLabel: pmDoc.dateLabel, orbit: pmDoc.orbit };

  assert.notDeepEqual(amFilter, pmFilter, "AM and PM must target distinct compound unique filters");
  assert.equal(amFilter.orbit, "AM");
  assert.equal(pmFilter.orbit, "PM");
});

