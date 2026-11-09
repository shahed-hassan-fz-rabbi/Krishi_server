import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { toolExecutors } from "../src/services/ai/tools.executor.js";
import { assistantTools } from "../src/services/ai/tools.definition.js";
import { geminiAssistantClient } from "../src/services/ai/gemini.client.js";
import { assistantChatService } from "../src/services/ai/chat.service.js";

dotenv.config();

test("Assistant Tools Definitions match expected Google Gemini schema", () => {
  assert.equal(assistantTools.length, 14);
  const toolNames = assistantTools.map((t) => t.name);
  assert.ok(toolNames.includes("getClimateNormals"));
  assert.ok(toolNames.includes("getPrecipitationLatest"));
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

test("deterministic GPM fallback is bilingual, provenance-aware, and withholds incomplete totals", async () => {
  const originalConfigured = geminiAssistantClient.isConfigured;
  const originalPrecipitationTool = toolExecutors.getPrecipitationLatest;
  let complete = true;
  geminiAssistantClient.isConfigured = () => false;
  toolExecutors.getPrecipitationLatest = async ({ district }) => ({
    status: "AVAILABLE",
    district,
    observationDate: "2024-01-07",
    ingestedAt: "2026-11-09T01:37:39.775Z",
    dailySummary: {
      dateLabel: "2024-01-07",
      expectedIntervals: 48,
      observedIntervals: complete ? 48 : 47,
      validIntervals: complete ? 48 : 47,
      totalPrecipitationMm: complete ? 0 : null,
      completeness: complete ? "complete" : "incomplete",
    },
    source: "NASA GES DISC GPM IMERG Final V07",
    datasetKey: "nasa:gpm:imerg:3imerghh:v07",
    limitation: "Regional ~0.1 degree grid estimate, not a farm rain gauge.",
  });

  try {
    const english = await assistantChatService.handleChat({
      message: "For Cumilla, report the latest GPM IMERG daily rainfall.",
      district: "cumilla",
    });
    assert.equal(english.language, "en");
    assert.equal(english.dataDate, "2024-01-07");
    assert.equal(english.dataQuality, "complete_48_of_48");
    assert.ok(english.meta.toolsCalled.includes("getPrecipitationLatest"));
    assert.match(english.answer, /0\.00 mm/);
    assert.match(english.answer, /48\/48/);
    assert.match(english.answer, /Database ingestion time:/);
    assert.match(english.answer, /not a farm rain gauge or live weather/);

    const bangla = await assistantChatService.handleChat({
      message: "কুমিল্লায় সর্বশেষ GPM বৃষ্টিপাত কত?",
      district: "cumilla",
    });
    assert.equal(bangla.language, "bn");
    assert.match(bangla.answer, /2024-01-07/);
    assert.match(bangla.answer, /48\/48/);

    complete = false;
    const partial = await assistantChatService.handleChat({
      message: "কুমিল্লায় সর্বশেষ GPM বৃষ্টিপাত কত?",
      district: "cumilla",
    });
    assert.equal(partial.dataQuality, "incomplete_or_unavailable");
    assert.match(partial.answer, /47\/48/);
    assert.doesNotMatch(partial.answer, /0\.00 mm/);
  } finally {
    geminiAssistantClient.isConfigured = originalConfigured;
    toolExecutors.getPrecipitationLatest = originalPrecipitationTool;
  }
});

test("Gemini success path propagates GPM observation provenance and completeness metadata", async () => {
  const originalConfigured = geminiAssistantClient.isConfigured;
  const originalGenerate = geminiAssistantClient.generateGroundedResponse;
  geminiAssistantClient.isConfigured = () => true;
  geminiAssistantClient.generateGroundedResponse = async () => ({
    answer: "The stored GPM day is complete.",
    modelUsed: "mock-gemini-contract-test",
    executedTools: [{
      toolName: "getPrecipitationLatest",
      result: {
        status: "AVAILABLE",
        observationDate: "2024-01-07",
        source: "NASA GES DISC GPM IMERG Final V07",
        datasetKey: "nasa:gpm:imerg:3imerghh:v07",
        limitation: "Regional grid; not a farm rain gauge.",
        dailySummary: { validIntervals: 48, completeness: "complete", totalPrecipitationMm: 0 },
      },
    }],
  });

  try {
    const result = await assistantChatService.handleChat({
      message: "For Cumilla, what is the latest GPM rainfall?",
      district: "cumilla",
    });
    assert.equal(result.language, "en");
    assert.equal(result.meta.model, "mock-gemini-contract-test");
    assert.deepEqual(result.meta.toolsCalled, ["getPrecipitationLatest"]);
    assert.equal(result.dataDate, "2024-01-07");
    assert.equal(result.dataQuality, "complete_48_of_48");
    assert.ok(result.sources.some((source) => source.includes("GPM IMERG")));
    assert.ok(result.provenance.includes("nasa:gpm:imerg:3imerghh:v07"));
    assert.ok(result.limitations.includes("Regional grid; not a farm rain gauge."));
  } finally {
    geminiAssistantClient.isConfigured = originalConfigured;
    geminiAssistantClient.generateGroundedResponse = originalGenerate;
  }
});
