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
  let available = true;
  geminiAssistantClient.isConfigured = () => false;
  toolExecutors.getPrecipitationLatest = async ({ district }) => ({
    status: available ? "AVAILABLE" : "UNAVAILABLE",
    district,
    observationDate: available ? "2024-01-07" : null,
    ingestedAt: available ? "2026-11-09T01:37:39.775Z" : null,
    dailySummary: available ? {
      dateLabel: "2024-01-07",
      expectedIntervals: 48,
      observedIntervals: complete ? 48 : 47,
      validIntervals: complete ? 48 : 47,
      totalPrecipitationMm: complete ? 0 : null,
      completeness: complete ? "complete" : "incomplete",
    } : null,
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

    available = false;
    const missing = await assistantChatService.handleChat({
      message: "What is the latest rainfall from GPM?",
      district: "cumilla",
    });
    assert.equal(missing.dataDate, null);
    assert.equal(missing.dataQuality, "incomplete_or_unavailable");
    assert.match(missing.answer, /No validated GPM IMERG precipitation observations/);
    assert.doesNotMatch(missing.answer, /0\.00 mm|2024-01-07/);
  } finally {
    geminiAssistantClient.isConfigured = originalConfigured;
    toolExecutors.getPrecipitationLatest = originalPrecipitationTool;
  }
});

test("deterministic POWER, SMAP, and MODIS fallback uses observed values in both languages", async () => {
  const originalConfigured = geminiAssistantClient.isConfigured;
  const originals = {
    power: toolExecutors.getClimateRainfall,
    smap: toolExecutors.getSoilMoistureLatest,
    modis: toolExecutors.getVegetationLatest,
  };
  geminiAssistantClient.isConfigured = () => false;
  toolExecutors.getClimateRainfall = async () => ({
    district: "cumilla",
    dataset: "NASA POWER Daily Point (2001-2025)",
    provenance: "HISTORICAL_DATABASE",
    annualHistorical: { meanAnnualTotalMm: 2454.3144 },
  });
  toolExecutors.getSoilMoistureLatest = async () => ({
    district: "cumilla",
    date: "2024-01-08",
    soilMoisture: 0.3937,
    percentage: "39.4%",
    unit: "m³/m³",
    retrievalQualityFlag: 8,
    qualityClassification: "recommended",
    provenance: "NASA NSIDC DAAC",
  });
  toolExecutors.getVegetationLatest = async () => ({
    district: "cumilla",
    date: "2024-02-18",
    compositeDayOfYear: 50,
    ndvi: 0.2361,
    evi: 0.1159,
    pixelReliability: 1,
    qualityClassification: "marginal_data",
    provenance: "NASA LP DAAC / AppEEARS",
  });

  try {
    const powerEn = await assistantChatService.handleChat({ message: "NASA POWER historical rainfall", district: "cumilla" });
    const powerBn = await assistantChatService.handleChat({ message: "কুমিল্লার ঐতিহাসিক বৃষ্টিপাত", district: "cumilla" });
    for (const response of [powerEn, powerBn]) {
      assert.equal(response.dataDate, "2001-2025");
      assert.match(response.answer, /2454\.31/);
      assert.doesNotMatch(response.answer, /70%|15 mm|2130/);
      assert.ok(response.sources.some((source) => source.includes("NASA POWER")));
    }
    assert.equal(powerEn.language, "en");
    assert.equal(powerBn.language, "bn");

    const smapEn = await assistantChatService.handleChat({ message: "Latest soil moisture", district: "cumilla" });
    const smapBn = await assistantChatService.handleChat({ message: "কুমিল্লার মাটির আর্দ্রতা", district: "cumilla" });
    for (const response of [smapEn, smapBn]) {
      assert.equal(response.dataDate, "2024-01-08");
      assert.equal(response.dataQuality, "recommended");
      assert.match(response.answer, /0\.3937/);
      assert.match(response.answer, /8/);
      assert.ok(response.sources.some((source) => source.includes("NASA SMAP")));
    }
    assert.equal(smapEn.language, "en");
    assert.equal(smapBn.language, "bn");

    const modisEn = await assistantChatService.handleChat({ message: "Latest MODIS vegetation NDVI", district: "cumilla" });
    const modisBn = await assistantChatService.handleChat({ message: "কুমিল্লার MODIS সবুজতা", district: "cumilla" });
    for (const response of [modisEn, modisBn]) {
      assert.equal(response.dataDate, "2024-02-18");
      assert.equal(response.dataQuality, "marginal_data");
      assert.match(response.answer, /0\.2361/);
      assert.match(response.answer, /0\.1159/);
      assert.match(response.answer, /marginal_data/);
      assert.doesNotMatch(response.answer, /healthy|সুস্থ ও ঘন/);
      assert.ok(response.sources.some((source) => source.includes("NASA MODIS")));
    }
    assert.equal(modisEn.language, "en");
    assert.equal(modisBn.language, "bn");
  } finally {
    geminiAssistantClient.isConfigured = originalConfigured;
    toolExecutors.getClimateRainfall = originals.power;
    toolExecutors.getSoilMoistureLatest = originals.smap;
    toolExecutors.getVegetationLatest = originals.modis;
  }
});

test("deterministic environmental fallback discloses missing observations without values", async () => {
  const originalConfigured = geminiAssistantClient.isConfigured;
  const originals = {
    power: toolExecutors.getClimateRainfall,
    smap: toolExecutors.getSoilMoistureLatest,
    modis: toolExecutors.getVegetationLatest,
  };
  geminiAssistantClient.isConfigured = () => false;
  toolExecutors.getClimateRainfall = async () => ({ error: "No data" });
  toolExecutors.getSoilMoistureLatest = async () => ({ error: "No data" });
  toolExecutors.getVegetationLatest = async () => ({ error: "No data" });

  try {
    const power = await assistantChatService.handleChat({ message: "NASA POWER rainfall", district: "cumilla" });
    const smap = await assistantChatService.handleChat({ message: "soil moisture", district: "cumilla" });
    const modis = await assistantChatService.handleChat({ message: "MODIS NDVI", district: "cumilla" });
    for (const response of [power, smap, modis]) {
      assert.equal(response.dataQuality, "unavailable");
      assert.equal(response.dataDate, null);
      assert.match(response.answer, /No validated|No validated|পাওয়া যায়নি|সংরক্ষিত নেই/);
      assert.doesNotMatch(response.answer, /0\.3937|0\.2361|2454\.31|2130/);
    }
  } finally {
    geminiAssistantClient.isConfigured = originalConfigured;
    toolExecutors.getClimateRainfall = originals.power;
    toolExecutors.getSoilMoistureLatest = originals.smap;
    toolExecutors.getVegetationLatest = originals.modis;
  }
});

test("deterministic fallback refuses unsupported NASA POWER parameters instead of returning rainfall", async () => {
  const originalConfigured = geminiAssistantClient.isConfigured;
  const originalClimateTool = toolExecutors.getClimateRainfall;
  let toolCalls = 0;
  geminiAssistantClient.isConfigured = () => false;
  toolExecutors.getClimateRainfall = async () => {
    toolCalls += 1;
    return { annualHistorical: { meanAnnualTotalMm: 2454.3144 } };
  };

  try {
    const response = await assistantChatService.handleChat({
      message: "NASA POWER ozone concentration for Cumilla",
      district: "cumilla",
    });
    assert.equal(response.dataQuality, "unsupported_parameter");
    assert.equal(response.dataDate, null);
    assert.equal(response.language, "en");
    assert.equal(toolCalls, 0);
    assert.match(response.answer, /no verified NASA POWER query for ozone/i);
    assert.doesNotMatch(response.answer, /2454|mm/);
  } finally {
    geminiAssistantClient.isConfigured = originalConfigured;
    toolExecutors.getClimateRainfall = originalClimateTool;
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
