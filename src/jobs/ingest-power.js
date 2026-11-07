/**
 * Full Historical NASA POWER Ingestion CLI Job.
 *
 * Usage:
 *   npm run ingest:power
 *   node src/jobs/ingest-power.js --district chattogram --start 2001-01-01 --end 2025-12-31
 *   node src/jobs/ingest-power.js --no-resume
 */
import "../config/env.config.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { DISTRICTS, PARAMETER_NAMES, TARGET_RANGE } from "../config/climate.config.js";
import { generateCoverageReport, runIngestionWorkflow } from "../services/nasa/ingestion.service.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    districtCodes: DISTRICTS.map((d) => d.code),
    startIso: TARGET_RANGE.start,
    endIso: TARGET_RANGE.end,
    resume: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--district" && args[i + 1]) {
      options.districtCodes = [args[i + 1]];
      i += 1;
    } else if (args[i] === "--start" && args[i + 1]) {
      options.startIso = args[i + 1];
      i += 1;
    } else if (args[i] === "--end" && args[i + 1]) {
      options.endIso = args[i + 1];
      i += 1;
    } else if (args[i] === "--no-resume") {
      options.resume = false;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();
  console.log("==================================================");
  console.log("NASA POWER Historical Ingestion Job");
  console.log(`Districts   : ${options.districtCodes.join(", ")}`);
  console.log(`Target Range: ${options.startIso} to ${options.endIso}`);
  console.log(`Parameters  : ${PARAMETER_NAMES.join(", ")}`);
  console.log(`Resume Mode : ${options.resume ? "ENABLED (skips already stored chunks)" : "DISABLED (re-ingests all)"}`);
  console.log("==================================================\n");

  const conn = await connectDatabase();
  if (!conn.connected) {
    console.error("Database connection failed:", conn.reason);
    process.exitCode = 1;
    return;
  }

  const startTime = Date.now();
  try {
    const result = await runIngestionWorkflow({
      districtCodes: options.districtCodes,
      parameters: PARAMETER_NAMES,
      startIso: options.startIso,
      endIso: options.endIso,
      resume: options.resume,
      onProgress: (p) => {
        if (p.status === "skipped") {
          console.log(`[SKIP] ${p.district} (${p.chunk.year}): chunk already stored`);
        } else if (p.status === "success") {
          console.log(`[OK]   ${p.district} (${p.chunk.year}): ${p.chunk.startIso}..${p.chunk.endIso} -> ${p.stored} obs (${p.durationMs}ms)`);
        } else if (p.status === "failed") {
          console.error(`[FAIL] ${p.district} (${p.chunk.year}): ${p.error}`);
        }
      },
    });

    console.log("\n==================================================");
    console.log(`Ingestion Run Completed: ${result.status.toUpperCase()}`);
    console.log(`Run ID         : ${result.runId}`);
    console.log(`Stored Obs     : ${result.totalStored}`);
    console.log(`Processed      : ${result.totalChunksProcessed} chunks`);
    console.log(`Skipped        : ${result.totalChunksSkipped} chunks`);
    console.log(`Failed         : ${result.failedChunks} chunks`);
    console.log(`Total Duration : ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    console.log("==================================================\n");

    console.log("--- FINAL COVERAGE REPORTS ---\n");
    for (const code of options.districtCodes) {
      const report = await generateCoverageReport(code);
      console.log(`District: ${code.toUpperCase()}`);
      console.log(`  Total Observations: ${report.overall.totalObservations}`);
      console.log(`  Obs Quality       : OK=${report.overall.okCount}, Sentinels=${report.overall.sentinelCount}, Absent=${report.overall.absentCount}`);
      console.log(`  Covered Date Range: ${report.overall.firstDate || "none"} to ${report.overall.lastDate || "none"}`);
      console.log("  Per-Parameter Details:");
      for (const [p, meta] of Object.entries(report.parameters)) {
        console.log(`    ${p.padEnd(20)}: ${String(meta.okCount).padStart(5)}/${String(meta.total).padStart(5)} ok (${meta.coveragePercent}%) [${meta.firstDate}..${meta.lastDate}] (${meta.unit})`);
      }
      console.log("");
    }
  } catch (error) {
    console.error("Ingestion run aborted with error:", error.message);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1] && process.argv[1].endsWith("ingest-power.js")) {
  main();
}
