import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";

import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { Farm } from "../src/models/farm.model.js";
import { FarmActivity } from "../src/models/farmactivity.model.js";
import { FarmNotification } from "../src/models/farmnotification.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { signToken } from "../src/utils/token.util.js";
import { getBangladeshDateKey } from "../src/utils/bangladesh-date.js";
import { env } from "../src/config/env.config.js";
import { assistantChatService } from "../src/services/ai/chat.service.js";
import { geminiAssistantClient } from "../src/services/ai/gemini.client.js";
import { toolExecutors } from "../src/services/ai/tools.executor.js";

function clone(value) {
  if (value instanceof mongoose.Types.ObjectId) return new mongoose.Types.ObjectId(value.toString());
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, child]) => typeof child !== "function").map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function valueAtPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function sameValue(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return String(left) === String(right);
}

function matches(document, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((part) => matches(document, part));
    if (key === "$and") return expected.every((part) => matches(document, part));

    const actual = valueAtPath(document, key);
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !(expected instanceof mongoose.Types.ObjectId)) {
      return Object.entries(expected).every(([operator, operand]) => {
        if (operator === "$in") return operand.some((item) => sameValue(actual, item));
        if (operator === "$nin") return !operand.some((item) => sameValue(actual, item));
        if (operator === "$ne") return !sameValue(actual, operand);
        if (operator === "$gt") return actual != null && new Date(actual) > new Date(operand);
        if (operator === "$gte") return actual != null && new Date(actual) >= new Date(operand);
        return false;
      });
    }

    return sameValue(actual, expected);
  });
}

function documentFor(row, collection) {
  if (!row) return null;
  const document = clone(row);
  const id = String(document._id);
  Object.defineProperties(document, {
    lean: { enumerable: false, value: () => Promise.resolve(clone(row)) },
    toObject: { enumerable: false, value: () => clone(document) },
    save: {
      enumerable: false,
      value: async () => {
        collection.set(id, clone(document));
        return document;
      },
    },
  });
  return document;
}

function oneQuery(row, collection) {
  const document = documentFor(row, collection);
  return {
    lean: async () => (document ? clone(document) : null),
    then(resolve, reject) { return Promise.resolve(document).then(resolve, reject); },
  };
}

function manyQuery(rows) {
  let current = rows;
  const query = {
    sort() { return this; },
    select() { return this; },
    skip(count) { current = current.slice(count); return this; },
    limit(count) { current = current.slice(0, count); return this; },
    populate() { return this; },
    lean: async () => clone(current),
    then(resolve, reject) { return Promise.resolve(clone(current)).then(resolve, reject); },
  };
  return query;
}

function ownedRows(collection, filter) {
  return [...collection.values()].filter((row) => matches(row, filter));
}

function saveNewDocument(collection, modelDocument) {
  if (!modelDocument._id) modelDocument._id = new mongoose.Types.ObjectId();
  const now = new Date();
  modelDocument.createdAt ||= now;
  modelDocument.updatedAt = now;
  const row = clone(modelDocument.toObject());
  collection.set(String(row._id), row);
  return documentFor(row, collection);
}

async function startServer() {
  const server = http.createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function api(baseUrl, route, { method = "GET", token, cookie, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = `km_session=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, headers: response.headers, json: await response.json() };
}

test("authenticated farmer journey works end-to-end with isolated in-memory persistence", async (t) => {
  assert.equal(mongoose.connection.readyState, 0, "journey test must run without opening MongoDB");

  const farms = new Map();
  const activities = new Map();
  const notifications = new Map();
  const conversations = new Map();
  const ownerId = new mongoose.Types.ObjectId();
  const secondUserId = new mongoose.Types.ObjectId();
  const users = new Map([
    [String(ownerId), { _id: ownerId, name: "Isolated Farmer A", email: "farmer-a@journey.invalid", role: "farmer" }],
    [String(secondUserId), { _id: secondUserId, name: "Isolated Farmer B", email: "farmer-b@journey.invalid", role: "farmer" }],
  ]);
  const ownerToken = signToken(users.get(String(ownerId)));
  const secondToken = signToken(users.get(String(secondUserId)));
  const originalGeminiKey = env.geminiApiKey;
  env.geminiApiKey = ""; // Force the existing deterministic planning explanation; no provider request.

  t.after(() => { env.geminiApiKey = originalGeminiKey; });
  t.mock.method(User, "findById", async (id) => users.get(String(id)) || null);
  t.mock.method(User, "findOne", (filter) => {
    const user = [...users.values()].find((candidate) => candidate.email === filter.email) || null;
    if (!user) return { select: async () => null };
    const loginDocument = clone(user);
    Object.defineProperties(loginDocument, {
      comparePassword: { enumerable: false, value: async (password) => password === "test-password" },
      save: { enumerable: false, value: async () => loginDocument },
    });
    return { select: async () => loginDocument };
  });
  t.mock.method(Farm, "find", (filter) => manyQuery(ownedRows(farms, filter)));
  t.mock.method(Farm, "findOne", (filter) => oneQuery(ownedRows(farms, filter)[0] || null, farms));
  t.mock.method(Farm.prototype, "save", async function saveFarm() { return saveNewDocument(farms, this); });
  t.mock.method(Conversation, "findOne", (filter) => oneQuery(ownedRows(conversations, filter)[0] || null, conversations));
  t.mock.method(Conversation, "create", async (document) => saveNewDocument(conversations, new Conversation(document)));
  t.mock.method(FarmActivity, "find", (filter) => manyQuery(ownedRows(activities, filter)));
  t.mock.method(FarmActivity, "findOne", (filter) => oneQuery(ownedRows(activities, filter)[0] || null, activities));
  t.mock.method(FarmActivity, "aggregate", async (pipeline) => {
    const rows = ownedRows(activities, pipeline[0]?.$match || {});
    const counts = new Map();
    for (const row of rows) counts.set(row.status, (counts.get(row.status) || 0) + 1);
    return [...counts].map(([_id, count]) => ({ _id, count }));
  });
  t.mock.method(FarmActivity, "insertMany", async (rows) => rows.map((row) => {
    const stored = { ...clone(row), _id: new mongoose.Types.ObjectId(), createdAt: new Date(), updatedAt: new Date() };
    activities.set(String(stored._id), stored);
    return clone(stored);
  }));
  t.mock.method(FarmActivity.prototype, "save", async function saveActivity() { return saveNewDocument(activities, this); });
  t.mock.method(FarmNotification, "bulkWrite", async (operations) => {
    let upsertedCount = 0;
    for (const operation of operations) {
      const { filter, update } = operation.updateOne;
      const key = filter.deduplicationKey;
      if (notifications.has(key)) continue;
      const row = { ...clone(update.$setOnInsert), _id: new mongoose.Types.ObjectId(), createdAt: new Date(), updatedAt: new Date() };
      notifications.set(key, row);
      upsertedCount++;
    }
    return { upsertedCount, modifiedCount: 0 };
  });
  t.mock.method(FarmNotification, "find", (filter) => manyQuery(ownedRows(notifications, filter)));
  t.mock.method(FarmNotification, "countDocuments", async (filter) => ownedRows(notifications, filter).length);

  const server = await startServer();
  try {
    const today = getBangladeshDateKey(new Date("2026-11-10T18:05:00.000Z"));
    assert.equal(today, "2026-11-11", "date-only farm events use Bangladesh civil time");

    const rejectedLogin = await api(server.baseUrl, "/auth/login", {
      method: "POST",
      body: { email: "farmer-a@journey.invalid", password: "wrong-password" },
    });
    assert.equal(rejectedLogin.status, 401);

    const login = await api(server.baseUrl, "/auth/login", {
      method: "POST",
      body: { email: "farmer-a@journey.invalid", password: "test-password" },
    });
    assert.equal(login.status, 200);
    assert.equal(login.json.data.user._id, String(ownerId));
    const cookieHeader = login.headers.get("set-cookie");
    assert.match(cookieHeader, /km_session=/);
    assert.match(cookieHeader, /httponly/i);
    const sessionCookie = cookieHeader.match(/km_session=([^;]+)/)?.[1];
    assert.ok(sessionCookie);
    const currentSession = await api(server.baseUrl, "/auth/me", { cookie: sessionCookie });
    assert.equal(currentSession.status, 200);
    assert.equal(currentSession.json.data.user._id, String(ownerId));
    const loggedOut = await api(server.baseUrl, "/auth/logout", { method: "POST", cookie: sessionCookie });
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers.get("set-cookie"), /km_session=;/);
    const noSession = await api(server.baseUrl, "/auth/me");
    assert.equal(noSession.status, 401);

    const unauthenticated = await api(server.baseUrl, "/farms", {
      method: "POST",
      body: { farmName: "Unauthenticated farm" },
    });
    assert.equal(unauthenticated.status, 401);

    const spoofedOwner = await api(server.baseUrl, "/farms", {
      method: "POST",
      token: ownerToken,
      body: { userId: String(secondUserId), farmName: "Spoofed owner", location: { districtCode: "cumilla", upazila: "Adarsha Sadar" }, land: { area: 12 }, crop: { cropCode: "mustard", plantingDate: today } },
    });
    assert.equal(spoofedOwner.status, 400);

    const created = await api(server.baseUrl, "/farms", {
      method: "POST",
      cookie: sessionCookie,
      body: {
        farmName: "Journey Test Field",
        location: { districtCode: "cumilla", upazila: "Adarsha Sadar", village: "Test village" },
        land: { area: 12, unit: "decimal", landType: "medium_high" },
        soil: { type: "loam", drainage: "moderate" },
        water: { irrigationAvailability: "limited", waterSource: "Canal" },
        crop: { cropCode: "mustard", variety: "BARI Sarisha-14", plantingDate: today },
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.data.userId, String(ownerId));
    const farmId = created.json.data._id;
    assert.ok(farmId);
    assert.ok(activities.size > 0, "farm creation generates official-calendar lifecycle activities");

    const farmList = await api(server.baseUrl, "/farms", { token: ownerToken });
    assert.equal(farmList.status, 200);
    assert.equal(farmList.json.data.farms.length, 1);
    assert.equal(farmList.json.data.farms[0]._id, farmId);

    const otherFarmList = await api(server.baseUrl, "/farms", { token: secondToken });
    assert.equal(otherFarmList.status, 200);
    assert.equal(otherFarmList.json.data.farms.length, 0);

    const foreignDetail = await api(server.baseUrl, `/farms/${farmId}`, { token: secondToken });
    assert.equal(foreignDetail.status, 404);
    const foreignUpdate = await api(server.baseUrl, `/farms/${farmId}`, {
      method: "PATCH",
      token: secondToken,
      body: { farmName: "Unauthorized change" },
    });
    assert.equal(foreignUpdate.status, 404);
    assert.equal(farms.get(farmId).farmName, "Journey Test Field");

    const updated = await api(server.baseUrl, `/farms/${farmId}`, {
      method: "PATCH",
      token: ownerToken,
      body: { farmName: "Journey Test Field Updated" },
    });
    assert.equal(updated.status, 200);
    const refreshedFarm = await api(server.baseUrl, `/farms/${farmId}`, { token: ownerToken });
    assert.equal(refreshedFarm.status, 200);
    assert.equal(refreshedFarm.json.data.farmName, "Journey Test Field Updated");

    const farmAssistant = await api(server.baseUrl, "/assistant/chat", {
      method: "POST",
      token: ownerToken,
      body: {
        message: "Show my farm details",
        farmId,
        district: "chattogram",
      },
    });
    assert.equal(farmAssistant.status, 200);
    assert.equal(farmAssistant.json.data.farmId, farmId);
    assert.match(farmAssistant.json.data.answer, /Journey Test Field Updated/);
    const assistantConversationId = farmAssistant.json.data.conversationId;
    assert.equal(conversations.get(assistantConversationId).district, "cumilla", "owned farm district overrides a conflicting client district");

    const foreignFarmAssistant = await api(server.baseUrl, "/assistant/chat", {
      method: "POST",
      token: secondToken,
      body: { message: "Show my farm details", farmId },
    });
    assert.equal(foreignFarmAssistant.status, 404, "a foreign farm ID fails closed instead of receiving a generic response");

    const changedFarmContext = await api(server.baseUrl, "/assistant/chat", {
      method: "POST",
      token: ownerToken,
      body: { message: "Tell me more", conversationId: assistantConversationId, farmId: null },
    });
    assert.equal(changedFarmContext.status, 409, "clearing a saved farm context requires starting a new conversation");

    const legacyFollowUp = await api(server.baseUrl, "/assistant/chat", {
      method: "POST",
      token: ownerToken,
      body: { message: "Tell me more", conversationId: assistantConversationId },
    });
    assert.equal(legacyFollowUp.status, 200, "legacy requests without farmId retain their owned conversation context");
    assert.equal(legacyFollowUp.json.data.farmId, farmId);

    const plan = await api(server.baseUrl, "/crop-planning/recommendations", {
      method: "POST",
      token: ownerToken,
      body: {
        farmId,
        districtCode: "chattogram",
        land: { area: 999, landType: "low" },
        water: { irrigationAvailability: "unavailable" },
        language: "en",
      },
    });
    assert.equal(plan.status, 200);
    assert.equal(plan.json.data.farm.id, farmId);
    assert.equal(plan.json.data.query.districtCode, "cumilla", "saved farm district overrides client district input");
    assert.equal(plan.json.data.query.land.area, 12, "saved farm area overrides client profile input");
    assert.ok(plan.json.data.crops.length > 0, "eligibility comes from official crop calendar data");
    assert.ok(plan.json.data.aiExplanation);

    const lifecycle = await api(server.baseUrl, `/farms/${farmId}/lifecycle?asOfDate=${today}`, { token: ownerToken });
    assert.equal(lifecycle.status, 200);
    assert.equal(lifecycle.json.data.crop.cropCode, "mustard");
    assert.ok(lifecycle.json.data.stages.length > 0);
    assert.ok(lifecycle.json.data.provenance.sourcePublisher);

    const realFetch = globalThis.fetch;
    let weatherProviderCalls = 0;
    t.mock.method(globalThis, "fetch", async (input, options) => {
      const url = new URL(String(input));
      if (url.hostname !== "api.open-meteo.com") return realFetch(input, options);
      weatherProviderCalls++;
      const forecastDates = Array.from({ length: 16 }, (_, index) => {
        const date = new Date(`${today}T00:00:00.000Z`);
        date.setUTCDate(date.getUTCDate() + index);
        return date.toISOString().slice(0, 10);
      });
      return new Response(JSON.stringify({
        daily: {
          time: forecastDates,
          temperature_2m_max: forecastDates.map(() => 30),
          temperature_2m_min: forecastDates.map(() => 22),
          precipitation_sum: forecastDates.map((_, index) => index === 0 ? 95 : 0),
          precipitation_probability_max: forecastDates.map(() => 90),
          wind_speed_10m_max: forecastDates.map(() => 20),
          wind_gusts_10m_max: forecastDates.map(() => 35),
          weather_code: forecastDates.map(() => 61),
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const weatherAlerts = await api(server.baseUrl, `/weather/alerts?farmId=${farmId}`, { token: ownerToken });
    assert.equal(weatherAlerts.status, 200);
    assert.ok(weatherProviderCalls > 0, "weather endpoint consumes a forecast response for the authenticated farm");
    assert.ok(weatherAlerts.json.data.alerts.some((alert) => alert.severity === "HIGH" || alert.severity === "SEVERE"));
    await new Promise((resolve) => setImmediate(resolve));
    const weatherNotices = [...notifications.values()].filter((notice) => String(notice.farmId) === farmId && notice.type === "WEATHER_ALERT");
    assert.ok(weatherNotices.length > 0, "high/severe forecast risk creates an owner-scoped in-app notification");
    assert.ok(weatherNotices.every((notice) => notice.metadata.sourceType === "METEOROLOGICAL_FORECAST"));
    const weatherNotificationCount = notifications.size;

    const assistantCalls = [];
    t.mock.method(geminiAssistantClient, "isConfigured", () => false);
    t.mock.method(toolExecutors, "getLocationWeatherForecast", async (args) => {
      assistantCalls.push({ tool: "forecast", args });
      return { location: { nameEn: "Cumilla", nameBn: "কুমিল্লা" }, current: null, error: "Unavailable" };
    });
    t.mock.method(toolExecutors, "getActiveWeatherAlerts", async (args) => {
      assistantCalls.push({ tool: "alerts", args });
      return { overallRiskLevel: "DATA_INSUFFICIENT", alertsCount: 0, officialWarningsCount: 0, alerts: [] };
    });
    const assistantWeather = await assistantChatService.handleChat({
      message: "What is the weather forecast today?",
      district: "cumilla",
      farmId,
      userId: ownerId.toString(),
      conversationId: "phase-8-2-weather-owner-context",
    });
    assert.equal(assistantCalls.length, 2);
    assert.ok(assistantCalls.every(({ args }) => args.farmId === farmId && args.userId === ownerId.toString()));
    assert.match(assistantWeather.answer, /DATA INSUFFICIENT/);

    const foreignWeatherAlerts = await api(server.baseUrl, `/weather/alerts?farmId=${farmId}&location=cumilla`, { token: secondToken });
    assert.equal(foreignWeatherAlerts.status, 404, "a foreign farm cannot silently fall back to a caller-selected district");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notifications.size, weatherNotificationCount, "foreign farm request cannot create notifications for another owner");

    await api(server.baseUrl, `/weather/alerts?farmId=${farmId}`, { token: ownerToken });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notifications.size, weatherNotificationCount, "repeated forecast alert sync is idempotent");

    const task = await api(server.baseUrl, `/farms/${farmId}/activities`, {
      method: "POST",
      token: ownerToken,
      body: { title: "Check field moisture", activityType: "irrigation_monitoring", scheduledDate: today },
    });
    assert.equal(task.status, 201);
    assert.equal(task.json.data.userId, String(ownerId));
    assert.equal(task.json.data.farmId, farmId);
    assert.equal(task.json.data.status, "PENDING");
    const activityId = task.json.data._id;

    const noticeFirst = await api(server.baseUrl, "/notifications", { token: ownerToken });
    assert.equal(noticeFirst.status, 200);
    assert.ok(noticeFirst.json.data.notifications.some((notice) => String(notice.activityId) === activityId && notice.type === "ACTIVITY_DUE_TODAY"));
    const notificationCount = notifications.size;
    const noticeSecond = await api(server.baseUrl, "/notifications", { token: ownerToken });
    assert.equal(noticeSecond.status, 200);
    assert.equal(notifications.size, notificationCount, "repeated synchronization is idempotent");

    const foreignNotifications = await api(server.baseUrl, "/notifications", { token: secondToken });
    assert.equal(foreignNotifications.status, 200);
    assert.equal(foreignNotifications.json.data.notifications.length, 0);

    const completed = await api(server.baseUrl, `/farms/${farmId}/activities/${activityId}`, {
      method: "PATCH",
      token: ownerToken,
      body: { status: "COMPLETED", completionNote: "Farmer confirmed the task" },
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.json.data.status, "COMPLETED");
    assert.ok(completed.json.data.completedAt, "completion date is written only after farmer action");

    const persistedActivity = await api(server.baseUrl, `/farms/${farmId}/activities/${activityId}`, { token: ownerToken });
    assert.equal(persistedActivity.status, 200);
    assert.equal(persistedActivity.json.data.status, "COMPLETED", "activity state survives a fresh API read");
    const currentNotices = await api(server.baseUrl, "/notifications", { token: ownerToken });
    assert.equal(currentNotices.status, 200);
    assert.equal(currentNotices.json.data.notifications.some((notice) => String(notice.activityId) === activityId), false, "completed activity notice is no longer presented as current");

    const dashboardOverview = await api(server.baseUrl, "/farms/activities/overview", { token: ownerToken });
    assert.equal(dashboardOverview.status, 200);
    assert.ok(dashboardOverview.json.data.completedRecent.some((activity) => String(activity._id) === activityId));
    assert.equal(mongoose.connection.readyState, 0, "API journey never opened a database connection");
  } finally {
    await server.close();
  }
});
