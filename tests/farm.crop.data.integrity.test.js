import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildFarmEnvironmentalContext } from "../src/controllers/farm.controller.js";
import { evaluateCropEligibility, getPlanningSatelliteContext } from "../src/services/cropplanning.service.js";
import { snapshotService } from "../src/services/snapshot.service.js";
import { generateDeterministicSummary } from "../src/services/farmenvironment.service.js";

const goodSmap = (districtCode = "cumilla") => ({ districtCode, datasetKey: "nasa:smap:spl3smp_e:v006", dateLabel: "2024-01-03", retrievalQualityFlag: 8, isRecommendedQuality: true, qualityClassification: "recommended", soilMoisture: 0.31, unit: "m³/m³" });
const goodModis = (districtCode = "cumilla") => ({ districtCode, datasetKey: "nasa:modis:mod13q1:v061", dateLabel: "2024-02-18", pixelReliability: 0, isReliableQuality: true, qualityClassification: "good_data", ndvi: 0.4, evi: 0.2 });

describe("Farmer crop and farm NASA context integrity", () => {
  test("My Farm helper withholds invalid SMAP and marginal MODIS without substituting values", () => {
    const context = buildFarmEnvironmentalContext("cumilla",
      { ...goodSmap(), retrievalQualityFlag: 9 }, { ...goodModis(), pixelReliability: 1, isReliableQuality: false, qualityClassification: "marginal_data" });
    assert.equal(context.districtCode, "cumilla");
    assert.equal(context.soilMoisture, null);
    assert.equal(context.vegetationHealth, null);
    const valid = buildFarmEnvironmentalContext("cumilla", goodSmap(), goodModis());
    assert.equal(valid.soilMoisture.value, 0.31);
    assert.equal(valid.vegetationHealth.ndvi, 0.4);
  });

  test("Crop Planning does not default unknown district to Cumilla and filters snapshot records", async () => {
    const originalConnected = snapshotService.isDbConnected;
    const originalSmap = snapshotService.getSmapSnapshot;
    const originalModis = snapshotService.getModisSnapshot;
    try {
      snapshotService.isDbConnected = () => false;
      snapshotService.getSmapSnapshot = (district) => ({ observations: [goodSmap(district), { ...goodSmap(district), retrievalQualityFlag: 9, dateLabel: "2024-01-05" }] });
      snapshotService.getModisSnapshot = (district) => ({ observations: [goodModis(district), { ...goodModis(district), pixelReliability: 1, isReliableQuality: false, qualityClassification: "marginal_data", dateLabel: "2024-02-20" }] });

      const unsupported = await getPlanningSatelliteContext("dhaka");
      assert.equal(unsupported.status, "UNAVAILABLE");
      assert.equal(unsupported.districtCode, "dhaka");
      assert.equal(await getPlanningSatelliteContext(undefined).then((value) => value.districtCode), null);

      const context = await getPlanningSatelliteContext("cumilla");
      assert.equal(context.smap.dateLabel, "2024-01-03");
      assert.equal(context.modis.dateLabel, "2024-02-18");
      assert.equal(context.smap.qualityClassification, "recommended");
      assert.equal(context.modis.qualityClassification, "good_data");
    } finally {
      snapshotService.isDbConnected = originalConnected;
      snapshotService.getSmapSnapshot = originalSmap;
      snapshotService.getModisSnapshot = originalModis;
    }
  });

  test("missing irrigation is disclosed and does not make Boro fully supported", () => {
    const result = evaluateCropEligibility({ districtCode: "cumilla", irrigationAvailability: "unknown" });
    const boro = result.crops.find((crop) => crop.cropCode === "boro_rice");
    assert.equal(boro.suitabilityCategory, "potential");
    assert.ok(boro.constraints.some((constraint) => /irrigation availability is unknown/i.test(constraint)));
    assert.ok(result.missingInfo.some((item) => /irrigation availability not confirmed/i.test(item)));
  });

  test("missing POWER rainfall stays unavailable and a real zero is not replaced", () => {
    const base = { districtCode: "cumilla", climateContext: { annualSummary: { annualRainfallMeanMm: null }, latestObservations: {} }, smapContext: {}, modisContext: {}, currentStageInfo: null };
    const missing = generateDeterministicSummary(base).en;
    assert.match(missing, /rainfall summary is unavailable/);
    assert.doesNotMatch(missing, /2100|2,100/);
    const zero = generateDeterministicSummary({ ...base, climateContext: { ...base.climateContext, annualSummary: { annualRainfallMeanMm: 0 } } }).en;
    assert.match(zero, /annual rainfall mean of 0 mm/);
  });
});
