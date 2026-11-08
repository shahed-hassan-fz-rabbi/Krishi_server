/**
 * Live API verification test for MODIS Vegetation endpoints.
 * Tests /api/v1/vegetation/status, /latest, and /history against live MongoDB Atlas.
 */

import http from "http";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";

dotenv.config();

async function runLiveTest() {
  console.log("=========================================================");
  console.log("     MODIS Live API Endpoint Verification Test           ");
  console.log("=========================================================");

  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);
  console.log("[db] Connected to MongoDB Atlas.");

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1/vegetation`;
  console.log(`[test server] Listening on port ${port}`);

  try {
    // 1. GET /status
    console.log("\n[1/6] Testing GET /api/v1/vegetation/status...");
    const resStatus = await fetch(`${baseUrl}/status`);
    const jsonStatus = await resStatus.json();
    console.log(`Status Code: ${resStatus.status}`);
    console.log(`Total Stored: ${jsonStatus.data.totalObservationsStored}`);
    console.log("Districts:", JSON.stringify(jsonStatus.data.districts));
    if (resStatus.status !== 200 || jsonStatus.data.totalObservationsStored !== 6) {
      throw new Error(`Status check failed! Expected 6, got ${jsonStatus.data.totalObservationsStored}`);
    }

    // 2. GET /latest?district=cumilla
    console.log("\n[2/6] Testing GET /api/v1/vegetation/latest?district=cumilla...");
    const resLatestCum = await fetch(`${baseUrl}/latest?district=cumilla`);
    const jsonLatestCum = await resLatestCum.json();
    console.log(`Status Code: ${resLatestCum.status}`);
    console.log(`Cumilla Latest: Date=${jsonLatestCum.data.dateLabel}, NDVI=${jsonLatestCum.data.ndvi}, EVI=${jsonLatestCum.data.evi}, QA=${jsonLatestCum.data.qualityClassification}`);
    if (resLatestCum.status !== 200 || jsonLatestCum.data.dateLabel !== "2024-01-17") {
      throw new Error("Cumilla latest check failed!");
    }

    // 3. GET /latest?district=chattogram
    console.log("\n[3/6] Testing GET /api/v1/vegetation/latest?district=chattogram...");
    const resLatestCtg = await fetch(`${baseUrl}/latest?district=chattogram`);
    const jsonLatestCtg = await resLatestCtg.json();
    console.log(`Status Code: ${resLatestCtg.status}`);
    console.log(`Chattogram Latest: Date=${jsonLatestCtg.data.dateLabel}, NDVI=${jsonLatestCtg.data.ndvi}, EVI=${jsonLatestCtg.data.evi}, QA=${jsonLatestCtg.data.qualityClassification}`);
    if (resLatestCtg.status !== 200 || jsonLatestCtg.data.dateLabel !== "2024-01-17") {
      throw new Error("Chattogram latest check failed!");
    }

    // 4. GET /history?district=cumilla&from=2023-12-01&to=2024-01-31 (all quality)
    console.log("\n[4/6] Testing GET /api/v1/vegetation/history?district=cumilla&from=2023-12-01&to=2024-01-31 (all)...");
    const resHistCumAll = await fetch(`${baseUrl}/history?district=cumilla&from=2023-12-01&to=2024-01-31`);
    const jsonHistCumAll = await resHistCumAll.json();
    console.log(`Status Code: ${resHistCumAll.status}`);
    console.log(`Total Records: ${jsonHistCumAll.data.summary.totalRecords}`);
    console.log(`Reliable Count: ${jsonHistCumAll.data.summary.reliableObservationsCount}`);
    console.log(`Marginal/Cloud Count: ${jsonHistCumAll.data.summary.marginalOrCloudCount}`);
    console.log(`Composite Avg NDVI: ${jsonHistCumAll.data.summary.compositeAverageNdvi}`);
    if (jsonHistCumAll.data.summary.totalRecords !== 3 || jsonHistCumAll.data.summary.reliableObservationsCount !== 1) {
      throw new Error("Cumilla history (all) summary mismatch!");
    }

    // 5. GET /history?district=cumilla&from=2024-01-01&to=2024-01-31&quality=good
    // On 2024-01-01 and 2024-01-17, Cumilla has marginal_data (aerosol high).
    // So filtering for quality=good in that window should return 503 DATA_UNAVAILABLE (clean zero leakage).
    console.log("\n[5/6] Testing GET /api/v1/vegetation/history?district=cumilla&from=2024-01-01&to=2024-01-31&quality=good (zero leakage test)...");
    const resHistCumGood = await fetch(`${baseUrl}/history?district=cumilla&from=2024-01-01&to=2024-01-31&quality=good`);
    const jsonHistCumGood = await resHistCumGood.json();
    console.log(`Status Code: ${resHistCumGood.status} (${jsonHistCumGood.error?.code})`);
    console.log(`Message: ${jsonHistCumGood.error?.message}`);
    if (resHistCumGood.status !== 503) {
      throw new Error("Zero-leakage test failed: expected 503 DATA_UNAVAILABLE when no good_data exists in range!");
    }

    // 6. GET /history?district=chattogram&from=2023-12-01&to=2024-01-31&quality=good
    console.log("\n[6/6] Testing GET /api/v1/vegetation/history?district=chattogram&from=2023-12-01&to=2024-01-31&quality=good...");
    const resHistCtgGood = await fetch(`${baseUrl}/history?district=chattogram&from=2023-12-01&to=2024-01-31&quality=good`);
    const jsonHistCtgGood = await resHistCtgGood.json();
    console.log(`Status Code: ${resHistCtgGood.status}`);
    console.log(`Total Records: ${jsonHistCtgGood.data.summary.totalRecords}`);
    console.log(`Reliable Average NDVI: ${jsonHistCtgGood.data.summary.reliableAverageNdvi}`);
    console.log(`Reliable Percentage: ${jsonHistCtgGood.data.summary.reliableQualityPercentage}%`);
    if (jsonHistCtgGood.data.summary.totalRecords !== 3 || jsonHistCtgGood.data.summary.reliableQualityPercentage !== 100) {
      throw new Error("Chattogram history (good) summary mismatch!");
    }

    console.log("\n=========================================================");
    console.log("  ALL LIVE VEGETATION API ENDPOINT TESTS PASSED (6/6)    ");
    console.log("=========================================================");
  } finally {
    server.close();
    await mongoose.disconnect();
    console.log("[db] Disconnected cleanly.");
  }
}

runLiveTest().catch((err) => {
  console.error("\n[fatal] Test failed:", err);
  process.exit(1);
});
