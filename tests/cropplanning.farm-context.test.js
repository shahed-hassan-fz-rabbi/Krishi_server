import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Farm } from "../src/models/farm.model.js";
import { getCropRecommendations } from "../src/controllers/cropplanning.controller.js";

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("crop planning saved-farm context uses authenticated owner scope", async (t) => {
  const originalFindOne = Farm.findOne;
  const authenticatedUserId = new mongoose.Types.ObjectId();
  const farmId = new mongoose.Types.ObjectId();

  await t.test("missing or foreign farm is rejected before provider calls", async () => {
    let capturedFilter;
    Farm.findOne = (filter) => {
      capturedFilter = filter;
      return { lean: async () => null };
    };
    const response = mockResponse();
    await getCropRecommendations({
      user: { _id: authenticatedUserId },
      body: { farmId: String(farmId), districtCode: "chattogram" },
    }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error.code, "FARM_NOT_FOUND");
    assert.ok(capturedFilter._id.equals(farmId));
    assert.ok(capturedFilter.userId.equals(authenticatedUserId));
  });

  await t.test("client-supplied owner identifiers cannot override session identity", async () => {
    const spoofedOwnerId = new mongoose.Types.ObjectId();
    let capturedFilter;
    Farm.findOne = (filter) => {
      capturedFilter = filter;
      return {
        lean: async () => ({
          _id: farmId,
          farmName: "Test farm",
          location: { districtCode: "unsupported", upazila: "Test" },
          land: { area: 12, unit: "decimal", landType: "medium_high" },
          soil: { type: "unknown", drainage: "unknown" },
          water: { irrigationAvailability: "limited" },
        }),
      };
    };
    const response = mockResponse();
    await getCropRecommendations({
      user: { _id: authenticatedUserId },
      body: { farmId: String(farmId), ownerId: String(spoofedOwnerId), districtCode: "cumilla" },
    }, response, (error) => { throw error; });
    assert.ok(capturedFilter.userId.equals(authenticatedUserId));
    assert.ok(!capturedFilter.userId.equals(spoofedOwnerId));
    assert.equal(response.statusCode, 400);
  });

  t.after(() => { Farm.findOne = originalFindOne; });
});
