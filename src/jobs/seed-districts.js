/**
 * Milestone 1 seed job — districts (exact configured coordinates) + POWER
 * provenance record. Idempotent; safe to re-run.
 *
 * Usage: npm run seed:districts
 * Output: boolean-style status lines; secrets never read or printed.
 */
import "../config/env.config.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { District } from "../models/district.model.js";
import { DISTRICTS } from "../config/climate.config.js";
import { ensurePowerDatasetProvenance } from "../services/nasa/dataset.registry.js";

export async function seedDistricts() {
  const results = [];
  for (const d of DISTRICTS) {
    const previous = await District.findOne({ code: d.code });
    if (previous) {
      // Exact coordinates are authoritative: update but verify no silent drift.
      const drifted =
        previous.latitude !== d.latitude || previous.longitude !== d.longitude;
      await District.updateOne(
        { code: d.code },
        {
          $set: {
            nameEn: d.nameEn,
            nameBn: d.nameBn,
            latitude: d.latitude,
            longitude: d.longitude,
            isDefault: d.isDefault,
            enabled: d.enabled,
          },
        }
      );
      results.push({ code: d.code, action: "updated", coordinateDriftDetected: drifted });
    } else {
      await District.create({
        code: d.code,
        nameEn: d.nameEn,
        nameBn: d.nameBn,
        latitude: d.latitude,
        longitude: d.longitude,
        isDefault: d.isDefault,
        enabled: d.enabled,
      });
      results.push({ code: d.code, action: "created", coordinateDriftDetected: false });
    }
  }
  return results;
}

async function main() {
  const connection = await connectDatabase();
  if (!connection.connected) {
    console.log("Seed status: FALSE (database unavailable)");
    await disconnectDatabase();
    process.exitCode = 1;
    return;
  }

  try {
    const districtResults = await seedDistricts();
    for (const r of districtResults) {
      console.log(
        `district ${r.code}: ${r.action}` +
          (r.coordinateDriftDetected ? " (coordinate drift corrected to exact configured values)" : "")
      );
    }
    const dataset = await ensurePowerDatasetProvenance();
    console.log(
      `provenance: ensured (${dataset.datasetKey}, fillValue=${dataset.fillValue}, timeStandard=${dataset.timeStandard})`
    );
    console.log("Seed status: TRUE");
  } catch (error) {
    console.error(`Seed status: FALSE (${error.message})`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

// Only run when executed directly (not under test import).
if (process.argv[1] && process.argv[1].endsWith("seed-districts.js")) {
  main();
}
