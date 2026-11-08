import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";

dotenv.config();

test("Crop Calendar API delivers verified BAMIS/BRRI phenology data", async () => {
  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1/crop-calendar`;

  try {
    // 1. GET /crops
    const resCrops = await fetch(`${baseUrl}/crops`);
    assert.equal(resCrops.status, 200);
    const jsonCrops = await resCrops.json();
    assert.equal(jsonCrops.success, true);
    assert.equal(jsonCrops.data.length, 4);
    const cropIds = jsonCrops.data.map((c) => c.cropId);
    assert.ok(cropIds.includes("monsoon_aman"));
    assert.ok(cropIds.includes("boro_rice"));
    assert.ok(cropIds.includes("aus_rice"));
    assert.ok(cropIds.includes("mustard"));

    // 2. GET /?district=cumilla&crop=monsoon_aman
    const resAmanCum = await fetch(`${baseUrl}?district=cumilla&crop=monsoon_aman`);
    assert.equal(resAmanCum.status, 200);
    const jsonAmanCum = await resAmanCum.json();
    assert.equal(jsonAmanCum.success, true);
    assert.equal(jsonAmanCum.data.length, 1);
    const calCum = jsonAmanCum.data[0].districtCalendar;
    assert.equal(calCum.totalDurationDays, 133);
    assert.equal(calCum.daeRegionId, 12);
    assert.ok(calCum.sourceDocumentUrl.includes("4332.pdf"));
    assert.equal(calCum.stages.length, 5);

    // 3. GET /?district=chattogram&crop=mustard
    const resMustardCtg = await fetch(`${baseUrl}?district=chattogram&crop=mustard`);
    assert.equal(resMustardCtg.status, 200);
    const jsonMustardCtg = await resMustardCtg.json();
    assert.equal(jsonMustardCtg.success, true);
    const calMustardCtg = jsonMustardCtg.data[0].districtCalendar;
    assert.equal(calMustardCtg.totalDurationDays, 90);
    assert.ok(calMustardCtg.sourceDocumentUrl.includes("11000.pdf"));

    // 4. GET / with invalid district
    const resInvalidDist = await fetch(`${baseUrl}?district=sylhet`);
    assert.equal(resInvalidDist.status, 400);

    // 5. GET /alignment?district=cumilla&crop=boro_rice
    const resAlign = await fetch(`${baseUrl}/alignment?district=cumilla&crop=boro_rice`);
    assert.equal(resAlign.status, 200);
    const jsonAlign = await resAlign.json();
    assert.equal(jsonAlign.success, true);
    assert.ok(jsonAlign.data.officialCalendar);
    assert.ok(jsonAlign.data.satelliteContext);
    assert.ok(jsonAlign.data.scientificDisclosure.includes("BAMIS"));
  } finally {
    server.close();
    await mongoose.disconnect();
  }
});
