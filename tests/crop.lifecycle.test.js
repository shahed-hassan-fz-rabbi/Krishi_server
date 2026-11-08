import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";

import "../src/config/env.config.js";
import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { Farm } from "../src/models/farm.model.js";
import {
  listSupportedTemplates,
  getCropLifecycleTemplate,
  generateFarmLifecycleTimeline,
} from "../src/services/croplifecycle.service.js";

let server;
let baseUrl;

before(async () => {
  const uri = process.env.MONGODB_URI;
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  // Clean fixtures
  const testUsers = await User.find({ email: { $regex: /@lifecycletest\.org$/ } });
  await Farm.deleteMany({ userId: { $in: testUsers.map((u) => u._id) } });
  await User.deleteMany({ email: { $regex: /@lifecycletest\.org$/ } });

  server = http.createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  const testUsers = await User.find({ email: { $regex: /@lifecycletest\.org$/ } });
  await Farm.deleteMany({ userId: { $in: testUsers.map((u) => u._id) } });
  await User.deleteMany({ email: { $regex: /@lifecycletest\.org$/ } });
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect();
});

test("Crop Lifecycle Template Engine Suite", async (t) => {
  await t.test("Service: listSupportedTemplates returns 8 verified combinations", () => {
    const list = listSupportedTemplates();
    assert.equal(list.length, 8);
    const cropCodes = new Set(list.map((item) => item.cropCode));
    assert.deepEqual(
      [...cropCodes].sort(),
      ["aus_rice", "boro_rice", "monsoon_aman", "mustard"].sort()
    );

    const districts = new Set(list.map((item) => item.districtCode));
    assert.deepEqual([...districts].sort(), ["chattogram", "cumilla"].sort());
  });

  await t.test("Service: getCropLifecycleTemplate returns structured stages for Aman", () => {
    const res = getCropLifecycleTemplate("monsoon_aman", "cumilla");
    assert.equal(res.success, true);
    const tmpl = res.data;
    assert.equal(tmpl.cropCode, "monsoon_aman");
    assert.equal(tmpl.districtCode, "cumilla");
    assert.equal(tmpl.stages.length, 5);
    assert.equal(tmpl.totalDurationDays, 133);
    assert.ok(tmpl.sourceReferences.url);
    assert.equal(tmpl.stages[0].stageCode, "seedbed");
    assert.equal(tmpl.stages[0].durationDays, 25);
  });

  await t.test("Service: getCropLifecycleTemplate rejects invalid crop or district", () => {
    const res1 = getCropLifecycleTemplate("dragonfruit", "cumilla");
    assert.equal(res1.success, false);
    assert.match(res1.error, /not supported/);

    const res2 = getCropLifecycleTemplate("monsoon_aman", "sylhet");
    assert.equal(res2.success, false);
    assert.match(res2.error, /no verified crop calendar/);
  });

  await t.test("Service: generateFarmLifecycleTimeline calculates stage timeline and current stage", () => {
    const farmMock = {
      farmName: "Test Aman Plot",
      location: { districtCode: "cumilla", upazila: "Burichang" },
      crop: { cropCode: "monsoon_aman", plantingDate: "2026-07-20" },
    };

    // As of 2026-08-05 (17 days after planting -> within Stage 1: Seedbed, 1..25)
    const t1 = generateFarmLifecycleTimeline(farmMock, { asOfDate: "2026-08-05" });
    assert.equal(t1.success, true);
    assert.equal(t1.data.timelineOverview.daysSincePlanting, 17);
    assert.equal(t1.data.timelineOverview.currentStage.stageCode, "seedbed");
    assert.equal(t1.data.timelineOverview.currentStage.dayInStage, 17);
    assert.equal(t1.data.timelineOverview.nextStage.stageCode, "transplanting_early_veg");

    // As of 2026-08-25 (37 days after planting -> within Stage 2: Transplanting, 26..53)
    const t2 = generateFarmLifecycleTimeline(farmMock, { asOfDate: "2026-08-25" });
    assert.equal(t2.data.timelineOverview.currentStage.stageCode, "transplanting_early_veg");
    assert.equal(t2.data.stages[0].status, "completed");
    assert.equal(t2.data.stages[1].status, "current");
    assert.equal(t2.data.stages[2].status, "upcoming");
  });

  await t.test("Service: handles future planting date and completed lifecycle safely", () => {
    const farmFuture = {
      location: { districtCode: "chattogram" },
      crop: { cropCode: "mustard", plantingDate: "2026-11-20" },
    };
    const tFuture = generateFarmLifecycleTimeline(farmFuture, { asOfDate: "2026-11-08" });
    assert.equal(tFuture.data.timelineOverview.isPending, true);
    assert.equal(tFuture.data.timelineOverview.currentStage, null);
    assert.ok(tFuture.data.stages.every((s) => s.status === "upcoming"));

    const farmPast = {
      location: { districtCode: "cumilla" },
      crop: { cropCode: "mustard", plantingDate: "2025-11-01" },
    };
    const tPast = generateFarmLifecycleTimeline(farmPast, { asOfDate: "2026-03-01" });
    assert.equal(tPast.data.timelineOverview.isCompleted, true);
    assert.equal(tPast.data.timelineOverview.currentStage, null);
    assert.ok(tPast.data.stages.every((s) => s.status === "completed"));
  });

  await t.test("Service: handles missing planting date gracefully without crashing", () => {
    const farmNoDate = {
      location: { districtCode: "cumilla" },
      crop: { cropCode: "mustard" },
    };
    const tNoDate = generateFarmLifecycleTimeline(farmNoDate);
    assert.equal(tNoDate.success, true);
    assert.equal(tNoDate.data.crop.isValidPlantingDate, false);
    assert.equal(tNoDate.data.timelineOverview.daysSincePlanting, null);
    assert.equal(tNoDate.data.stages[0].status, "unknown");
    assert.equal(tNoDate.data.stages[0].estimatedStartDate, null);
  });
});

test("Crop Lifecycle Endpoints & Security Integration Suite", async (t) => {
  let userAToken = "";
  let userBToken = "";
  let userAFarmId = "";

  await t.test("Register User A and User B", async () => {
    const resA = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Farmer Rafiq",
        email: "rafiq@lifecycletest.org",
        password: "Password123!",
      }),
    });
    const dataA = await resA.json();
    userAToken = dataA.data.token;

    const resB = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Farmer Habibur",
        email: "habibur@lifecycletest.org",
        password: "Password123!",
      }),
    });
    const dataB = await resB.json();
    userBToken = dataB.data.token;
  });

  await t.test("GET /api/v1/crop-lifecycle/templates returns public list", async () => {
    const res = await fetch(`${baseUrl}/api/v1/crop-lifecycle/templates`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.templates.length, 8);
  });

  await t.test("GET /api/v1/crop-lifecycle/templates/:cropCode returns crop details", async () => {
    const res = await fetch(`${baseUrl}/api/v1/crop-lifecycle/templates/boro_rice?district=cumilla`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.cropCode, "boro_rice");
    assert.equal(data.data.districtCode, "cumilla");
    assert.ok(data.data.stages.length > 0);

    // Reject unknown crop
    const resErr = await fetch(`${baseUrl}/api/v1/crop-lifecycle/templates/unknown_crop`);
    assert.equal(resErr.status, 404);
  });

  await t.test("Create a farm for User A", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        farmName: "Rafiq's Mustard Field",
        location: {
          districtCode: "cumilla",
          upazila: "Burichang",
        },
        land: { area: 30, unit: "decimal" },
        crop: {
          cropCode: "mustard",
          variety: "BARI Sarisha-14",
          plantingDate: "2026-11-01",
        },
      }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    userAFarmId = data.data._id;
  });

  await t.test("GET /api/v1/farms/:id/lifecycle requires authentication (401)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}/lifecycle`);
    assert.equal(res.status, 401);
  });

  await t.test("GET /api/v1/farms/:id/lifecycle returns timeline for User A (200)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}/lifecycle`, {
      headers: {
        Authorization: `Bearer ${userAToken}`,
      },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.farmId, userAFarmId);
    assert.equal(data.data.crop.cropCode, "mustard");
    assert.ok(data.data.stages.length > 0);
    assert.ok(data.data.timelineOverview.asOfDate);
    assert.ok(data.data.provenance.sourcePublisher);
  });

  await t.test("IDOR Prevention: User B CANNOT view User A's farm lifecycle (404)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}/lifecycle`, {
      headers: {
        Authorization: `Bearer ${userBToken}`,
      },
    });
    assert.equal(res.status, 404);
  });

  await t.test("POST /api/v1/farms/:id/lifecycle/refresh updates currentStage on farm (200)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}/lifecycle/refresh`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userAToken}`,
      },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    // Verify DB sync
    const farmDoc = await Farm.findById(userAFarmId);
    assert.ok(farmDoc.crop.currentStage);
  });

  await t.test("IDOR Prevention: User B CANNOT refresh User A's farm lifecycle (404)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}/lifecycle/refresh`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userBToken}`,
      },
    });
    assert.equal(res.status, 404);
  });

  await t.test("Invalid ObjectId returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/invalid-id/lifecycle`, {
      headers: {
        Authorization: `Bearer ${userAToken}`,
      },
    });
    assert.equal(res.status, 400);
  });
});
