import test from "node:test";
import assert from "node:assert/strict";
import { AssistantChatService } from "../src/services/ai/chat.service.js";
import { geminiAssistantClient } from "../src/services/ai/gemini.client.js";
import { toolExecutors } from "../src/services/ai/tools.executor.js";

function useDeterministicFallback(t) {
  t.mock.method(geminiAssistantClient, "isConfigured", () => false);
  return new AssistantChatService();
}

test("deterministic farmer assistant uses only provided profile values and supports English", async (t) => {
  const assistant = useDeterministicFallback(t);
  t.mock.method(toolExecutors, "getMyFarmDetails", async () => ({
    name: "Test Field",
    districtName: "Cumilla",
    upazila: "Debidwar",
    cropName: "Mustard",
    variety: "Not specified",
    landArea: null,
    soilType: null,
    waterSource: null,
    plantingDate: null,
  }));

  const result = await assistant.handleChat({
    message: "Show my farm details",
    farmId: "safe-fixture-farm",
    userId: "safe-fixture-user",
  });

  assert.equal(result.language, "en");
  assert.match(result.answer, /Test Field/);
  assert.match(result.answer, /Soil: not specified/);
  assert.match(result.answer, /Water source: not specified/);
  assert.doesNotMatch(result.answer, /loam|rain and irrigation/i);
  assert.equal(result.dataDate, null);
});

test("missing GPM daily data stays unavailable and is never rendered as zero rainfall", async (t) => {
  const assistant = useDeterministicFallback(t);
  t.mock.method(toolExecutors, "getPrecipitationLatest", async () => ({
    status: "UNAVAILABLE",
    dailySummary: null,
    observationDate: null,
  }));

  const result = await assistant.handleChat({ message: "What is the latest GPM rainfall?", district: "cumilla" });
  assert.equal(result.language, "en");
  assert.equal(result.dataQuality, "incomplete_or_unavailable");
  assert.match(result.answer, /No validated GPM IMERG precipitation observations/);
  assert.doesNotMatch(result.answer, /0 mm|0\/48|0 valid/i);
  assert.equal(result.dataDate, null);
});

test("crop calendar fallback discloses unavailable data instead of inventing a sowing window", async (t) => {
  const assistant = useDeterministicFallback(t);
  t.mock.method(toolExecutors, "getCropCalendarAdvisory", async () => ({ error: "CALENDAR_UNAVAILABLE" }));

  const result = await assistant.handleChat({ message: "When is the mustard sowing period?", district: "cumilla" });
  assert.equal(result.language, "en");
  assert.equal(result.dataQuality, "unavailable");
  assert.match(result.answer, /currently unavailable/);
  assert.doesNotMatch(result.answer, /November|Nov\s+\d|BARI mustard/i);
  assert.equal(result.dataDate, null);
});

test("general help follows the question language without a fabricated freshness date", async (t) => {
  const assistant = useDeterministicFallback(t);
  const english = await assistant.handleChat({ message: "Hello, how can you help?" });
  const bangla = await assistant.handleChat({ message: "আপনি কীভাবে সাহায্য করতে পারেন?" });
  assert.equal(english.language, "en");
  assert.match(english.answer, /I can help/);
  assert.equal(bangla.language, "bn");
  assert.match(bangla.answer, /আমি আপনার নির্বাচিত খামার/);
  assert.equal(english.dataDate, null);
  assert.equal(bangla.dataDate, null);
});