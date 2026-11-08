/**
 * Krishi Mama — Phase 8.1 Offline Readiness & Snapshot Fallback Test Suite.
 * Validates that all intelligence APIs, GIS manifests, and AI assistant tools
 * continue functioning with scientific integrity when MongoDB is disconnected.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

import { createApp } from "../src/app.js";
import { snapshotService } from "../src/services/snapshot.service.js";
import { toolExecutors } from "../src/services/ai/tools.executor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const snapshotsDir = path.resolve(__dirname, "../data/snapshots");

test("Phase 8.1: Static Snapshot Files Integrity", async () => {
  const expectedFiles = [
    "cumilla_climate.json",
    "chattogram_climate.json",
    "cumilla_handoff.json",
    "chattogram_handoff.json",
    "smap_observations.json",
    "modis_observations.json",
  ];

  for (const file of expectedFiles) {
    const fullPath = path.join(snapshotsDir, file);
    assert.ok(fs.existsSync(fullPath), `Snapshot file must exist: ${file}`);
    const stat = fs.statSync(fullPath);
    assert.ok(stat.size > 1000, `Snapshot file ${file} should have meaningful content (> 1 KB)`);

    const parsed = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    assert.ok(parsed.snapshotMetadata, `Snapshot ${file} must contain snapshotMetadata`);
    assert.equal(parsed.snapshotMetadata.provenance, "SNAPSHOT");
    assert.ok(parsed.snapshotMetadata.generatedAt, "generatedAt timestamp present");
  }
});

test("Phase 8.1: Snapshot Service Load & Validation", async () => {
  // Climate snapshots
  const cumillaClimate = snapshotService.getClimateSnapshot("cumilla");
  assert.ok(cumillaClimate, "Cumilla climate snapshot loaded");
  assert.ok(cumillaClimate.data.rainfall.monthly_historical, "Monthly historical normals exist");
  assert.equal(Object.keys(cumillaClimate.data.rainfall.monthly_historical).length, 12);

  const ctgClimate = snapshotService.getClimateSnapshot("chattogram");
  assert.ok(ctgClimate, "Chattogram climate snapshot loaded");
  assert.equal(Object.keys(ctgClimate.data.rainfall.monthly_historical).length, 12);

  // Handoff snapshots
  const cumillaHandoff = snapshotService.getHandoffSnapshot("cumilla", "aman-mustard");
  assert.ok(cumillaHandoff, "Cumilla handoff snapshot loaded");
  assert.equal(cumillaHandoff.data.transition_id, "aman-mustard");
  assert.ok(cumillaHandoff.data.sowing_opportunity, "Sowing opportunity analysis present");

  // SMAP snapshot
  const smapSnap = snapshotService.getSmapSnapshot("cumilla");
  assert.ok(smapSnap, "SMAP snapshot loaded");
  assert.equal(smapSnap.observations.length, 2);
  assert.equal(smapSnap.latest.dateLabel, "2024-01-03");

  // MODIS snapshot
  const modisSnap = snapshotService.getModisSnapshot("cumilla");
  assert.ok(modisSnap, "MODIS snapshot loaded");
  assert.equal(modisSnap.observations.length, 3);
  assert.equal(modisSnap.latest.dateLabel, "2024-01-17");
});

test("Phase 8.1: Offline API Endpoints Fallback (Disconnected MongoDB)", async () => {
  // Ensure mongoose is disconnected for this test
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  assert.equal(mongoose.connection.readyState, 0, "MongoDB must be disconnected");
  assert.equal(snapshotService.isDbConnected(), false, "isDbConnected must report false");

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  try {
    // 1. Health endpoint reports database disconnected but API alive
    const resHealth = await fetch(`${baseUrl}/health`);
    assert.equal(resHealth.status, 200);
    const jsonHealth = await resHealth.json();
    assert.equal(jsonHealth.data.database.connected, false);
    assert.equal(jsonHealth.data.status, "degraded_db_disconnected");

    // 2. Climate Summary Fallback
    const resSummary = await fetch(`${baseUrl}/climate/summary?district=cumilla`);
    assert.equal(resSummary.status, 200);
    const jsonSummary = await resSummary.json();
    assert.equal(jsonSummary.success, true);
    assert.equal(jsonSummary.meta.provenance, "SNAPSHOT");
    assert.equal(jsonSummary.meta.databaseConnected, false);
    assert.ok(jsonSummary.data.rainfall, "Summary includes rainfall");
    assert.ok(jsonSummary.data.temperature, "Summary includes temperature");

    // 3. Climate Rainfall Fallback (Monthly)
    const resRainMonthly = await fetch(`${baseUrl}/climate/rainfall?district=cumilla&grouping=monthly`);
    assert.equal(resRainMonthly.status, 200);
    const jsonRainMonthly = await resRainMonthly.json();
    assert.equal(jsonRainMonthly.meta.provenance, "SNAPSHOT");
    assert.equal(Object.keys(jsonRainMonthly.data.historical_normals).length, 12);

    // 4. Climate Rainfall Fallback (Seasonal)
    const resRainSeasonal = await fetch(`${baseUrl}/climate/rainfall?district=cumilla&grouping=seasonal`);
    assert.equal(resRainSeasonal.status, 200);
    const jsonRainSeasonal = await resRainSeasonal.json();
    assert.equal(jsonRainSeasonal.meta.provenance, "SNAPSHOT");
    assert.ok(jsonRainSeasonal.data.historical_seasons);

    // 5. Climate Temperature Fallback
    const resTemp = await fetch(`${baseUrl}/climate/temperature?district=cumilla`);
    assert.equal(resTemp.status, 200);
    const jsonTemp = await resTemp.json();
    assert.equal(jsonTemp.meta.provenance, "SNAPSHOT");
    assert.ok(jsonTemp.data.monthly_historical);

    // 6. Handoff Plan Fallback
    const resHandoff = await fetch(`${baseUrl}/climate/handoff?district=cumilla&transition=aman-mustard`);
    assert.equal(resHandoff.status, 200);
    const jsonHandoff = await resHandoff.json();
    assert.equal(jsonHandoff.meta.provenance, "SNAPSHOT");
    assert.equal(jsonHandoff.data.transition_id, "aman-mustard");

    // 7. Soil Moisture Latest Fallback
    const resSmapLatest = await fetch(`${baseUrl}/soil-moisture/latest?district=cumilla`);
    assert.equal(resSmapLatest.status, 200);
    const jsonSmapLatest = await resSmapLatest.json();
    assert.equal(jsonSmapLatest.meta.provenance, "SNAPSHOT");
    assert.equal(jsonSmapLatest.data.soilMoisture, 0.4259);
    assert.equal(jsonSmapLatest.data.dateLabel, "2024-01-03");

    // 8. Soil Moisture History Fallback
    const resSmapHist = await fetch(`${baseUrl}/soil-moisture/history?district=cumilla&from=2024-01-01&to=2024-01-05`);
    assert.equal(resSmapHist.status, 200);
    const jsonSmapHist = await resSmapHist.json();
    assert.equal(jsonSmapHist.meta.provenance, "SNAPSHOT");
    assert.equal(jsonSmapHist.data.series.length, 2);

    // 9. Soil Moisture Status Fallback
    const resSmapStatus = await fetch(`${baseUrl}/soil-moisture/status`);
    assert.equal(resSmapStatus.status, 200);
    const jsonSmapStatus = await resSmapStatus.json();
    assert.equal(jsonSmapStatus.data.provenance, "SNAPSHOT");
    assert.equal(jsonSmapStatus.data.databaseConnected, false);

    // 10. Vegetation Latest Fallback
    const resModisLatest = await fetch(`${baseUrl}/vegetation/latest?district=cumilla`);
    assert.equal(resModisLatest.status, 200);
    const jsonModisLatest = await resModisLatest.json();
    assert.equal(jsonModisLatest.meta.provenance, "SNAPSHOT");
    assert.equal(jsonModisLatest.data.ndvi, 0.2865);
    assert.equal(jsonModisLatest.data.dateLabel, "2024-01-17");

    // 11. Vegetation History Fallback
    const resModisHist = await fetch(`${baseUrl}/vegetation/history?district=cumilla&from=2023-12-01&to=2024-02-01`);
    assert.equal(resModisHist.status, 200);
    const jsonModisHist = await resModisHist.json();
    assert.equal(jsonModisHist.meta.provenance, "SNAPSHOT");
    assert.equal(jsonModisHist.data.series.length, 3);

    // 12. Vegetation Status Fallback
    const resModisStatus = await fetch(`${baseUrl}/vegetation/status`);
    assert.equal(resModisStatus.status, 200);
    const jsonModisStatus = await resModisStatus.json();
    assert.equal(jsonModisStatus.data.provenance, "SNAPSHOT");
    assert.equal(jsonModisStatus.data.databaseConnected, false);

    // 13. GIS Layers Fallback
    const resGisLayers = await fetch(`${baseUrl}/gis/layers?district=cumilla`);
    assert.equal(resGisLayers.status, 200);
    const jsonGisLayers = await resGisLayers.json();
    assert.equal(jsonGisLayers.meta.provenance, "SNAPSHOT");
    assert.ok(jsonGisLayers.data.boundary, "Boundary GeoJSON feature present");
    assert.ok(jsonGisLayers.data.sensors.soilMoisture, "SMAP layer present from snapshot");
    assert.ok(jsonGisLayers.data.sensors.vegetation, "MODIS layer present from snapshot");

    // 14. Unsupported District Handled Properly
    const resInvalid = await fetch(`${baseUrl}/climate/summary?district=sylhet`);
    assert.equal(resInvalid.status, 400);
  } finally {
    server.close();
  }
});

test("Phase 8.1: AI Assistant Tools Offline Resilience", async () => {
  // Ensure DB disconnected
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  // 1. getClimateNormals
  const normals = await toolExecutors.getClimateNormals({ district: "cumilla" });
  assert.equal(normals.district, "cumilla");
  assert.equal(normals.provenance, "SNAPSHOT");
  assert.equal(normals.normals.length, 12);

  // 2. getClimateRainfall
  const rainfall = await toolExecutors.getClimateRainfall({ district: "cumilla", grouping: "seasonal" });
  assert.equal(rainfall.district, "cumilla");
  assert.equal(rainfall.provenance, "SNAPSHOT");
  assert.equal(rainfall.grouping, "seasonal");
  assert.ok(rainfall.seasons.length > 0);

  // 3. getSoilMoistureLatest
  const smap = await toolExecutors.getSoilMoistureLatest({ district: "cumilla" });
  assert.equal(smap.district, "cumilla");
  assert.ok(smap.provenance.includes("SNAPSHOT"));
  assert.equal(smap.soilMoisture, 0.4259);

  // 4. getVegetationLatest
  const modis = await toolExecutors.getVegetationLatest({ district: "cumilla" });
  assert.equal(modis.district, "cumilla");
  assert.ok(modis.provenance.includes("SNAPSHOT"));
  assert.equal(modis.ndvi, 0.2865);

  // 5. getHandoffPlan
  const handoff = await toolExecutors.getHandoffPlan({ district: "cumilla", transition: "aman-mustard" });
  assert.equal(handoff.district, "cumilla");
  assert.equal(handoff.transition, "aman-mustard");
  assert.equal(handoff.provenance, "SNAPSHOT");
  assert.ok(handoff.historicalOpportunityRate);

  // 6. getCropCalendarAdvisory (Local JSON, works 100% offline)
  const calendar = await toolExecutors.getCropCalendarAdvisory({ crop: "monsoon_aman", district: "cumilla" });
  assert.equal(calendar.cropId, "monsoon_aman");
  assert.ok(calendar.criticalStages.length > 0);

  // 7. getSupportedDistrictsAndCrops
  const metadata = await toolExecutors.getSupportedDistrictsAndCrops();
  assert.equal(metadata.districts.length, 2);
  assert.equal(metadata.crops.length, 4);
});
