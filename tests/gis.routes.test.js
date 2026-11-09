import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";

dotenv.config();

test("GIS API delivers verified BBS boundaries and observation layers", async () => {
  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1/gis`;

  try {
    // 1. GET /districts
    const resDistricts = await fetch(`${baseUrl}/districts`);
    assert.equal(resDistricts.status, 200);
    const jsonDist = await resDistricts.json();
    assert.equal(jsonDist.success, true);
    assert.equal(jsonDist.data.length, 2);
    const cumilla = jsonDist.data.find((d) => d.code === "cumilla");
    const ctg = jsonDist.data.find((d) => d.code === "chattogram");
    assert.equal(cumilla.pCode, "BD2019");
    assert.equal(ctg.pCode, "BD2015");

    // 2. GET /boundaries?district=cumilla
    const resCumBoundary = await fetch(`${baseUrl}/boundaries?district=cumilla`);
    assert.equal(resCumBoundary.status, 200);
    const jsonCumBnd = await resCumBoundary.json();
    assert.equal(jsonCumBnd.success, true);
    assert.equal(jsonCumBnd.data.type, "FeatureCollection");
    assert.equal(jsonCumBnd.data.features.length, 1);
    assert.equal(jsonCumBnd.data.features[0].properties.adm2_pcode, "BD2019");

    // 3. GET /boundaries?district=chattogram
    const resCtgBoundary = await fetch(`${baseUrl}/boundaries?district=chattogram`);
    assert.equal(resCtgBoundary.status, 200);
    const jsonCtgBnd = await resCtgBoundary.json();
    assert.equal(jsonCtgBnd.success, true);
    assert.equal(jsonCtgBnd.data.features[0].properties.adm2_pcode, "BD2015");

    // 4. GET /boundaries with invalid district
    const resInvalid = await fetch(`${baseUrl}/boundaries?district=sylhet`);
    assert.equal(resInvalid.status, 400);

    // 5. GET /layers?district=cumilla
    const resLayers = await fetch(`${baseUrl}/layers?district=cumilla`);
    assert.equal(resLayers.status, 200);
    const jsonLayers = await resLayers.json();
    assert.equal(jsonLayers.success, true);
    assert.ok(jsonLayers.data.boundary, "Boundary feature present");
    assert.ok(jsonLayers.data.sensors.climate, "Climate layer present");
    assert.ok(jsonLayers.data.sensors.soilMoisture, "SMAP layer present");
    assert.ok(jsonLayers.data.sensors.vegetation, "MODIS layer present");
    assert.ok(Number.isFinite(jsonLayers.data.sensors.soilMoisture.observation.soilMoisture));
    assert.ok(Number.isFinite(jsonLayers.data.sensors.vegetation.observation.ndvi));
    assert.ok(jsonLayers.data.sensors.precipitation);
    assert.equal(jsonLayers.data.sensors.precipitation.observation.dailySummary.validIntervals, 48);
    assert.equal(jsonLayers.data.sensors.precipitation.observation.dailySummary.completeness, "complete");
    assert.ok(Object.keys(jsonLayers.data.sensors.climate.observations).length > 0);
    assert.equal(jsonLayers.data.sensors.soilMoisture.footprintEnvelopes.gridPostingRadiusMeters, 4500);

    // 6. GET /layers?district=chattogram
    const resCtgLayers = await fetch(`${baseUrl}/layers?district=chattogram`);
    assert.equal(resCtgLayers.status, 200);
    const jsonCtgLayers = await resCtgLayers.json();
    assert.equal(jsonCtgLayers.success, true);
    assert.ok(Number.isFinite(jsonCtgLayers.data.sensors.soilMoisture.observation.soilMoisture));
    assert.ok(Number.isFinite(jsonCtgLayers.data.sensors.vegetation.observation.ndvi));
    assert.ok(jsonCtgLayers.data.sensors.precipitation);

    const gpmDaily = await fetch(baseUrl.replace("/gis", "/precipitation") + "/daily?district=cumilla&date=2024-01-07");
    assert.equal(gpmDaily.status, 200);
    const gpmJson = await gpmDaily.json();
    assert.equal(gpmJson.data.validIntervals, 48);
    assert.equal(gpmJson.data.completeness, "complete");
    assert.equal(gpmJson.data.totalPrecipitationMm, 0);

    const latestPower = await fetch(baseUrl.replace("/gis", "/climate") + "/latest?district=cumilla");
    assert.equal(latestPower.status, 200);
    const latestPowerJson = await latestPower.json();
    assert.ok(latestPowerJson.data.observations.PRECTOTCORR.observationDate);
    assert.ok(latestPowerJson.data.observations.PRECTOTCORR.ingestedAt);

    const sources = await fetch(baseUrl.replace("/gis", "/data-sources"));
    assert.equal(sources.status, 200);
    const sourcesJson = await sources.json();
    assert.equal(sourcesJson.data.length, 4);
    assert.ok(sourcesJson.data.every((dataset) => dataset.availability === "available"));
  } finally {
    server.close();
    await mongoose.disconnect();
  }
});
