import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";

import "../src/config/env.config.js";
import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { Farm } from "../src/models/farm.model.js";
import { FarmActivity } from "../src/models/farmactivity.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { toolExecutors } from "../src/services/ai/tools.executor.js";

let server;
let baseUrl;
let userAToken;
let userBToken;
let userAId;
let userBId;
let farmAId;
let farmBId;

before(async () => {
  const uri = process.env.MONGODB_URI;
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  // Cleanup test users and data
  const existingUsers = await User.find({ email: { $regex: /@farmassist\.org$/ } }).select("_id");
  const userIds = existingUsers.map((u) => u._id);
  if (userIds.length > 0) {
    const existingFarms = await Farm.find({ userId: { $in: userIds } }).select("_id");
    const farmIds = existingFarms.map((f) => f._id);
    await Conversation.deleteMany({ userId: { $in: userIds } });
    await FarmActivity.deleteMany({ farmId: { $in: farmIds } });
    await Farm.deleteMany({ userId: { $in: userIds } });
    await User.deleteMany({ _id: { $in: userIds } });
  }

  server = http.createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Register User A
  const regARes = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Farmer Assist User A",
      email: "userA@farmassist.org",
      password: "password123",
      preferredDistrict: "cumilla",
    }),
  });
  const regAJson = await regARes.json();
  userAToken = regAJson.data.token;
  userAId = regAJson.data.user._id;

  // Register User B
  const regBRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Farmer Assist User B",
      email: "userB@farmassist.org",
      password: "password123",
      preferredDistrict: "chattogram",
    }),
  });
  const regBJson = await regBRes.json();
  userBToken = regBJson.data.token;
  userBId = regBJson.data.user._id;

  // Create Farm for User A
  const todayStr = new Date().toISOString().split("T")[0];
  const farmARes = await fetch(`${baseUrl}/api/v1/farms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userAToken}`,
    },
    body: JSON.stringify({
      farmName: "Assist Aman Field",
      location: { districtCode: "cumilla", upazila: "Adarsha Sadar" },
      land: { area: 250, unit: "decimal" },
      crop: {
        cropCode: "monsoon_aman",
        variety: "BRRI dhan75",
        plantingDate: todayStr,
      },
    }),
  });
  const farmAJson = await farmARes.json();
  farmAId = farmAJson.data._id;

  // Generate activities for Farm A
  await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userAToken}` },
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  const existingUsers = await User.find({ email: { $regex: /@farmassist\.org$/ } }).select("_id");
  const userIds = existingUsers.map((u) => u._id);
  if (userIds.length > 0) {
    const existingFarms = await Farm.find({ userId: { $in: userIds } }).select("_id");
    const farmIds = existingFarms.map((f) => f._id);
    await Conversation.deleteMany({ userId: { $in: userIds } });
    await FarmActivity.deleteMany({ farmId: { $in: farmIds } });
    await Farm.deleteMany({ userId: { $in: userIds } });
    await User.deleteMany({ _id: { $in: userIds } });
  }
  await mongoose.disconnect();
});

test("Farm-Aware AI Assistant Suite (Phase 9.6)", async (t) => {
  await t.test("Tool: getMyFarmDetails returns verified farm profile", async () => {
    const details = await toolExecutors.getMyFarmDetails({ farmId: farmAId, userId: userAId });
    assert.equal(details.name, "Assist Aman Field");
    assert.equal(details.cropCode, "monsoon_aman");
    assert.equal(details.variety, "BRRI dhan75");
    assert.equal(details.districtCode, "cumilla");
  });

  await t.test("Tool: getMyFarmDetails prevents IDOR access for unauthorized user", async () => {
    const details = await toolExecutors.getMyFarmDetails({ farmId: farmAId, userId: userBId });
    assert.ok(details.error);
    assert.ok(details.error.includes("FARM_ACCESS_DENIED"));
  });

  await t.test("Tool: getMyFarmLifecycle returns stages and estimated progress", async () => {
    const lifecycle = await toolExecutors.getMyFarmLifecycle({ farmId: farmAId, userId: userAId });
    assert.equal(lifecycle.farmName, "Assist Aman Field");
    assert.ok(lifecycle.currentStage);
    assert.ok(lifecycle.totalStagesCount > 0);
    assert.equal(lifecycle.daysSincePlanting, 1);
  });

  await t.test("Tool: getMyFarmActivities returns scheduled activities", async () => {
    const activities = await toolExecutors.getMyFarmActivities({ farmId: farmAId, userId: userAId });
    assert.equal(activities.farmName, "Assist Aman Field");
    assert.ok(activities.totalFound > 0);
    assert.ok(Array.isArray(activities.activities));
  });

  await t.test("Tool: getMyFarmEnvironmentalContext returns NASA observations and scientific safeguards", async () => {
    const envCtx = await toolExecutors.getMyFarmEnvironmentalContext({ farmId: farmAId, userId: userAId });
    assert.equal(envCtx.farmName, "Assist Aman Field");
    assert.ok(envCtx.environmentalContext.soilMoistureSurface);
    assert.ok(envCtx.environmentalContext.vegetationIndex);
    assert.ok(envCtx.environmentalContext.climateBaseline);
    assert.ok(envCtx.scientificSafeguards.rootZoneDisclaimer);
    assert.ok(envCtx.scientificSafeguards.vegetationDisclaimer);
  });

  await t.test("Tool: getOfficialCropGuidance returns BAMIS/BRRI crop stages", async () => {
    const guidance = await toolExecutors.getOfficialCropGuidance({
      cropCode: "monsoon_aman",
      districtCode: "cumilla",
    });
    assert.ok(guidance.cropNameBn);
    assert.ok(guidance.totalDurationDays > 0);
    assert.ok(guidance.allStages.length > 0);
  });

  await t.test("API: POST /assistant/chat with farmId answers farm activities query", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        message: "আমার খামারে কী কাজ বাকি আছে?",
        farmId: farmAId,
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.answer);
    assert.ok(json.data.answer.includes("Assist Aman Field"));
    assert.equal(json.data.farmId, farmAId);
    assert.ok(json.data.conversationId);
  });

  await t.test("API: POST /assistant/chat with farmId answers lifecycle stage query", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        message: "আমার ফসল এখন কোন বৃদ্ধি পর্যায়ে আছে?",
        farmId: farmAId,
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.answer);
    assert.ok(json.data.answer.includes("বৃদ্ধি পর্যায়") || json.data.answer.includes("Assist Aman Field"));
  });

  await t.test("API: POST /assistant/chat with farmId answers environmental query with NASA data", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        message: "আমার খামারের পরিবেশ এবং মাটির আর্দ্রতা কেমন?",
        farmId: farmAId,
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.answer);
    assert.ok(json.data.answer.includes("SMAP") || json.data.answer.includes("আর্দ্রতা"));
    assert.ok(json.data.sources.some((s) => s.includes("SMAP") || s.includes("NASA")));
  });

  await t.test("API: POST /assistant/chat persists conversation linked to farmId", async () => {
    const conv = await Conversation.findOne({ farmId: farmAId, userId: userAId });
    assert.ok(conv, "Conversation linked to farm should be persisted");
    assert.equal(conv.farmId.toString(), farmAId);
    assert.ok(conv.messages.length >= 2);
  });
});
