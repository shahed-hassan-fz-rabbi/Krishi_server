import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";

import "../src/config/env.config.js";
import { createApp } from "../src/app.js";
import {
  evaluateCropEligibility,
  getPlanningSatelliteContext,
  generatePlanningExplanation,
} from "../src/services/cropplanning.service.js";

let server;
let baseUrl;

before(async () => {
  const uri = process.env.MONGODB_URI;
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
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
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect();
});

test("Crop Planning & Recommendation Engine Suite", async (t) => {
  await t.test("Service: evaluateCropEligibility returns crops for Cumilla", () => {
    const res = evaluateCropEligibility({
      districtCode: "cumilla",
      landType: "medium_high",
      irrigationAvailability: "available",
    });

    assert.equal(res.isValid, true);
    assert.equal(res.crops.length, 4);
    const codes = res.crops.map((c) => c.cropCode);
    assert.ok(codes.includes("boro_rice"));
    assert.ok(codes.includes("monsoon_aman"));
    assert.ok(codes.includes("mustard"));
    assert.ok(codes.includes("aus_rice"));

    // Check suitability statuses
    const boro = res.crops.find((c) => c.cropCode === "boro_rice");
    assert.equal(boro.suitability, "supported");
    assert.ok(boro.waterRequirementMmTotal > 1000);
    assert.ok(Array.isArray(boro.recommendedVarieties));
    assert.ok(boro.recommendedVarieties.length > 0);
  });

  await t.test("Service: evaluateCropEligibility rejects unsupported district", () => {
    const res = evaluateCropEligibility({
      districtCode: "bogura",
    });

    assert.equal(res.isValid, false);
    assert.match(res.error, /not currently supported/);
  });

  await t.test("Service: constraints downgrade Boro when irrigation is unavailable", () => {
    const res = evaluateCropEligibility({
      districtCode: "cumilla",
      landType: "medium_high",
      irrigationAvailability: "unavailable",
    });

    assert.equal(res.isValid, true);
    const boro = res.crops.find((c) => c.cropCode === "boro_rice");
    assert.equal(boro.suitability, "potential");
    assert.ok(
      boro.constraints.some((c) => c.includes("High water deficit") || c.includes("irrigation"))
    );
  });

  await t.test("Service: constraints flag Aman on low land for submergence", () => {
    const res = evaluateCropEligibility({
      districtCode: "chattogram",
      landType: "low",
      irrigationAvailability: "available",
    });

    assert.equal(res.isValid, true);
    const aman = res.crops.find((c) => c.cropCode === "monsoon_aman");
    assert.ok(
      aman.constraints.some((c) => c.includes("Submergence risk") || c.includes("BRRI dhan51"))
    );
  });

  await t.test("Service: season preference prioritization", () => {
    const res = evaluateCropEligibility({
      districtCode: "cumilla",
      seasonPreference: "Rabi",
    });

    assert.equal(res.isValid, true);
    // Rabi crops should have suitability preserved/prioritized
    const mustard = res.crops.find((c) => c.cropCode === "mustard");
    const boro = res.crops.find((c) => c.cropCode === "boro_rice");
    assert.equal(mustard.suitability, "supported");
    assert.equal(boro.suitability, "supported");

    // Kharif crops should note non-preferred season
    const aman = res.crops.find((c) => c.cropCode === "monsoon_aman");
    assert.equal(aman.suitability, "potential");
    assert.ok(aman.constraints.some((c) => c.includes("Rabi")));
  });

  await t.test("Service: getPlanningSatelliteContext returns SMAP and MODIS", async () => {
    const context = await getPlanningSatelliteContext("cumilla");
    assert.ok(context);
    assert.equal(context.districtCode, "cumilla");
    assert.ok(context.smap);
    assert.ok(context.modis);
    assert.ok(context.smap.soilMoistureM3M3 !== undefined);
    assert.ok(context.modis.ndviMean !== undefined);
  });

  await t.test("Service: generatePlanningExplanation generates deterministic or AI text", async () => {
    const eligibility = evaluateCropEligibility({
      districtCode: "cumilla",
      landType: "medium_high",
      irrigationAvailability: "available",
    });
    const satelliteContext = await getPlanningSatelliteContext("cumilla");

    const explanation = await generatePlanningExplanation({
      districtCode: "cumilla",
      upazila: "Debidwar",
      land: { area: 50, unit: "decimal", landType: "medium_high" },
      water: { irrigationAvailability: "available" },
      preferences: {},
      eligibleCrops: eligibility.crops,
      satelliteContext,
      language: "bn",
    });

    assert.ok(typeof explanation === "string");
    assert.ok(explanation.length > 50);
  });

  await t.test("API: POST /api/v1/crop-planning/recommendations returns 400 on missing district", async () => {
    const res = await fetch(`${baseUrl}/api/v1/crop-planning/recommendations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.match(json.error?.message || "", /District code is required/);
  });

  await t.test("API: POST /api/v1/crop-planning/recommendations returns 200 with full payload", async () => {
    const res = await fetch(`${baseUrl}/api/v1/crop-planning/recommendations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        districtCode: "cumilla",
        upazila: "Chandina",
        land: {
          area: 40,
          unit: "decimal",
          landType: "medium_high",
          soilType: "clay_loam",
          drainage: "good",
        },
        water: {
          irrigationAvailability: "available",
          waterSource: "deep_tubewell",
        },
        preferences: {
          seasonPreference: "Rabi",
        },
        language: "en",
      }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.crops);
    assert.equal(json.data.crops.length, 4);
    assert.ok(json.data.satelliteContext);
    assert.ok(json.data.aiExplanation);
    assert.ok(json.data.citations);
    assert.equal(json.data.query.districtCode, "cumilla");
  });
});
