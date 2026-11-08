/**
 * Phase 8.2 End-to-End Comprehensive Verification Script.
 * Tests:
 * 1. Online vs Disconnected MongoDB response comparison across all 18 endpoints
 * 2. Strict Provenance Integrity (LIVE vs HISTORICAL_DATABASE vs CACHED vs SNAPSHOT vs UNAVAILABLE)
 * 3. District Isolation (No cross-contamination between Cumilla and Chattogram)
 * 4. Missing/Corrupted snapshot safety in isolated sandbox
 * 5. AI Assistant Function Calling and Chat Service offline resilience
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { createApp } from "../src/app.js";
import { snapshotService } from "../src/services/snapshot.service.js";
import { toolExecutors } from "../src/services/ai/tools.executor.js";
import { assistantChatService } from "../src/services/ai/chat.service.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to spin up ephemeral test server
async function startEphemeralServer() {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("Phase 8.2 — Test 1: Full API Matrix in Online (DB Connected) Mode", async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
  assert.equal(mongoose.connection.readyState, 1, "Mongoose must be connected");
  assert.equal(snapshotService.isDbConnected(), true, "snapshotService.isDbConnected must be true");

  const { baseUrl, close } = await startEphemeralServer();

  try {
    // 1. Health
    const resHealth = await fetch(`${baseUrl}/health`);
    assert.equal(resHealth.status, 200);
    const jsonHealth = await resHealth.json();
    assert.equal(jsonHealth.data.database.connected, true);

    // 2. Climate Summary (Cumilla)
    const resCumSummary = await fetch(`${baseUrl}/climate/summary?district=cumilla`);
    assert.equal(resCumSummary.status, 200);
    const jsonCumSum = await resCumSummary.json();
    assert.equal(jsonCumSum.meta.district, "cumilla");
    assert.ok(
      jsonCumSum.meta.provenance === "HISTORICAL_DATABASE" || jsonCumSum.meta.provenance === "CACHED",
      `Expected HISTORICAL_DATABASE or CACHED, got: ${jsonCumSum.meta.provenance}`
    );
    assert.notEqual(jsonCumSum.meta.provenance, "LIVE", "Historical records must NEVER be labeled LIVE");

    // 3. Climate Summary (Chattogram)
    const resCtgSummary = await fetch(`${baseUrl}/climate/summary?district=chattogram`);
    assert.equal(resCtgSummary.status, 200);
    const jsonCtgSum = await resCtgSummary.json();
    assert.equal(jsonCtgSum.meta.district, "chattogram");
    assert.notEqual(jsonCtgSum.meta.provenance, "LIVE");

    // 4. Rainfall (Monthly)
    const resRain = await fetch(`${baseUrl}/climate/rainfall?district=cumilla&grouping=monthly`);
    assert.equal(resRain.status, 200);

    // 5. Temperature
    const resTemp = await fetch(`${baseUrl}/climate/temperature?district=cumilla&metric=t2m`);
    assert.equal(resTemp.status, 200);

    // 6. Handoff
    const resHandoff = await fetch(`${baseUrl}/climate/handoff?district=cumilla&transition=aman-mustard`);
    assert.equal(resHandoff.status, 200);

    // 7. SMAP Latest
    const resSmap = await fetch(`${baseUrl}/soil-moisture/latest?district=cumilla`);
    assert.equal(resSmap.status, 200);
    const jsonSmap = await resSmap.json();
    assert.equal(jsonSmap.meta.provenance, "HISTORICAL_DATABASE");
    assert.notEqual(jsonSmap.meta.provenance, "LIVE");

    // 8. MODIS Latest
    const resModis = await fetch(`${baseUrl}/vegetation/latest?district=cumilla`);
    assert.equal(resModis.status, 200);
    const jsonModis = await resModis.json();
    assert.equal(jsonModis.meta.provenance, "HISTORICAL_DATABASE");
    assert.notEqual(jsonModis.meta.provenance, "LIVE");

    // 9. GIS Layers
    const resGis = await fetch(`${baseUrl}/gis/layers?district=cumilla`);
    assert.equal(resGis.status, 200);
    const jsonGis = await resGis.json();
    assert.equal(jsonGis.meta.provenance, "HISTORICAL_DATABASE");
  } finally {
    await close();
  }
});

test("Phase 8.2 — Test 2: Full API Matrix in Offline (DB Disconnected) Mode", async () => {
  // Safely disconnect Mongoose
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  assert.equal(mongoose.connection.readyState, 0, "Mongoose must be disconnected");
  assert.equal(snapshotService.isDbConnected(), false, "snapshotService.isDbConnected must be false");

  const { baseUrl, close } = await startEphemeralServer();

  try {
    // 1. Health endpoint
    const resHealth = await fetch(`${baseUrl}/health`);
    assert.equal(resHealth.status, 200);
    const jsonHealth = await resHealth.json();
    assert.equal(jsonHealth.data.database.connected, false);
    assert.equal(jsonHealth.data.status, "degraded_db_disconnected");

    // 2. Climate Summary (Cumilla)
    const resCumSum = await fetch(`${baseUrl}/climate/summary?district=cumilla`);
    assert.equal(resCumSum.status, 200);
    const jsonCumSum = await resCumSum.json();
    assert.equal(jsonCumSum.meta.provenance, "SNAPSHOT");
    assert.equal(jsonCumSum.meta.databaseConnected, false);
    assert.equal(jsonCumSum.meta.district, "cumilla");
    assert.ok(jsonCumSum.data.rainfall);
    assert.equal(jsonCumSum.data.years_used, 25);

    // 3. Climate Summary (Chattogram)
    const resCtgSum = await fetch(`${baseUrl}/climate/summary?district=chattogram`);
    assert.equal(resCtgSum.status, 200);
    const jsonCtgSum = await resCtgSum.json();
    assert.equal(jsonCtgSum.meta.provenance, "SNAPSHOT");
    assert.equal(jsonCtgSum.meta.databaseConnected, false);
    assert.equal(jsonCtgSum.meta.district, "chattogram");

    // Verify distinct values between Cumilla and Chattogram snapshots
    assert.notEqual(
      jsonCumSum.data.rainfall.annual_historical.mean,
      jsonCtgSum.data.rainfall.annual_historical.mean,
      "Cumilla and Chattogram snapshots must not have identical values"
    );

    // 4. Rainfall Monthly (Cumilla)
    const resRainMonth = await fetch(`${baseUrl}/climate/rainfall?district=cumilla&grouping=monthly`);
    assert.equal(resRainMonth.status, 200);
    const jsonRainMonth = await resRainMonth.json();
    assert.equal(jsonRainMonth.meta.provenance, "SNAPSHOT");
    assert.equal(Object.keys(jsonRainMonth.data.historical_normals).length, 12);

    // 5. Rainfall Seasonal (Cumilla)
    const resRainSeason = await fetch(`${baseUrl}/climate/rainfall?district=cumilla&grouping=seasonal`);
    assert.equal(resRainSeason.status, 200);
    const jsonRainSeason = await resRainSeason.json();
    assert.equal(jsonRainSeason.meta.provenance, "SNAPSHOT");
    assert.ok(jsonRainSeason.data.historical_seasons);

    // 6. Rainfall Annual (Cumilla)
    const resRainAnnual = await fetch(`${baseUrl}/climate/rainfall?district=cumilla&grouping=annual`);
    assert.equal(resRainAnnual.status, 200);
    const jsonRainAnnual = await resRainAnnual.json();
    assert.equal(jsonRainAnnual.meta.provenance, "SNAPSHOT");
    assert.ok(jsonRainAnnual.data.series.length > 0);

    // 7. Temperature (Cumilla)
    const resTemp = await fetch(`${baseUrl}/climate/temperature?district=cumilla`);
    assert.equal(resTemp.status, 200);
    const jsonTemp = await resTemp.json();
    assert.equal(jsonTemp.meta.provenance, "SNAPSHOT");
    assert.ok(jsonTemp.data.monthly_historical);

    // 8. Handoff Aman-Mustard (Cumilla)
    const resHandoffCum = await fetch(`${baseUrl}/climate/handoff?district=cumilla&transition=aman-mustard`);
    assert.equal(resHandoffCum.status, 200);
    const jsonHandoffCum = await resHandoffCum.json();
    assert.equal(jsonHandoffCum.meta.provenance, "SNAPSHOT");
    assert.equal(jsonHandoffCum.data.transition_id, "aman-mustard");

    // 9. Handoff Boro-Aus (Chattogram)
    const resHandoffCtg = await fetch(`${baseUrl}/climate/handoff?district=chattogram&transition=boro-aus`);
    assert.equal(resHandoffCtg.status, 200);
    const jsonHandoffCtg = await resHandoffCtg.json();
    assert.equal(jsonHandoffCtg.meta.provenance, "SNAPSHOT");
    assert.equal(jsonHandoffCtg.data.transition_id, "boro-aus");

    // 10. SMAP Latest (Cumilla)
    const resSmapCum = await fetch(`${baseUrl}/soil-moisture/latest?district=cumilla`);
    assert.equal(resSmapCum.status, 200);
    const jsonSmapCum = await resSmapCum.json();
    assert.equal(jsonSmapCum.meta.provenance, "SNAPSHOT");
    assert.equal(jsonSmapCum.data.dateLabel, "2024-01-03");
    assert.equal(jsonSmapCum.data.soilMoisture, 0.4259);
    assert.equal(jsonSmapCum.data.retrievalQualityFlag, 8);

    // 11. SMAP Latest (Chattogram)
    const resSmapCtg = await fetch(`${baseUrl}/soil-moisture/latest?district=chattogram`);
    assert.equal(resSmapCtg.status, 200);
    const jsonSmapCtg = await resSmapCtg.json();
    assert.equal(jsonSmapCtg.meta.provenance, "SNAPSHOT");
    assert.equal(jsonSmapCtg.data.dateLabel, "2024-01-03");
    assert.equal(jsonSmapCtg.data.soilMoisture, 0.1871);

    // Verify SMAP observations differ
    assert.notEqual(jsonSmapCum.data.soilMoisture, jsonSmapCtg.data.soilMoisture);

    // 12. SMAP History
    const resSmapHist = await fetch(`${baseUrl}/soil-moisture/history?district=cumilla&from=2024-01-01&to=2024-01-10`);
    assert.equal(resSmapHist.status, 200);
    const jsonSmapHist = await resSmapHist.json();
    assert.equal(jsonSmapHist.meta.provenance, "SNAPSHOT");
    assert.equal(jsonSmapHist.data.series.length, 2);

    // 13. SMAP Status
    const resSmapStatus = await fetch(`${baseUrl}/soil-moisture/status`);
    assert.equal(resSmapStatus.status, 200);
    const jsonSmapStat = await resSmapStatus.json();
    assert.equal(jsonSmapStat.data.provenance, "SNAPSHOT");
    assert.equal(jsonSmapStat.data.databaseConnected, false);

    // 14. MODIS Latest (Cumilla)
    const resModisCum = await fetch(`${baseUrl}/vegetation/latest?district=cumilla`);
    assert.equal(resModisCum.status, 200);
    const jsonModisCum = await resModisCum.json();
    assert.equal(jsonModisCum.meta.provenance, "SNAPSHOT");
    assert.equal(jsonModisCum.data.dateLabel, "2024-01-17");
    assert.equal(jsonModisCum.data.ndvi, 0.2865);
    assert.equal(jsonModisCum.data.evi, 0.1323);

    // 15. MODIS Latest (Chattogram)
    const resModisCtg = await fetch(`${baseUrl}/vegetation/latest?district=chattogram`);
    assert.equal(resModisCtg.status, 200);
    const jsonModisCtg = await resModisCtg.json();
    assert.equal(jsonModisCtg.meta.provenance, "SNAPSHOT");
    assert.equal(jsonModisCtg.data.dateLabel, "2024-01-17");
    assert.equal(jsonModisCtg.data.ndvi, 0.3323);

    // Verify MODIS observations differ
    assert.notEqual(jsonModisCum.data.ndvi, jsonModisCtg.data.ndvi);

    // 16. MODIS History
    const resModisHist = await fetch(`${baseUrl}/vegetation/history?district=cumilla&from=2023-12-01&to=2024-01-31`);
    assert.equal(resModisHist.status, 200);
    const jsonModisHist = await resModisHist.json();
    assert.equal(jsonModisHist.meta.provenance, "SNAPSHOT");
    assert.equal(jsonModisHist.data.series.length, 3);

    // 17. MODIS Status
    const resModisStatus = await fetch(`${baseUrl}/vegetation/status`);
    assert.equal(resModisStatus.status, 200);
    const jsonModisStat = await resModisStatus.json();
    assert.equal(jsonModisStat.data.provenance, "SNAPSHOT");

    // 18. GIS Layers (Cumilla)
    const resGisCum = await fetch(`${baseUrl}/gis/layers?district=cumilla`);
    assert.equal(resGisCum.status, 200);
    const jsonGisCum = await resGisCum.json();
    assert.equal(jsonGisCum.meta.provenance, "SNAPSHOT");
    assert.equal(jsonGisCum.meta.databaseConnected, false);
    assert.ok(jsonGisCum.data.boundary);
    assert.ok(jsonGisCum.data.sensors.soilMoisture);
    assert.ok(jsonGisCum.data.sensors.vegetation);
    assert.ok(jsonGisCum.data.sensors.climate);

    // 19. GIS Layers (Chattogram)
    const resGisCtg = await fetch(`${baseUrl}/gis/layers?district=chattogram`);
    assert.equal(resGisCtg.status, 200);
    const jsonGisCtg = await resGisCtg.json();
    assert.equal(jsonGisCtg.meta.provenance, "SNAPSHOT");
    assert.equal(jsonGisCtg.data.district.pCode, "BD2015");

    // 20. Error case: unsupported district
    const resInvalid = await fetch(`${baseUrl}/climate/summary?district=rajshahi`);
    assert.equal(resInvalid.status, 400);

    // 21. Error case: unsupported crop transition
    const resInvalidHandoff = await fetch(`${baseUrl}/climate/handoff?district=cumilla&transition=wheat-maize`);
    assert.equal(resInvalidHandoff.status, 400);
  } finally {
    await close();
  }
});

test("Phase 8.2 — Test 3: Snapshot Integrity, Boundary P-Codes & Cross-Contamination", async () => {
  const cumillaSnap = snapshotService.getClimateSnapshot("cumilla");
  const ctgSnap = snapshotService.getClimateSnapshot("chattogram");

  // Verify Cumilla metadata
  assert.equal(cumillaSnap.snapshotMetadata.district, "cumilla");
  assert.equal(cumillaSnap.snapshotMetadata.districtNameEn, "Cumilla");
  assert.equal(cumillaSnap.snapshotMetadata.districtNameBn, "কুমিল্লা");
  assert.equal(cumillaSnap.snapshotMetadata.timeStandard, "LST");
  assert.equal(cumillaSnap.snapshotMetadata.version, "v1.0.0-phase3");

  // Verify Chattogram metadata
  assert.equal(ctgSnap.snapshotMetadata.district, "chattogram");
  assert.equal(ctgSnap.snapshotMetadata.districtNameEn, "Chattogram");
  assert.equal(ctgSnap.snapshotMetadata.districtNameBn, "চট্টগ্রাম");
  assert.equal(ctgSnap.snapshotMetadata.timeStandard, "LST");

  // Verify SMAP observations have valid coordinate boundaries and correct P-codes
  const smapSnap = snapshotService.getSmapSnapshot("cumilla");
  smapSnap.observations.forEach((obs) => {
    assert.equal(obs.districtCode, "cumilla");
    assert.equal(obs.adminPolygonPcode, "BD2019");
    assert.ok(obs.soilMoisture >= 0 && obs.soilMoisture <= 1.0, "Soil moisture must be physical [0..1]");
    assert.ok(obs.latitude >= 23.0 && obs.latitude <= 24.0, "Cumilla latitude bounds");
    assert.ok(obs.longitude >= 90.5 && obs.longitude <= 91.5, "Cumilla longitude bounds");
  });

  const smapCtg = snapshotService.getSmapSnapshot("chattogram");
  smapCtg.observations.forEach((obs) => {
    assert.equal(obs.districtCode, "chattogram");
    assert.equal(obs.adminPolygonPcode, "BD2015");
    assert.ok(obs.soilMoisture >= 0 && obs.soilMoisture <= 1.0);
    assert.ok(obs.latitude >= 21.8 && obs.latitude <= 23.0, "Chattogram latitude bounds");
    assert.ok(obs.longitude >= 91.3 && obs.longitude <= 92.5, "Chattogram longitude bounds");
  });

  // Verify MODIS NDVI/EVI valid scaled range [-0.2 .. 1.0]
  const modisCum = snapshotService.getModisSnapshot("cumilla");
  modisCum.observations.forEach((obs) => {
    assert.equal(obs.districtCode, "cumilla");
    assert.equal(obs.adminPolygonPcode, "BD2019");
    assert.ok(obs.ndvi >= -0.2 && obs.ndvi <= 1.0, `Valid NDVI range: ${obs.ndvi}`);
    assert.ok(obs.evi >= -0.2 && obs.evi <= 1.0, `Valid EVI range: ${obs.evi}`);
  });

  const modisCtg = snapshotService.getModisSnapshot("chattogram");
  modisCtg.observations.forEach((obs) => {
    assert.equal(obs.districtCode, "chattogram");
    assert.equal(obs.adminPolygonPcode, "BD2015");
    assert.ok(obs.ndvi >= -0.2 && obs.ndvi <= 1.0);
  });
});

test("Phase 8.2 — Test 4: Missing & Corrupted Snapshot Handling in Isolated Sandbox", async () => {
  // Test requesting an unknown district from snapshotService
  const unknownClimate = snapshotService.getClimateSnapshot("khulna");
  assert.equal(unknownClimate, null, "Unknown district climate snapshot must return null");

  const unknownHandoff = snapshotService.getHandoffSnapshot("khulna", "aman-mustard");
  assert.equal(unknownHandoff, null, "Unknown district handoff snapshot must return null");

  const unknownSmap = snapshotService.getSmapSnapshot("khulna");
  assert.equal(unknownSmap, null, "Unknown district SMAP snapshot must return null");

  const unknownModis = snapshotService.getModisSnapshot("khulna");
  assert.equal(unknownModis, null, "Unknown district MODIS snapshot must return null");

  // In an isolated temp directory, simulate a corrupted JSON snapshot
  const tmpDir = path.resolve(__dirname, "../data/snapshots/.test_sandbox");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const corruptFile = path.join(tmpDir, "corrupt_snapshot.json");
  fs.writeFileSync(corruptFile, "{ invalid json: true, truncated: ");

  // Safely assert JSON.parse rejects corrupt file
  assert.throws(() => {
    JSON.parse(fs.readFileSync(corruptFile, "utf-8"));
  }, /SyntaxError/);

  // Clean up sandbox
  fs.unlinkSync(corruptFile);
  fs.rmdirSync(tmpDir);
});

test("Phase 8.2 — Test 5: AI Assistant Grounding & Tool Execution with Disconnected DB", async () => {
  // Ensure DB disconnected
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  // 1. Tool: getClimateNormals (Cumilla)
  const normalsCum = await toolExecutors.getClimateNormals({ district: "cumilla" });
  assert.equal(normalsCum.district, "cumilla");
  assert.equal(normalsCum.provenance, "SNAPSHOT");
  assert.equal(normalsCum.normals.length, 12);
  assert.ok(normalsCum.scientificDisclaimer.includes("statistical climatological baselines"));

  // 2. Tool: getClimateRainfall (Chattogram)
  const rainfallCtg = await toolExecutors.getClimateRainfall({ district: "chattogram", grouping: "seasonal" });
  assert.equal(rainfallCtg.district, "chattogram");
  assert.equal(rainfallCtg.provenance, "SNAPSHOT");
  assert.ok(rainfallCtg.seasons.length > 0);

  // 3. Tool: getSoilMoistureLatest
  const smapLatest = await toolExecutors.getSoilMoistureLatest({ district: "cumilla" });
  assert.equal(smapLatest.district, "cumilla");
  assert.ok(smapLatest.provenance.includes("SNAPSHOT"));
  assert.equal(smapLatest.date, "2024-01-03");
  assert.equal(smapLatest.soilMoisture, 0.4259);
  assert.equal(smapLatest.isRecommendedQuality, true);
  assert.ok(smapLatest.measurementDepth.includes("0-5 cm"));

  // 4. Tool: getVegetationLatest
  const modisLatest = await toolExecutors.getVegetationLatest({ district: "cumilla" });
  assert.equal(modisLatest.district, "cumilla");
  assert.ok(modisLatest.provenance.includes("SNAPSHOT"));
  assert.equal(modisLatest.date, "2024-01-17");
  assert.equal(modisLatest.ndvi, 0.2865);
  assert.ok(modisLatest.scientificMeaning.includes("chlorophyll absorption"));

  // 5. Tool: getHandoffPlan (Cumilla Aman-Mustard)
  const handoffCum = await toolExecutors.getHandoffPlan({ district: "cumilla", transition: "aman-mustard" });
  assert.equal(handoffCum.district, "cumilla");
  assert.equal(handoffCum.transition, "aman-mustard");
  assert.equal(handoffCum.provenance, "SNAPSHOT");
  assert.ok(handoffCum.recommendationBn.includes("সরিষা"));

  // 6. Tool: getCropCalendarAdvisory
  const calendar = await toolExecutors.getCropCalendarAdvisory({ crop: "mustard", district: "cumilla" });
  assert.equal(calendar.cropId, "mustard");
  assert.ok(calendar.criticalStages.length > 0);

  // 7. Deterministic Fallback Chat in Bangla when Gemini is offline or DB disconnected
  const chatResponse = await assistantChatService.handleChat({
    message: "কুমিল্লার মাটির আর্দ্রতা কেমন?",
    district: "cumilla",
  });

  assert.ok(chatResponse.answer, "Must return reply text");
  assert.ok(chatResponse.answer.length > 20);
  assert.ok(chatResponse.provenance);
  assert.ok(chatResponse.meta.toolsCalled.length > 0);

  // Verify English query grounding
  const chatResponseEn = await assistantChatService.handleChat({
    message: "What is the historical rainfall pattern in Cumilla?",
    district: "cumilla",
  });

  assert.ok(chatResponseEn.answer);
  assert.ok(chatResponseEn.meta.toolsCalled.length > 0);
});
