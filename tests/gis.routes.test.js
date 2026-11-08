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
    assert.equal(jsonLayers.data.sensors.soilMoisture.observation.soilMoisture, 0.4259);
    assert.equal(jsonLayers.data.sensors.vegetation.observation.ndvi, 0.2865);
    assert.equal(jsonLayers.data.sensors.soilMoisture.footprintEnvelopes.gridPostingRadiusMeters, 4500);

    // 6. GET /layers?district=chattogram
    const resCtgLayers = await fetch(`${baseUrl}/layers?district=chattogram`);
    assert.equal(resCtgLayers.status, 200);
    const jsonCtgLayers = await resCtgLayers.json();
    assert.equal(jsonCtgLayers.success, true);
    assert.equal(jsonCtgLayers.data.sensors.soilMoisture.observation.soilMoisture, 0.1871);
    assert.equal(jsonCtgLayers.data.sensors.vegetation.observation.ndvi, 0.3323);
  } finally {
    server.close();
    await mongoose.disconnect();
  }
});
