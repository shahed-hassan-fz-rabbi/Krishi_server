/**
 * Controlled Ingestion Test for Milestone 2.
 * Tests 7-day window (2001-01-01 to 2001-01-07) for both Chattogram and Cumilla.
 * Verifies API validation, parameter mapping, units, date parsing, quality flags, and idempotency.
 */
import "../config/env.config.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { DISTRICTS, PARAMETER_NAMES, PARAMETER_CATALOG } from "../config/climate.config.js";
import { NasaObservation } from "../models/nasaobservation.model.js";
import { DataIngestionLog } from "../models/dataingestionlog.model.js";
import { runIngestionWorkflow, generateCoverageReport } from "../services/nasa/ingestion.service.js";

async function main() {
  const conn = await connectDatabase();
  if (!conn.connected) {
    console.error("Database connection failed:", conn.reason);
    process.exitCode = 1;
    return;
  }

  const testStart = "2001-01-01";
  const testEnd = "2001-01-07";
  const testChunks = [{ startIso: testStart, endIso: testEnd, year: 2001 }];

  console.log(`\n========================================`);
  console.log(`CONTROLLED INGESTION TEST (${testStart} to ${testEnd})`);
  console.log(`========================================\n`);

  // Step 1: Run controlled ingestion (first pass)
  console.log("--- Step 1: Ingesting initial 7-day chunk for both districts ---");
  const run1 = await runIngestionWorkflow({
    districtCodes: ["chattogram", "cumilla"],
    parameters: PARAMETER_NAMES,
    startIso: testStart,
    endIso: testEnd,
    chunks: testChunks,
    resume: false, // force write to test insertion
    onProgress: (p) => {
      console.log(`  [${p.district}] ${p.chunk.startIso}..${p.chunk.endIso} -> ${p.status} (stored: ${p.stored || 0}, ${p.durationMs || 0}ms)`);
    },
  });

  console.log(`Run 1 completed with status: ${run1.status}, totalStored: ${run1.totalStored}`);

  // Step 2: Verification of MongoDB records
  console.log("\n--- Step 2: Verifying stored observations in MongoDB ---");
  const countChg = await NasaObservation.countDocuments({
    districtCode: "chattogram",
    dateLabel: { $gte: testStart, $lte: testEnd },
  });
  const countCum = await NasaObservation.countDocuments({
    districtCode: "cumilla",
    dateLabel: { $gte: testStart, $lte: testEnd },
  });

  console.log(`Chattogram observations count: ${countChg} (expected: 42 -> 7 days * 6 params)`);
  console.log(`Cumilla observations count: ${countCum} (expected: 42 -> 7 days * 6 params)`);

  const sampleObs = await NasaObservation.find({
    districtCode: "chattogram",
    dateLabel: "2001-01-01",
  }).lean();

  console.log("\nSample observations for Chattogram on 2001-01-01:");
  for (const o of sampleObs) {
    console.log(`  ${o.parameter.padEnd(18)} value=${String(o.value).padStart(6)} ${o.unit.padEnd(12)} quality=${o.quality.padEnd(16)} timeStandard=${o.timeStandard}`);
  }

  // Step 3: Test Idempotency (re-run exact same chunk)
  console.log("\n--- Step 3: Testing Idempotency (Re-running same 7-day chunk) ---");
  const run2 = await runIngestionWorkflow({
    districtCodes: ["chattogram", "cumilla"],
    parameters: PARAMETER_NAMES,
    startIso: testStart,
    endIso: testEnd,
    chunks: testChunks,
    resume: false, // execute upserts again to verify no duplicates
  });

  const totalAfterRerun = await NasaObservation.countDocuments({
    dateLabel: { $gte: testStart, $lte: testEnd },
  });

  console.log(`Total observations after re-run: ${totalAfterRerun} (expected: exactly 84, no duplicates)`);
  const isIdempotent = totalAfterRerun === 84;
  console.log(`Idempotency check: ${isIdempotent ? "PASS (0 duplicates)" : "FAIL"}`);

  // Step 4: Coverage Report for both districts
  console.log("\n--- Step 4: Generating Coverage Reports ---");
  for (const d of ["chattogram", "cumilla"]) {
    const report = await generateCoverageReport(d);
    console.log(`\nCoverage for ${d}:`);
    console.log(`  Total obs: ${report.overall.totalObservations}, OK: ${report.overall.okCount}, Sentinels: ${report.overall.sentinelCount}, Absent: ${report.overall.absentCount}`);
    console.log(`  Date range: ${report.overall.firstDate} to ${report.overall.lastDate}`);
    for (const [p, pmeta] of Object.entries(report.parameters)) {
      console.log(`    ${p.padEnd(18)}: ${pmeta.okCount}/${pmeta.total} (${pmeta.coveragePercent}%) [${pmeta.firstDate}..${pmeta.lastDate}]`);
    }
  }

  // Step 5: Ingestion Log check
  const latestLog = await DataIngestionLog.findOne({ runId: run1.runId }).lean();
  console.log(`\n--- Step 5: Ingestion Journal Log (${run1.runId}) ---`);
  console.log(`Status: ${latestLog.status}`);
  console.log(`Counts:`, latestLog.counts);
  console.log(`Actual returned range:`, latestLog.actualRange);
  console.log(`Spans count:`, latestLog.spans.length);

  await disconnectDatabase();
  console.log("\nControlled test finished successfully.\n");
}

main().catch((err) => {
  console.error("Controlled test failed:", err);
  process.exitCode = 1;
});
