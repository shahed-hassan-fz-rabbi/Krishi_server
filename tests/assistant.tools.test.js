import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { toolExecutors } from "../src/services/ai/tools.executor.js";
import { assistantTools } from "../src/services/ai/tools.definition.js";

dotenv.config();

test("Assistant Tools Definitions match expected Google Gemini schema", () => {
  assert.equal(assistantTools.length, 13);
  const toolNames = assistantTools.map((t) => t.name);
  assert.ok(toolNames.includes("getClimateNormals"));
  assert.ok(toolNames.includes("getClimateRainfall"));
  assert.ok(toolNames.includes("getSoilMoistureLatest"));
  assert.ok(toolNames.includes("getVegetationLatest"));
  assert.ok(toolNames.includes("getCropCalendarAdvisory"));
  assert.ok(toolNames.includes("getHandoffPlan"));
  assert.ok(toolNames.includes("getSupportedDistrictsAndCrops"));
  assert.ok(toolNames.includes("getMyFarmDetails"));
  assert.ok(toolNames.includes("getMyFarmLifecycle"));
  assert.ok(toolNames.includes("getMyFarmActivities"));
  assert.ok(toolNames.includes("getMyFarmEnvironmentalContext"));
  assert.ok(toolNames.includes("getOfficialCropGuidance"));
  assert.ok(toolNames.includes("getFarmActivityHistory"));

  for (const tool of assistantTools) {
    assert.equal(typeof tool.name, "string");
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.parameters.type, "OBJECT");
  }
});

test("getSupportedDistrictsAndCrops returns verified configuration", async () => {
  const result = await toolExecutors.getSupportedDistrictsAndCrops();
  assert.ok(Array.isArray(result.districts));
  assert.equal(result.districts.length, 2);
  assert.ok(result.districts.some((d) => d.code === "cumilla"));
  assert.ok(result.districts.some((d) => d.code === "chattogram"));

  assert.ok(Array.isArray(result.crops));
  assert.equal(result.crops.length, 4);
  assert.ok(result.crops.some((c) => c.code === "mustard"));
  assert.ok(result.crops.some((c) => c.code === "monsoon_aman"));
});

test("getCropCalendarAdvisory retrieves official BAMIS/BARI mustard specifications", async () => {
  // Test with crop name alias
  const mustardData = await toolExecutors.getCropCalendarAdvisory({ crop: "সরিষা", district: "cumilla" });
  assert.equal(mustardData.cropId, "mustard");
  assert.equal(mustardData.nameBn, "সরিষা");
  assert.equal(mustardData.sowingPeriod, "Early November to Mid November (Kartik)");
  assert.ok(mustardData.typicalVarieties.includes("BARI Sarisha-14"));
  assert.ok(mustardData.officialSources.length > 0);
  assert.ok(mustardData.provenance.includes("BAMIS"));

  // Verify critical temperature limits and water requirements
  const floweringStage = mustardData.criticalStages.find((s) => s.stageId === "flowering_podding");
  assert.ok(floweringStage);
  assert.equal(floweringStage.waterRequirementMm, 100);
  assert.equal(floweringStage.temperatureTolerance.minTempC, 8);
});

test("getCropCalendarAdvisory rejects unsupported crop gracefully", async () => {
  const invalid = await toolExecutors.getCropCalendarAdvisory({ crop: "dragonfruit" });
  assert.ok(invalid.error);
  assert.ok(Array.isArray(invalid.supportedCrops));
});

test("toolExecutors reject unsupported district before computation", async () => {
  const smapRes = await toolExecutors.getSoilMoistureLatest({ district: "sylhet" });
  assert.ok(smapRes.error);
  assert.ok(smapRes.supportedDistricts.includes("cumilla"));

  const modisRes = await toolExecutors.getVegetationLatest({ district: "rajshahi" });
  assert.ok(modisRes.error);

  const climateRes = await toolExecutors.getClimateNormals({ district: "barishal" });
  assert.ok(climateRes.error);
});
