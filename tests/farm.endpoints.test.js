import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";

import "../src/config/env.config.js";
import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { Farm } from "../src/models/farm.model.js";

let server;
let baseUrl;

before(async () => {
  const uri = process.env.MONGODB_URI;
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  // Clean test fixtures
  const testUsers = await User.find({ email: { $regex: /@farmtest\.org$/ } });
  await Farm.deleteMany({ userId: { $in: testUsers.map((u) => u._id) } });
  await User.deleteMany({ email: { $regex: /@farmtest\.org$/ } });

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
  const testUsers = await User.find({ email: { $regex: /@farmtest\.org$/ } });
  await Farm.deleteMany({ userId: { $in: testUsers.map((u) => u._id) } });
  await User.deleteMany({ email: { $regex: /@farmtest\.org$/ } });
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect();
});

test("My Farm Endpoints & Security Suite", async (t) => {
  let userAToken = "";
  let userBToken = "";
  let userAFarmId = "";

  await t.test("Register User A and User B", async () => {
    const resA = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Farmer Mokbul",
        email: "mokbul@farmtest.org",
        password: "Password123!",
      }),
    });
    assert.equal(resA.status, 201);
    const dataA = await resA.json();
    userAToken = dataA.data.token;
    assert.ok(userAToken);

    const resB = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Farmer Selim",
        email: "selim@farmtest.org",
        password: "Password123!",
      }),
    });
    assert.equal(resB.status, 201);
    const dataB = await resB.json();
    userBToken = dataB.data.token;
    assert.ok(userBToken);
  });

  await t.test("Reject farm endpoints without authentication (401)", async () => {
    const listRes = await fetch(`${baseUrl}/api/v1/farms`);
    assert.equal(listRes.status, 401);

    const createRes = await fetch(`${baseUrl}/api/v1/farms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ farmName: "My Test Farm" }),
    });
    assert.equal(createRes.status, 401);
  });

  await t.test("Reject farm creation with invalid payload (400)", async () => {
    // Missing required fields
    const res1 = await fetch(`${baseUrl}/api/v1/farms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        farmName: "Incomplete Farm",
      }),
    });
    assert.equal(res1.status, 400);
    const data1 = await res1.json();
    assert.equal(data1.success, false);
    assert.ok(data1.error.details.length > 0);

    // Unsupported district
    const res2 = await fetch(`${baseUrl}/api/v1/farms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        farmName: "Sylhet Farm",
        location: {
          districtCode: "sylhet",
          upazila: "Beanibazar",
        },
        land: { area: 50, unit: "decimal" },
        crop: { cropCode: "monsoon_aman", plantingDate: "2026-07-15" },
      }),
    });
    assert.equal(res2.status, 400);
    const data2 = await res2.json();
    assert.equal(data2.success, false);
    assert.ok(data2.error.details.some((e) => e.field === "location.districtCode"));

    // Invalid Upazila for Cumilla
    const res3 = await fetch(`${baseUrl}/api/v1/farms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        farmName: "Invalid Upazila Farm",
        location: {
          districtCode: "cumilla",
          upazila: "NonExistentUpazilaXYZ",
        },
        land: { area: 50, unit: "decimal" },
        crop: { cropCode: "monsoon_aman", plantingDate: "2026-07-15" },
      }),
    });
    assert.equal(res3.status, 400);
    const data3 = await res3.json();
    assert.ok(data3.error.details.some((e) => e.field === "location.upazila"));

    // Unsupported crop
    const res4 = await fetch(`${baseUrl}/api/v1/farms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        farmName: "Invalid Crop Farm",
        location: {
          districtCode: "cumilla",
          upazila: "Burichang",
        },
        land: { area: 50, unit: "decimal" },
        crop: { cropCode: "dragonfruit_super", plantingDate: "2026-07-15" },
      }),
    });
    assert.equal(res4.status, 400);
    const data4 = await res4.json();
    assert.ok(data4.error.details.some((e) => e.field === "crop.cropCode"));
  });

  await t.test("Create a valid farm for User A (201)", async () => {
    const payload = {
      farmName: "Mokbul's North Field",
      location: {
        districtCode: "cumilla",
        upazila: "Burichang",
        village: "Kashimpur",
      },
      land: {
        area: 45.5,
        unit: "decimal",
        landType: "medium_high",
      },
      soil: {
        type: "loam",
        drainage: "good",
      },
      water: {
        irrigationAvailability: "available",
        waterSource: "Shallow Tubewell",
      },
      crop: {
        cropCode: "monsoon_aman",
        variety: "BRRI dhan87",
        cultivationMethod: "Transplanting",
        plantingDate: "2026-07-20",
        notes: "Targeting high-yield aman before winter mustard rotation.",
      },
    };

    const res = await fetch(`${baseUrl}/api/v1/farms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.data._id);
    userAFarmId = data.data._id;
    assert.equal(data.data.farmName, "Mokbul's North Field");
    assert.equal(data.data.location.districtCode, "cumilla");
    assert.equal(data.data.location.upazila, "Burichang");
    assert.equal(data.data.crop.cropCode, "monsoon_aman");
    assert.equal(data.data.crop.cropName, "Transplanted Aman Rice");
  });

  await t.test("List farms for User A and verify summary aggregation", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms`, {
      headers: {
        Authorization: `Bearer ${userAToken}`,
      },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.farms.length, 1);
    assert.equal(data.data.farms[0]._id, userAFarmId);
    assert.equal(data.data.summary.totalFarms, 1);
    assert.equal(data.data.summary.totalAreaDecimal, 45.5);
    assert.ok(data.data.summary.activeCrops.includes("Transplanted Aman Rice"));
  });

  await t.test("User B lists farms and gets empty list (User Isolation)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms`, {
      headers: {
        Authorization: `Bearer ${userBToken}`,
      },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.farms.length, 0);
    assert.equal(data.data.summary.totalFarms, 0);
  });

  await t.test("Get farm details with official crop template and satellite context", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}`, {
      headers: {
        Authorization: `Bearer ${userAToken}`,
      },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data._id, userAFarmId);
    // Verified official crop template
    assert.ok(data.data.officialCropTemplate);
    assert.equal(data.data.officialCropTemplate.cropId, "monsoon_aman");
    assert.ok(data.data.officialCropTemplate.stages.length > 0);
    // Environmental satellite context
    assert.ok(data.data.environmentalContext);
    assert.equal(data.data.environmentalContext.districtCode, "cumilla");
  });

  await t.test("IDOR Prevention: User B cannot access User A's farm (404)", async () => {
    // User B tries to GET User A's farm
    const getRes = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}`, {
      headers: {
        Authorization: `Bearer ${userBToken}`,
      },
    });
    assert.equal(getRes.status, 404);

    // User B tries to PATCH User A's farm
    const patchRes = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({ farmName: "Hacked Farm Name" }),
    });
    assert.equal(patchRes.status, 404);

    // User B tries to DELETE User A's farm
    const delRes = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${userBToken}`,
      },
    });
    assert.equal(delRes.status, 404);

    // Verify farm name wasn't changed
    const verifyDoc = await Farm.findById(userAFarmId);
    assert.equal(verifyDoc.farmName, "Mokbul's North Field");
  });

  await t.test("Invalid ObjectId format returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/invalid-id-format`, {
      headers: {
        Authorization: `Bearer ${userAToken}`,
      },
    });
    assert.equal(res.status, 400);
  });

  await t.test("User A updates farm details (200)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        farmName: "Mokbul's Updated Main Plot",
        land: {
          area: 50,
          unit: "decimal",
        },
        notes: "Updated field notes after second weeding.",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.farmName, "Mokbul's Updated Main Plot");
    assert.equal(data.data.land.area, 50);
    assert.equal(data.data.notes, "Updated field notes after second weeding.");
  });

  await t.test("User A deletes farm (200)", async () => {
    const delRes = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${userAToken}`,
      },
    });

    assert.equal(delRes.status, 200);
    const data = await delRes.json();
    assert.equal(data.success, true);

    // Confirm it is gone
    const getRes = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}`, {
      headers: {
        Authorization: `Bearer ${userAToken}`,
      },
    });
    assert.equal(getRes.status, 404);

    // Confirm list is now empty
    const listRes = await fetch(`${baseUrl}/api/v1/farms`, {
      headers: {
        Authorization: `Bearer ${userAToken}`,
      },
    });
    const listData = await listRes.json();
    assert.equal(listData.data.farms.length, 0);
    assert.equal(listData.data.summary.totalFarms, 0);
  });
});
