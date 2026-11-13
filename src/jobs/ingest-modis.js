/**
 * Controlled MODIS Ingestion Job.
 * Ingests the scientifically validated NASA MODIS observations
 * into the 'modisobservations' collection using idempotent upsert.
 *
 * STRICT SAFETY RULE:
 * Requires --confirm flag to execute MongoDB writes.
 * Without --confirm, runs purely in dry-run mode.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { ModisObservation } from "../models/modisobservation.model.js";
import { INGESTION_TARGET_DATABASE, assertIngestionTarget } from "../config/ingestionTarget.config.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Task-stamped parsed source — the exact provenance bound to the approved Stage-6
// manifest (AppEEARS task e0405649-2665-439d-87eb-a08608108fcd).
const parsedDataPath = path.resolve(__dirname, "../../data/modis/parsed_modis_observations_e0405649-2665-439d-87eb-a08608108fcd.json");

const isConfirmed = process.argv.includes("--confirm");

async function runIngestion() {
  console.log("=========================================================");
  console.log("     NASA MODIS (MOD13Q1.061) Controlled Ingestion      ");
  console.log("=========================================================");

  if (!fs.existsSync(parsedDataPath)) {
    console.error(`[error] Parsed data file not found: ${parsedDataPath}`);
    process.exit(1);
  }

  const observations = JSON.parse(fs.readFileSync(parsedDataPath, "utf-8"));
  console.log(`[info] Loaded ${observations.length} validated observations from disk.`);

  if (!isConfirmed) {
    console.log("\n[DRY RUN] Ingestion running in DRY-RUN mode (zero database writes).");
    console.log("To write to MongoDB, execute with: node src/jobs/ingest-modis.js --confirm\n");
    console.log("Preview of records to be upserted:");
    observations.forEach((obs, idx) => {
      console.log(
        `  [${idx + 1}] District: ${obs.districtCode.padEnd(10)} | Date: ${obs.dateLabel} (DOY ${String(obs.compositeDayOfYear).padStart(3, " ")}) | NDVI: ${obs.ndvi.toFixed(4)} | EVI: ${obs.evi.toFixed(4)} | QA: ${obs.qualityClassification} (${obs.isReliableQuality ? "Reliable" : "Not Reliable"})`
      );
    });
    console.log("\n[guard] Zero MongoDB writes executed.");
    return;
  }

  // Live confirmed ingestion
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("[error] MONGODB_URI not configured in server/.env");
    process.exit(1);
  }

  await mongoose.connect(uri, { dbName: INGESTION_TARGET_DATABASE });
  // Fail closed unless the live connection is the approved target database.
  assertIngestionTarget(mongoose.connection);
  console.log(`[db] Connected to MongoDB database (${mongoose.connection.name}).`);

  // Check initial state
  const initialSmapCount = await mongoose.connection.collection("smapobservations").countDocuments().catch(() => 0);
  console.log(`[pre-check] smapobservations count: ${initialSmapCount} (must remain untouched)`);

  let upsertedCount = 0;
  let modifiedCount = 0;
  let matchedCount = 0;

  for (const obs of observations) {
    const filter = {
      districtCode: obs.districtCode,
      dateLabel: obs.dateLabel,
    };

    const updateDoc = {
      ...obs,
      date: new Date(obs.date),
      ingestedAt: new Date(),
    };

    const res = await ModisObservation.updateOne(
      filter,
      { $set: updateDoc },
      { upsert: true }
    );

    if (res.upsertedCount > 0) upsertedCount += res.upsertedCount;
    if (res.modifiedCount > 0) modifiedCount += res.modifiedCount;
    if (res.matchedCount > 0) matchedCount += res.matchedCount;
  }

  const totalInDb = await ModisObservation.countDocuments();
  console.log(`\n[ingest pass 1] First Pass Execution Complete:`);
  console.log(`  -> Upserted (new): ${upsertedCount}`);
  console.log(`  -> Modified:       ${modifiedCount}`);
  console.log(`  -> Matched:        ${matchedCount}`);
  console.log(`  -> Total in DB:    ${totalInDb}`);

  // Second pass: Idempotency Verification
  let pass2Upserted = 0;
  let pass2Modified = 0;
  let pass2Matched = 0;

  for (const obs of observations) {
    const filter = {
      districtCode: obs.districtCode,
      dateLabel: obs.dateLabel,
    };

    const res = await ModisObservation.updateOne(
      filter,
      { $set: { ...obs, date: new Date(obs.date) } },
      { upsert: true }
    );

    if (res.upsertedCount > 0) pass2Upserted += res.upsertedCount;
    if (res.modifiedCount > 0) pass2Modified += res.modifiedCount;
    if (res.matchedCount > 0) pass2Matched += res.matchedCount;
  }

  const pass2Total = await ModisObservation.countDocuments();
  console.log(`\n[ingest pass 2] Idempotency Pass Complete:`);
  console.log(`  -> Upserted (new): ${pass2Upserted} (Expected: 0)`);
  console.log(`  -> Matched:        ${pass2Matched} (Expected: 6)`);
  console.log(`  -> Total in DB:    ${pass2Total} (Expected: 6)`);

  if (pass2Upserted !== 0 || pass2Total !== 6) {
    console.error("[error] Idempotency check failed: duplicate documents were created!");
    process.exit(1);
  }

  // Read back all 6 records from MongoDB and verify against source JSON
  console.log(`\n[verification] Reading back all 6 documents from MongoDB...`);
  const storedDocs = await ModisObservation.find({}).sort({ districtCode: 1, dateLabel: 1 }).lean();

  console.log(`Found ${storedDocs.length} documents in modisobservations:`);
  let allMatched = true;

  for (const doc of storedDocs) {
    const src = observations.find(
      (o) => o.districtCode === doc.districtCode && o.dateLabel === doc.dateLabel
    );

    if (!src) {
      console.error(`[mismatch] Stored doc ${doc.districtCode} ${doc.dateLabel} not found in source!`);
      allMatched = false;
      continue;
    }

    const ndviMatch = Math.abs(doc.ndvi - src.ndvi) < 1e-4;
    const eviMatch = Math.abs(doc.evi - src.evi) < 1e-4;
    const qaMatch = doc.pixelReliability === src.pixelReliability;
    const relMatch = doc.isReliableQuality === src.isReliableQuality;
    const doyMatch = doc.compositeDayOfYear === src.compositeDayOfYear;

    console.log(
      `  -> ID: ${doc._id} | ${doc.districtCode.padEnd(10)} | ${doc.dateLabel} (DOY ${String(doc.compositeDayOfYear).padStart(3, " ")}) | NDVI: ${doc.ndvi} | EVI: ${doc.evi} | QA: ${doc.qualityClassification} (${doc.isReliableQuality ? "Reliable" : "Not Reliable"}) | Checks: [NDVI: ${ndviMatch}, EVI: ${eviMatch}, QA: ${qaMatch}, Reliable: ${relMatch}, DOY: ${doyMatch}]`
    );

    if (!ndviMatch || !eviMatch || !qaMatch || !relMatch || !doyMatch) {
      allMatched = false;
    }
  }

  if (!allMatched) {
    console.error("[error] Document field comparison mismatch!");
    process.exit(1);
  }

  // Verify other collections untouched
  const finalSmapCount = await mongoose.connection.collection("smapobservations").countDocuments().catch(() => 0);
  console.log(`\n[guard check] smapobservations count: ${finalSmapCount} (Initial was ${initialSmapCount})`);
  if (finalSmapCount !== initialSmapCount) {
    console.error("[error] smapobservations was modified!");
    process.exit(1);
  }

  console.log("\n[success] All 6 MODIS observations verified in MongoDB Atlas!");
  await mongoose.disconnect();
  console.log("[db] Disconnected cleanly.");
}

runIngestion().catch((err) => {
  console.error("[fatal] Ingestion failed:", err);
  process.exit(1);
});
