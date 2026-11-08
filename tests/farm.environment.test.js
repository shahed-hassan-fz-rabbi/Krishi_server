import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";

import "../src/config/env.config.js";
import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { Farm } from "../src/models/farm.model.js";
import {
  getFarmEnvironmentalIntelligence,
  clearEnvironmentCache,
} from "../src/services/farmenvironment.service.js";

let server;
let baseUrl;
let userAToken;
let userBToken;
let userAFarmId;
let userBFarmId;

before(async () => {
  const uri = process.env.MONGODB_URI;
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  // Clean test fixtures
  await User.deleteMany({ email: { $regex: /@farmenvtest\.org$/ } });
  await Farm.deleteMany({ farmName: { $regex: /^EnvTest/ } });

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
      name: "Farmer Env User A",
      email: "userA@farmenvtest.org",
      password: "password123",
      district: "cumilla",
    }),
  });
  const dataA = await regARes.json();
  userAToken = dataA.data.token;

  // Register User B
  const regBRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Farmer Env User B",
      email: "userB@farmenvtest.org",
      password: "password123",
      district: "chattogram",
    }),
  });
  const dataB = await regBRes.json();
  userBToken = dataB.data.token;

  // Create Farm for User A (Cumilla Boro Rice)
  const farmARes = await fetch(`${baseUrl}/api/v1/farms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userAToken}`,
    },
    body: JSON.stringify({
      farmName: "EnvTest Cumilla Boro Farm",
      location: {
        districtCode: "cumilla",
        upazila: "Burichang",
        village: "Kabilpur",
      },
      land: { area: 50, unit: "decimal", landType: "medium_high" },
      soil: { type: "loam", drainage: "good" },
      water: { irrigationAvailability: "available", waterSource: "deep_tubewell" },
      crop: {
        cropCode: "boro_rice",
        variety: "BRRI dhan89",
        cultivationMethod: "Transplanting",
        plantingDate: "2026-01-10",
      },
    }),
  });
  const farmAJson = await farmARes.json();
  userAFarmId = farmAJson.data._id;

  // Create Farm for User B (Chattogram Aman)
  const farmBRes = await fetch(`${baseUrl}/api/v1/farms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userBToken}`,
    },
    body: JSON.stringify({
      farmName: "EnvTest Chattogram Aman Farm",
      location: {
        districtCode: "chattogram",
        upazila: "Hathazari",
      },
      land: { area: 40, unit: "decimal", landType: "medium_high" },
      soil: { type: "silt", drainage: "good" },
      water: { irrigationAvailability: "available" },
      crop: {
        cropCode: "monsoon_aman",
        variety: "BRRI dhan49",
        plantingDate: "2026-07-15",
      },
    }),
  });
  const farmBJson = await farmBRes.json();
  userBFarmId = farmBJson.data._id;
});

after(async () => {
  await Farm.deleteMany({ farmName: { $regex: /^EnvTest/ } });
  await User.deleteMany({ email: { $regex: /@farmenvtest\.org$/ } });
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect();
});

test("Farm Environmental Intelligence Suite (Phase 9.4)", async (t) => {
  await t.test("Service: returns complete verified intelligence for Cumilla farm", async () => {
    clearEnvironmentCache();
    const farm = await Farm.findById(userAFarmId).lean();
    const intel = await getFarmEnvironmentalIntelligence(farm);

    assert.ok(intel);
    assert.equal(intel.farm.districtCode, "cumilla");
    assert.equal(intel.farm.districtName, "Cumilla");
    assert.equal(intel.locationResolution.type, "district_centroid_proxy");

    // NASA POWER Climate Context
    assert.ok(intel.rainfallAndClimate);
    assert.ok(["HISTORICAL", "SNAPSHOT"].includes(intel.rainfallAndClimate.provenance));
    assert.equal(intel.rainfallAndClimate.timeStandard, "LST");
    assert.ok(intel.rainfallAndClimate.monthlyNormals.length === 12);
    assert.ok(intel.rainfallAndClimate.annualSummary.annualRainfallMeanMm > 0);

    // NASA SMAP Surface Soil Moisture Context
    assert.ok(intel.soilMoisture);
    assert.ok(["HISTORICAL", "SNAPSHOT"].includes(intel.soilMoisture.provenance));
    assert.equal(intel.soilMoisture.unit, "m³/m³");
    assert.ok(typeof intel.soilMoisture.soilMoisture === "number");
    assert.ok(intel.soilMoisture.measurementDepth.includes("0-5 cm"));
    assert.ok(intel.soilMoisture.quality.classification);

    // NASA MODIS Vegetation Context
    assert.ok(intel.vegetation);
    assert.ok(["HISTORICAL", "SNAPSHOT"].includes(intel.vegetation.provenance));
    assert.ok(typeof intel.vegetation.ndvi === "number");
    assert.ok(intel.vegetation.spatialResolution.includes("250-meter"));
    assert.ok(intel.vegetation.quality.classification);

    // Deterministic Summary
    assert.ok(intel.summary);
    assert.ok(typeof intel.summary.en === "string" && intel.summary.en.includes("NASA POWER"));
    assert.ok(typeof intel.summary.bn === "string" && intel.summary.bn.includes("নাসা"));
    assert.equal(intel.summary.provenance, "DETERMINISTIC_SYNTHESIS");

    // Lifecycle Context
    assert.ok(intel.lifecycleContext);
    assert.ok(intel.lifecycleContext.stageCode);
    assert.ok(intel.lifecycleContext.waterRequirementMm >= 0);
    assert.ok(intel.lifecycleContext.highlights.length > 0);
  });

  await t.test("Service: handles unsupported district gracefully with UNAVAILABLE status", async () => {
    const mockFarm = {
      _id: new mongoose.Types.ObjectId(),
      name: "Out of Bounds Farm",
      location: { districtCode: "sylhet", district: "Sylhet" },
    };

    const intel = await getFarmEnvironmentalIntelligence(mockFarm);
    assert.equal(intel.status, "UNAVAILABLE");
    assert.match(intel.message, /outside the verified NASA environmental observation boundary/);
    assert.equal(intel.rainfallAndClimate, null);
    assert.equal(intel.soilMoisture, null);
  });

  await t.test("API: GET /api/v1/farms/:id/environment rejects unauthenticated request (401)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}/environment`);
    assert.equal(res.status, 401);
  });

  await t.test("API: GET /api/v1/farms/:id/environment rejects invalid ObjectId (400)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/invalid-object-id/environment`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 400);
  });

  await t.test("API: GET /api/v1/farms/:id/environment enforces IDOR ownership protection (404)", async () => {
    // User B tries to access User A's farm environment
    const res = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}/environment`, {
      headers: { Authorization: `Bearer ${userBToken}` },
    });
    assert.equal(res.status, 404);
  });

  await t.test("API: GET /api/v1/farms/:id/environment returns 200 with full intelligence for owner", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}/environment`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.farm.id, userAFarmId);
    assert.ok(json.data.rainfallAndClimate);
    assert.ok(json.data.soilMoisture);
    assert.ok(json.data.vegetation);
    assert.ok(json.data.summary.en);
    assert.ok(json.data.disclaimers.power);
    assert.ok(json.data.disclaimers.smap);
    assert.ok(json.data.disclaimers.modis);
  });

  await t.test("API: repeated call hits cache with CACHE provenance flag", async () => {
    const res = await fetch(`${baseUrl}/api/v1/farms/${userAFarmId}/environment`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.meta.cached, true);
    assert.equal(json.data.meta.cacheProvenance, "CACHE");
  });
});
