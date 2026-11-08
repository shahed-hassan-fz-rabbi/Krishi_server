/**
 * Generate Verified Static Snapshots.
 * Reads actual verified MongoDB records and computes authoritative statistical snapshots
 * for offline fallback when MongoDB is unavailable.
 *
 * Strictly Read-Only with respect to MongoDB: Zero mutations to database collections.
 * Output directory: server/data/snapshots/
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

import { DISTRICTS } from "../config/climate.config.js";
import { SmapObservation } from "../models/smapobservation.model.js";
import { ModisObservation } from "../models/modisobservation.model.js";
import { NasaObservation } from "../models/nasaobservation.model.js";
import { analyzeDistrictClimate, analyzeHandoff } from "../services/climate/analysis.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOTS_DIR = path.resolve(__dirname, "../../data/snapshots");

async function generate() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGODB_URI in environment");

  console.log("[snapshots] Connecting to MongoDB to verify real records...");
  await mongoose.connect(uri);

  const generatedAt = new Date().toISOString();

  // 1. Generate Climate & Rainfall snapshots for both districts
  for (const d of DISTRICTS) {
    const district = d.code;
    console.log(`[snapshots] Generating climate analysis snapshot for ${district}...`);
    const recordCount = await NasaObservation.countDocuments({ districtCode: district });

    if (recordCount === 0) {
      console.warn(`[snapshots] Skipping climate snapshot for ${district}: 0 records in database.`);
      continue;
    }

    const climateAnalysis = await analyzeDistrictClimate({
      districtCode: district,
      parameter: null,
      startIso: "2001-01-01",
      endIso: "2025-12-31",
    });

    const climateSnapshot = {
      snapshotMetadata: {
        generatedAt,
        district,
        districtNameEn: d.nameEn,
        districtNameBn: d.nameBn,
        sourceDataset: "NASA POWER Daily Point (2001-2025)",
        sourceObservationDateRange: { start: "2001-01-01", end: "2025-12-31" },
        recordCount,
        provenance: "SNAPSHOT",
        version: "v1.0.0-phase3",
        timeStandard: "LST",
        limitations: "Static offline reference snapshot generated from verified MongoDB observations. Does not reflect real-time atmospheric dynamics.",
      },
      data: climateAnalysis.data,
      meta: climateAnalysis.meta,
    };

    const climateFilePath = path.join(SNAPSHOTS_DIR, `${district}_climate.json`);
    fs.writeFileSync(climateFilePath, JSON.stringify(climateSnapshot, null, 2), "utf-8");
    console.log(`[snapshots] Wrote ${climateFilePath} (${(fs.statSync(climateFilePath).size / 1024).toFixed(1)} KB)`);

    // 2. Generate Handoff snapshots for both transitions
    console.log(`[snapshots] Generating handoff snapshot for ${district}...`);
    const transitions = ["aman-mustard", "boro-aus"];
    const handoffData = {};

    for (const transition of transitions) {
      try {
        const handoffAnalysis = await analyzeHandoff({
          districtCode: district,
          cropTransition: transition,
        });
        handoffData[transition] = handoffAnalysis.data;
      } catch (err) {
        console.warn(`[snapshots] Could not calculate handoff for ${district} ${transition}: ${err.message}`);
      }
    }

    const handoffSnapshot = {
      snapshotMetadata: {
        generatedAt,
        district,
        districtNameEn: d.nameEn,
        districtNameBn: d.nameBn,
        sourceDataset: "NASA POWER Daily Point & Krishi Mama Handoff Window Planner",
        sourceObservationDateRange: { start: "2001-01-01", end: "2025-12-31" },
        recordCount,
        provenance: "SNAPSHOT",
        version: "v1.0.0-phase3",
        limitations: "Static offline reference snapshot for seasonal crop transition planning. Subject to microclimate variations.",
      },
      transitions: handoffData,
    };

    const handoffFilePath = path.join(SNAPSHOTS_DIR, `${district}_handoff.json`);
    fs.writeFileSync(handoffFilePath, JSON.stringify(handoffSnapshot, null, 2), "utf-8");
    console.log(`[snapshots] Wrote ${handoffFilePath} (${(fs.statSync(handoffFilePath).size / 1024).toFixed(1)} KB)`);
  }

  // 3. Generate SMAP snapshot
  console.log("[snapshots] Generating SMAP observations snapshot...");
  const smapDocs = await SmapObservation.find({}).sort({ dateLabel: -1, orbit: -1 }).lean();
  console.log(`[snapshots] Verified ${smapDocs.length} SMAP observations in database.`);

  const smapSnapshot = {
    snapshotMetadata: {
      generatedAt,
      sourceDataset: "NASA SMAP SPL3SMP_E V006 9km Radiometer Topsoil Moisture",
      recordCount: smapDocs.length,
      provenance: "SNAPSHOT",
      measurementDepth: "Top 0-5 cm soil layer only (does not measure root-zone moisture below 5 cm)",
      unit: "m^3/m^3",
      limitations: "Static offline reference snapshot. Represents physical radiometer topsoil measurements from 2024-01-02 to 2024-01-03.",
    },
    observations: smapDocs.map((doc) => {
      const clean = { ...doc };
      delete clean.__v;
      return clean;
    }),
  };

  const smapFilePath = path.join(SNAPSHOTS_DIR, "smap_observations.json");
  fs.writeFileSync(smapFilePath, JSON.stringify(smapSnapshot, null, 2), "utf-8");
  console.log(`[snapshots] Wrote ${smapFilePath} (${(fs.statSync(smapFilePath).size / 1024).toFixed(1)} KB)`);

  // 4. Generate MODIS snapshot
  console.log("[snapshots] Generating MODIS observations snapshot...");
  const modisDocs = await ModisObservation.find({}).sort({ dateLabel: -1 }).lean();
  console.log(`[snapshots] Verified ${modisDocs.length} MODIS observations in database.`);

  const modisSnapshot = {
    snapshotMetadata: {
      generatedAt,
      sourceDataset: "NASA Terra MODIS MOD13Q1.061 250m 16-Day Vegetation Indices",
      recordCount: modisDocs.length,
      provenance: "SNAPSHOT",
      scaleFactor: 0.0001,
      indices: ["NDVI", "EVI"],
      limitations: "Static offline reference snapshot. Represents canopy greenness/chlorophyll absorption, not disease diagnosis or final yield.",
    },
    observations: modisDocs.map((doc) => {
      const clean = { ...doc };
      delete clean.__v;
      return clean;
    }),
  };

  const modisFilePath = path.join(SNAPSHOTS_DIR, "modis_observations.json");
  fs.writeFileSync(modisFilePath, JSON.stringify(modisSnapshot, null, 2), "utf-8");
  console.log(`[snapshots] Wrote ${modisFilePath} (${(fs.statSync(modisFilePath).size / 1024).toFixed(1)} KB)`);

  await mongoose.disconnect();
  console.log("[snapshots] Finished generating all static snapshots cleanly.");
}

generate().catch((err) => {
  console.error("[snapshots] Fatal error generating snapshots:", err);
  process.exit(1);
});
