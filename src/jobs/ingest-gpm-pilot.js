/** Ingests exactly one validated, already-downloaded GPM IMERG V07 granule. */
import dotenv from "dotenv";
dotenv.config();

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import mongoose from "mongoose";
import { GPM } from "../config/gpm.config.js";
import { DISTRICTS } from "../config/climate.config.js";
import { GpmObservation } from "../models/gpmobservation.model.js";
import { validateGpmObservation } from "../services/nasa/gpm.validation.js";

const execFileAsync = promisify(execFile);
const rawPath = path.resolve("data/gpm/raw/3B-HHR.MS.MRG.3IMERG.20240101-S000000-E002959.0000.V07B.HDF5");

function haversineKm(aLat, aLon, bLat, bLon) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  const py = process.env.PYTHON || "python";
  const { stdout } = await execFileAsync(py, ["science/gpm_parser.py", rawPath], { maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (parsed.observations.length !== 2) throw new Error("Pilot parser must return exactly two district cells");
  const districts = new Map(DISTRICTS.map(d => [d.code, d]));
  const runId = `gpm-pilot-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

  for (const item of parsed.observations) {
    const check = validateGpmObservation(item);
    if (!check.valid) throw new Error(`GPM validation failed for ${item.districtCode}: ${check.reason}`);
    if (!districts.has(item.districtCode)) throw new Error(`Unexpected pilot district ${item.districtCode}`);
    item.geodesicDistanceKm = haversineKm(item.targetReferenceLat, item.targetReferenceLon, item.latitude, item.longitude);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
  try {
    await GpmObservation.init(); // ensure unique idempotency index exists before writes
    const ops = parsed.observations.map(item => {
      const doc = {
        ...item,
        intervalStartUtc: new Date(item.intervalStartUtc),
        intervalEndUtc: new Date(item.intervalEndUtc),
        unit: GPM.precipitationUnit,
        datasetKey: GPM.datasetKey,
        product: GPM.product,
        runType: GPM.runType,
        productVersion: GPM.granuleVersion,
        granuleId: parsed.fileName,
        ingestionRunId: runId,
        provenance: {
          provider: GPM.provider,
          collectionConceptId: GPM.collectionConceptId,
          doi: GPM.doi,
          algorithmVersion: parsed.algorithmVersion,
          timeStandard: "UTC",
        },
      };
      return { updateOne: { filter: { districtCode: doc.districtCode, granuleId: doc.granuleId }, update: { $setOnInsert: doc }, upsert: true } };
    });
    const result = await GpmObservation.bulkWrite(ops, { ordered: true });
    console.log(JSON.stringify({
      runId,
      datasetKey: GPM.datasetKey,
      runType: GPM.runType,
      version: GPM.granuleVersion,
      granuleId: parsed.fileName,
      timeStartUtc: parsed.timeStartUtc,
      timeEndUtc: parsed.timeEndUtc,
      upsertedCount: result.upsertedCount,
      matchedCount: result.matchedCount,
      districts: parsed.observations.map(o => o.districtCode),
    }));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error(`GPM pilot failed: ${error.message}`);
  process.exitCode = 1;
});
