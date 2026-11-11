import test from "node:test";
import assert from "node:assert/strict";
import { Farm } from "../src/models/farm.model.js";
import { FarmNotification } from "../src/models/farmnotification.model.js";
import {
  resolveLocationContext,
  syncFarmWeatherNotifications,
} from "../src/controllers/weather.controller.js";
import { getWeatherFarmContext } from "../src/services/ai/tools.executor.js";
import { AssistantChatService } from "../src/services/ai/chat.service.js";
import { geminiAssistantClient } from "../src/services/ai/gemini.client.js";
import { toolExecutors } from "../src/services/ai/tools.executor.js";
import { getActiveOfficialWarningsResult } from "../src/services/weather/warning.service.js";
import { resolveWarningDistrict, resolveWarningDivision } from "../src/config/weather.config.js";

const ownerId = "64b000000000000000000001";
const otherUserId = "64b000000000000000000002";
const farmId = "64b000000000000000000010";

function request({ userId, query = {} } = {}) {
  return { user: userId ? { _id: userId } : null, query };
}

function farmFixture() {
  return {
    _id: farmId,
    userId: ownerId,
    farmName: "Isolated weather test farm",
    location: { district: "Cumilla", districtCode: "cumilla", upazila: "Burichang" },
    crop: { cropCode: "boro_rice", plantingDate: "2026-11-11" },
  };
}

test("farm-specific weather requires authentication before querying farm data", async () => {
  let queried = false;
  const original = Farm.findOne;
  Farm.findOne = () => { queried = true; throw new Error("must not query"); };
  try {
    await assert.rejects(resolveLocationContext(request({ query: { farmId, location: "chattogram" } })), { statusCode: 401 });
    assert.equal(queried, false);
  } finally {
    Farm.findOne = original;
  }
});

test("foreign farm returns unavailable and cannot fall back to query district", async () => {
  let filter;
  const original = Farm.findOne;
  Farm.findOne = (query) => {
    filter = query;
    return { lean: async () => null };
  };
  try {
    await assert.rejects(
      resolveLocationContext(request({ userId: otherUserId, query: { farmId, location: "chattogram" } })),
      { statusCode: 404 },
    );
    assert.equal(String(filter._id), farmId);
    assert.equal(String(filter.userId), otherUserId);
  } finally {
    Farm.findOne = original;
  }
});

test("owned farm controls weather district and lifecycle stage while crop selection is explicit", async () => {
  let filter;
  const original = Farm.findOne;
  Farm.findOne = (query) => {
    filter = query;
    return { lean: async () => farmFixture() };
  };
  try {
    const context = await resolveLocationContext(request({
      userId: ownerId,
      query: { farmId, location: "chattogram", district: "chattogram", latitude: "22.3569", longitude: "91.7832", crop: "boro_rice", stage: "forged-stage" },
    }));
    assert.equal(String(filter.userId), ownerId);
    assert.equal(context.locationIdentifier, "cumilla");
    assert.equal(context.latitude, null, "client coordinates cannot redirect farm-bound weather context");
    assert.equal(context.crop, "boro_rice");
    assert.notEqual(context.stage, "forged-stage");
    assert.ok(context.stage, "stage is calculated from the stored planting date and official calendar");

    const alternateCrop = await resolveLocationContext(request({ userId: ownerId, query: { farmId, crop: "mustard" } }));
    assert.equal(alternateCrop.locationIdentifier, "cumilla");
    assert.equal(alternateCrop.crop, "mustard");
    assert.equal(alternateCrop.stage, null, "a different planned crop has no asserted lifecycle stage");
  } finally {
    Farm.findOne = original;
  }
});

test("assistant farm context uses stored location, selected crop and official-calendar stage without guessing", () => {
  const context = getWeatherFarmContext(farmFixture(), "boro_rice");
  assert.equal(context.districtCode, "cumilla");
  assert.equal(context.upazila, "Burichang");
  assert.equal(context.cropCode, "boro_rice");
  assert.equal(context.cropStageStatus, "OFFICIAL_CALENDAR_ESTIMATE");
  assert.ok(context.cropStage?.stageNameEn);
  assert.match(context.spatialLimitation, /not a farm-level/);

  const alternateCrop = getWeatherFarmContext(farmFixture(), "mustard");
  assert.equal(alternateCrop.cropStage, null);
  assert.equal(alternateCrop.cropStageStatus, "UNAVAILABLE");
});

test("deterministic assistant grounds weekly guidance in the selected farm and preserves unavailable values", async (t) => {
  t.mock.method(geminiAssistantClient, "isConfigured", () => false);
  const farmContext = getWeatherFarmContext(farmFixture(), "boro_rice");
  const calls = [];
  t.mock.method(toolExecutors, "getLocationWeatherForecast", async (args) => {
    calls.push(["forecast", args]);
    return { location: { nameEn: "Cumilla", nameBn: "কুমিল্লা" }, current: null, error: "unavailable", farmContext };
  });
  t.mock.method(toolExecutors, "getActiveWeatherAlerts", async (args) => {
    calls.push(["alerts", args]);
    return { overallRiskLevel: "DATA_INSUFFICIENT", alertsCount: 0, alerts: [], farmContext };
  });
  t.mock.method(toolExecutors, "getWeeklyWeatherOutlook", async (args) => {
    calls.push(["weekly", args]);
    return { dataStatus: "AVAILABLE", weeklyTendencies: [{ status: "AVAILABLE", week: "Week 1 (2026-11-11 to 2026-11-17)", expectedRainfallMeanMm: 0, rainfallRangeMm: { min: 0, max: 0 }, expectedTempMeanC: 27 }], source: "Open-Meteo Seasonal Forecast API", disclaimer: "Regional output." };
  });

  const service = new AssistantChatService();
  const result = await service.handleChat({
    message: "Give me a weekly weather outlook",
    district: "cumilla",
    farmId,
    userId: ownerId,
    conversationId: "isolated-weather-farm-outlook-test",
  });
  assert.match(result.answer, /DATA INSUFFICIENT/);
  assert.match(result.answer, /Six-week regional outlook/);
  assert.match(result.answer, /0 mm/);
  assert.match(result.answer, /regional Open-Meteo model outlooks/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([, args]) => args.farmId === farmId && args.userId === ownerId));
});

test("high severity farm weather notifications are owner scoped, source typed, expiring and idempotent", async (t) => {
  let operations;
  t.mock.method(FarmNotification, "bulkWrite", async (ops) => { operations = ops; return { upsertedCount: 1 }; });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const farm = { _id: farmId };
  await syncFarmWeatherNotifications({
    farm,
    userId: ownerId,
    assessment: {
      overallRiskLevel: "HIGH",
      alerts: [
        { id: "rain-risk-1", severity: "HIGH", hazardType: "HEAVY_RAIN", titleEn: "Heavy rain", actionAdviceEn: "Check drainage.", validUntil: expiresAt },
        { id: "missing-risk", severity: "HIGH", hazardType: "INSUFFICIENT_DATA", titleEn: "Unavailable", validUntil: expiresAt },
        { id: "old-risk", severity: "SEVERE", titleEn: "Expired", validUntil: "2000-01-01T00:00:00.000Z" },
      ],
    },
  });
  assert.equal(operations.length, 1);
  const op = operations[0].updateOne;
  assert.equal(String(op.filter.userId), ownerId);
  assert.equal(String(op.filter.farmId), farmId);
  assert.equal(op.update.$setOnInsert.type, "WEATHER_ALERT");
  assert.equal(op.update.$setOnInsert.message, "Heavy rain Guidance: Check drainage.");
  assert.equal(op.update.$setOnInsert.metadata.sourceType, "METEOROLOGICAL_FORECAST");
  assert.equal(op.updateOne?.upsert, undefined);
  assert.equal(op.upsert, true);
});

test("unavailable weather never creates a safe or notification state", async (t) => {
  let called = false;
  t.mock.method(FarmNotification, "bulkWrite", async () => { called = true; });
  await syncFarmWeatherNotifications({
    farm: { _id: farmId },
    userId: ownerId,
    assessment: { overallRiskLevel: "DATA_INSUFFICIENT", alerts: [] },
  });
  assert.equal(called, false);
});

test("warning lookup distinguishes unavailable storage and maps farm districts to their administrative division", async () => {
  const result = await getActiveOfficialWarningsResult({ division: "Chattogram", district: "Cumilla" });
  assert.equal(result.status, "UNAVAILABLE");
  assert.deepEqual(result.warnings, []);
  assert.ok(result.checkedAt);
  assert.equal(resolveWarningDivision("cumilla"), "Chattogram");
  assert.equal(resolveWarningDistrict("cumilla"), "Cumilla");
});
