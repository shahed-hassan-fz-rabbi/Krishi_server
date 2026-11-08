import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";

import "../src/config/env.config.js";
import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { Farm } from "../src/models/farm.model.js";
import { FarmActivity } from "../src/models/farmactivity.model.js";

let server;
let baseUrl;
let userAToken;
let userBToken;
let userAId;
let userBId;
let farmAId;
let farmBId;
let customActivityId;
let generatedActivityId;

before(async () => {
  const uri = process.env.MONGODB_URI;
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  // Cleanup test users and farms
  const existingUsers = await User.find({ email: { $regex: /@activitytest\.org$/ } }).select("_id");
  const userIds = existingUsers.map((u) => u._id);
  if (userIds.length > 0) {
    const existingFarms = await Farm.find({ userId: { $in: userIds } }).select("_id");
    const farmIds = existingFarms.map((f) => f._id);
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
      name: "Farmer Activity User A",
      email: "userA@activitytest.org",
      password: "password123",
      district: "cumilla",
      upazila: "Adarsha Sadar",
    }),
  });
  const regAJson = await regARes.json();
  userAToken = regAJson.data.token;
  userAId = regAJson.data.user.id;

  // Register User B
  const regBRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Farmer Activity User B",
      email: "userB@activitytest.org",
      password: "password123",
      district: "chattogram",
      upazila: "Rangunia",
    }),
  });
  const regBJson = await regBRes.json();
  userBToken = regBJson.data.token;
  userBId = regBJson.data.user.id;

  // Create Farm for User A (Boro Rice in Cumilla with planting date)
  const farmARes = await fetch(`${baseUrl}/api/v1/farms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userAToken}`,
    },
    body: JSON.stringify({
      farmName: "Activity Test Farm A",
      location: { districtCode: "cumilla", upazila: "Adarsha Sadar", village: "Kandirpar" },
      land: { area: 50, unit: "decimal", landType: "medium_high" },
      soil: { type: "loam", drainage: "moderate" },
      water: { irrigationAvailability: "available", waterSource: "Deep Tubewell" },
      crop: {
        cropCode: "boro_rice",
        variety: "BRRI dhan28",
        cultivationMethod: "transplanting",
        plantingDate: "2026-01-15",
      },
    }),
  });
  const farmAJson = await farmARes.json();
  farmAId = farmAJson.data._id;

  // Create Farm for User B (Mustard in Chattogram)
  const farmBRes = await fetch(`${baseUrl}/api/v1/farms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userBToken}`,
    },
    body: JSON.stringify({
      farmName: "Activity Test Farm B",
      location: { districtCode: "chattogram", upazila: "Rangunia", village: "Mariamnagar" },
      land: { area: 30, unit: "decimal", landType: "high" },
      soil: { type: "silt", drainage: "good" },
      water: { irrigationAvailability: "limited" },
      crop: {
        cropCode: "mustard",
        variety: "BARI Sarisha-14",
        cultivationMethod: "direct_seeded",
        plantingDate: "2025-11-20",
      },
    }),
  });
  const farmBJson = await farmBRes.json();
  farmBId = farmBJson.data._id;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  const users = await User.find({ email: { $regex: /@activitytest\.org$/ } }).select("_id");
  const uids = users.map((u) => u._id);
  if (uids.length > 0) {
    const farms = await Farm.find({ userId: { $in: uids } }).select("_id");
    const fids = farms.map((f) => f._id);
    await FarmActivity.deleteMany({ farmId: { $in: fids } });
    await Farm.deleteMany({ userId: { $in: uids } });
    await User.deleteMany({ _id: { $in: uids } });
  }
  await mongoose.disconnect();
});

test("▶ Farm Activity Tracking Suite (Phase 9.5)", async (t) => {
  await t.test("API: POST /farms/:id/activities rejects unauthenticated requests (401)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test unauth",
        scheduledDate: "2026-02-01",
      }),
    });
    assert.equal(res.status, 401);
  });

  await t.test("API: POST /farms/:id/activities validates required fields (400)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        title: "",
        scheduledDate: "invalid-date",
      }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.error.code, "VALIDATION_ERROR");
  });

  await t.test("API: IDOR Protection — User B cannot create tasks on User A's farm (404)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        title: "Unauthorized task attempt",
        scheduledDate: "2026-02-01",
      }),
    });
    assert.equal(res.status, 404);
  });

  await t.test("API: User A creates a valid custom farmer activity (201)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        title: "Manual Field Weeding & Bund Repair",
        description: "Clear stubborn grassy weeds along the irrigation bunds.",
        activityType: "weeding",
        relatedStageCode: "tillering",
        scheduledDate: "2026-02-20",
      }),
    });

    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.title, "Manual Field Weeding & Bund Repair");
    assert.equal(json.data.activityType, "weeding");
    assert.equal(json.data.sourceType, "FARMER_CREATED");
    assert.equal(json.data.isCustom, true);
    assert.equal(json.data.status, "PENDING");
    customActivityId = json.data._id;
    assert.ok(customActivityId);
  });

  await t.test("API: User A lists farm activities (200) with counts", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data.activities));
    assert.ok(json.data.counts);
    assert.ok(json.data.counts.TOTAL >= 1);
  });

  await t.test("API: IDOR Protection — User B cannot list User A's activities (404)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities`, {
      headers: { Authorization: `Bearer ${userBToken}` },
    });
    assert.equal(res.status, 404);
  });

  await t.test("API: POST /farms/:id/activities/generate creates official template activities & prevents duplicates", async () => {
    const res1 = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res1.status, 200);
    const json1 = await res1.json();
    assert.equal(json1.success, true);
    assert.ok(json1.data.totalTemplateTasks >= 5);
    assert.ok(json1.data.generatedCount >= 0); // initial createFarm may have already generated them

    // Re-triggering generate should detect 0 new tasks and 100% existing tasks (Deduplication)
    const res2 = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res2.status, 200);
    const json2 = await res2.json();
    assert.equal(json2.success, true);
    assert.equal(json2.data.generatedCount, 0, "Duplicate generation must be prevented");
    assert.ok(json2.data.existingCount > 0);

    // Pick an official activity for status transition tests
    const listRes = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities?status=PENDING`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const listJson = await listRes.json();
    const officialAct = listJson.data.activities.find((a) => a.sourceType === "OFFICIAL_GUIDANCE");
    assert.ok(officialAct, "Must have at least one official guidance activity");
    assert.equal(officialAct.isCustom, false);
    assert.ok(officialAct.sourceReferences.documentTitle);
    assert.ok(officialAct.sourceReferences.publisher);
    generatedActivityId = officialAct._id;
  });

  await t.test("API: PATCH /farms/:id/activities/:activityId transitions status and records completion notes", async () => {
    // 1. Transition to IN_PROGRESS
    const resProgress = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities/${customActivityId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({ status: "IN_PROGRESS" }),
    });
    assert.equal(resProgress.status, 200);
    const progressJson = await resProgress.json();
    assert.equal(progressJson.data.status, "IN_PROGRESS");
    assert.equal(progressJson.data.completedAt, null);

    // 2. Transition to COMPLETED with note
    const resComplete = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities/${customActivityId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        status: "COMPLETED",
        completionNote: "Finished weeding northern section with 2 laborers.",
      }),
    });
    assert.equal(resComplete.status, 200);
    const completeJson = await resComplete.json();
    assert.equal(completeJson.data.status, "COMPLETED");
    assert.equal(completeJson.data.completionNote, "Finished weeding northern section with 2 laborers.");
    assert.ok(completeJson.data.completedAt);

    // 3. Reschedule an activity
    const resResched = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities/${customActivityId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        scheduledDate: "2026-02-25",
      }),
    });
    assert.equal(resResched.status, 200);
    const reschedJson = await resResched.json();
    assert.equal(reschedJson.data.scheduledDate, "2026-02-25");
  });

  await t.test("API: IDOR Protection — User B cannot update User A's activity (404)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities/${customActivityId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({ status: "SKIPPED" }),
    });
    assert.equal(res.status, 404);
  });

  await t.test("API: DELETE /farms/:id/activities/:activityId rejects deletion of official guidance tasks (403)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities/${generatedActivityId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error.code, "OFFICIAL_TASK_DELETE_FORBIDDEN");
  });

  await t.test("API: DELETE /farms/:id/activities/:activityId allows deleting farmer custom tasks (200)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities/${customActivityId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.deletedId, customActivityId);

    // Confirm deletion
    const checkRes = await fetch(`${baseUrl}/api/v1/farms/${farmAId}/activities/${customActivityId}`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(checkRes.status, 404);
  });

  await t.test("API: GET /farms/activities/overview returns dashboard aggregated activity status (200)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/activities/overview`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.hasFarms, true);
    assert.ok(Array.isArray(json.data.todayActivities));
    assert.ok(Array.isArray(json.data.upcomingActivities));
    assert.ok(json.data.counts);
    assert.ok(json.data.counts.pending >= 0);
  });

  await t.test("API: GET /farms/activities/notifications-readiness returns notification alert candidates (200)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/activities/notifications-readiness`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data.alerts));
    assert.ok(json.data.targetWindowEnd);
  });

  await t.test("Cascade Deletion: deleting a farm deletes all its activities", async () => {
    // Farm A currently has official activities
    const beforeCount = await FarmActivity.countDocuments({ farmId: farmAId });
    assert.ok(beforeCount > 0, "Farm A should have activities before deletion");

    const deleteRes = await fetch(`${baseUrl}/api/v1/farms/${farmAId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(deleteRes.status, 200);

    const afterCount = await FarmActivity.countDocuments({ farmId: farmAId });
    assert.equal(afterCount, 0, "All activities must be cascade deleted when farm is deleted");
  });
});
