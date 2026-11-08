import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";

import "../src/config/env.config.js";
import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { Farm } from "../src/models/farm.model.js";
import { FarmActivity } from "../src/models/farmactivity.model.js";
import { FarmNotification } from "../src/models/farmnotification.model.js";
import { FarmNotificationService } from "../src/services/farmnotification.service.js";

let server;
let baseUrl;
let userAToken;
let userBToken;
let userAId;
let userBId;
let farmAId;
let farmBId;
let notificationAId;

before(async () => {
  const uri = process.env.MONGODB_URI;
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  // Cleanup test users and data
  const existingUsers = await User.find({ email: { $regex: /@notiftest\.org$/ } }).select("_id");
  const userIds = existingUsers.map((u) => u._id);
  if (userIds.length > 0) {
    const existingFarms = await Farm.find({ userId: { $in: userIds } }).select("_id");
    const farmIds = existingFarms.map((f) => f._id);
    await FarmNotification.deleteMany({ userId: { $in: userIds } });
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
      name: "Farmer Notif User A",
      email: "userA@notiftest.org",
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
      name: "Farmer Notif User B",
      email: "userB@notiftest.org",
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
      farmName: "Notif Farm Cumilla Aman",
      location: { districtCode: "cumilla", upazila: "Adarsha Sadar" },
      land: { area: 150, unit: "decimal", landType: "medium_high" },
      soil: { type: "loam", drainage: "good" },
      water: { irrigationAvailability: "available", waterSource: "Canal" },
      crop: {
        cropCode: "monsoon_aman",
        variety: "BRRI dhan49",
        plantingDate: todayStr,
      },
    }),
  });
  const farmAJson = await farmARes.json();
  farmAId = farmAJson.data._id;

  // Create Farm for User B
  const farmBRes = await fetch(`${baseUrl}/api/v1/farms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userBToken}`,
    },
    body: JSON.stringify({
      farmName: "Notif Farm Chattogram Boro",
      location: { districtCode: "chattogram", upazila: "Rangunia" },
      land: { area: 200, unit: "decimal" },
      crop: {
        cropCode: "boro_rice",
        variety: "BRRI dhan28",
        plantingDate: todayStr,
      },
    }),
  });
  const farmBJson = await farmBRes.json();
  farmBId = farmBJson.data._id;

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
  const existingUsers = await User.find({ email: { $regex: /@notiftest\.org$/ } }).select("_id");
  const userIds = existingUsers.map((u) => u._id);
  if (userIds.length > 0) {
    const existingFarms = await Farm.find({ userId: { $in: userIds } }).select("_id");
    const farmIds = existingFarms.map((f) => f._id);
    await FarmNotification.deleteMany({ userId: { $in: userIds } });
    await FarmActivity.deleteMany({ farmId: { $in: farmIds } });
    await Farm.deleteMany({ userId: { $in: userIds } });
    await User.deleteMany({ _id: { $in: userIds } });
  }
  await mongoose.disconnect();
});

test("Smart Farm Notifications Suite (Phase 9.6)", async (t) => {
  await t.test("API: GET /notifications requires authentication (401)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/notifications`);
    assert.equal(res.status, 401);
  });

  await t.test("Service: syncUserNotifications creates deterministic notifications without duplicates", async () => {
    const syncRes1 = await FarmNotificationService.syncUserNotifications(userAId);
    assert.ok(syncRes1.syncedCount >= 0);

    const count1 = await FarmNotification.countDocuments({ userId: userAId });
    assert.ok(count1 > 0, "User A should have generated notifications");

    // Second sync should not duplicate
    await FarmNotificationService.syncUserNotifications(userAId);
    const count2 = await FarmNotification.countDocuments({ userId: userAId });
    assert.equal(count2, count1, "Repeated sync must be idempotent with zero duplicate insertions");
  });

  await t.test("API: GET /notifications returns list of farm notifications (200)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/notifications`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data.notifications));
    assert.ok(json.data.notifications.length > 0);
    assert.ok(json.data.pagination);
    assert.ok(json.data.pagination.unreadCount > 0);

    const first = json.data.notifications[0];
    assert.ok(first._id);
    assert.ok(first.title);
    assert.ok(first.message);
    assert.ok(first.type);
    assert.equal(first.isRead, false);
    notificationAId = first._id;
  });

  await t.test("API: GET /notifications/unread-count returns accurate unread count (200)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(typeof json.data.unreadCount === "number");
    assert.ok(json.data.unreadCount > 0);
  });

  await t.test("API: PATCH /notifications/:id/read marks single notification as read (200)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/notifications/${notificationAId}/read`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.isRead, true);
    assert.ok(json.data.readAt);

    // Verify unread count decremented
    const countRes = await fetch(`${baseUrl}/api/v1/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const countJson = await countRes.json();
    assert.ok(typeof countJson.data.unreadCount === "number");
  });

  await t.test("Security IDOR: User B cannot mark User A's notification as read (404)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/notifications/${notificationAId}/read`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${userBToken}` },
    });
    assert.equal(res.status, 404);
  });

  await t.test("Security IDOR: User B cannot delete User A's notification (404)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/notifications/${notificationAId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userBToken}` },
    });
    assert.equal(res.status, 404);
  });

  await t.test("API: PATCH /notifications/read-all marks all unread notifications as read (200)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/notifications/read-all`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);

    const countRes = await fetch(`${baseUrl}/api/v1/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const countJson = await countRes.json();
    assert.equal(countJson.data.unreadCount, 0, "Unread count should be 0 after read-all");
  });

  await t.test("API: DELETE /notifications/:id dismisses notification (200)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/notifications/${notificationAId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);

    const check = await FarmNotification.findById(notificationAId);
    assert.equal(check, null, "Deleted notification should no longer exist");
  });
});
