/**
 * NASA AppEEARS MODIS Data Fetcher & Validator
 *
 * Flow:
 * 1. Authenticate with Earthdata via AppEEARS login.
 * 2. Submit point extraction task for Cumilla & Chattogram reference coordinates.
 * 3. Poll task status until complete.
 * 4. Retrieve bundle file list and download CSVs to server/data/modis/raw/.
 * 5. Parse, validate, and compute QA metrics.
 * 6. Save dry-run preview without touching MongoDB.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  isAppeearsConfigured,
  submitAppeearsPointTask,
  getAppeearsTaskStatus,
  getAppeearsBundle,
  downloadAppeearsFile,
  validateModisObservation,
} from "../services/nasa/appeears.client.js";
import { MODIS } from "../config/modis.config.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rawDir = path.resolve(__dirname, "../../data/modis/raw");
const parsedDir = path.resolve(__dirname, "../../data/modis");

if (!fs.existsSync(rawDir)) {
  fs.mkdirSync(rawDir, { recursive: true });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Handle comma-separated fields with potential quotes
    const values = [];
    let insideQuotes = false;
    let currentValue = "";
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if (char === "," && !insideQuotes) {
        values.push(currentValue.trim().replace(/^"|"$/g, ""));
        currentValue = "";
      } else {
        currentValue += char;
      }
    }
    values.push(currentValue.trim().replace(/^"|"$/g, ""));
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] !== undefined ? values[idx] : "";
    });
    rows.push(row);
  }
  return rows;
}

async function main() {
  console.log("=========================================================");
  console.log("   NASA AppEEARS MODIS MOD13Q1.061 Extraction & Audit    ");
  console.log("=========================================================");

  if (!isAppeearsConfigured()) {
    console.error("[error] Earthdata credentials missing in server/.env");
    process.exit(1);
  }

  // 1. Submit Point Task
  const taskName = `krishi_mama_modis_${Date.now()}`;
  console.log(`\n[1/5] Submitting point sampling task (${taskName})...`);
  const submission = await submitAppeearsPointTask({
    taskName,
    startDate: "01-01-2024",
    endDate: "01-31-2024",
    coordinates: [
      { id: "cumilla", latitude: 23.46186, longitude: 91.18503, category: "district_ref" },
      { id: "chattogram", latitude: 22.3384, longitude: 91.8317, category: "district_ref" },
    ],
  });

  const taskId = submission.task_id;
  console.log(`  -> Task ID: ${taskId}`);
  console.log(`  -> Initial Status: ${submission.status}`);

  // 2. Poll Task Status
  console.log(`\n[2/5] Monitoring AppEEARS task progress...`);
  let isDone = false;
  let attempts = 0;
  const maxAttempts = 60; // Up to ~15 minutes

  while (!isDone && attempts < maxAttempts) {
    attempts++;
    await sleep(15000); // 15s interval
    const statusResp = await getAppeearsTaskStatus(taskId);
    const progress = statusResp.progress?.percent || 0;
    const currentState = statusResp.status;
    console.log(`  -> [${new Date().toISOString()}] Attempt ${attempts}: State = ${currentState}, Progress = ${progress}%`);

    if (currentState === "done") {
      isDone = true;
      break;
    } else if (currentState === "error" || currentState === "canceled") {
      throw new Error(`AppEEARS task ended with failure state: ${currentState}`);
    }
  }

  if (!isDone) {
    throw new Error("Timeout waiting for AppEEARS task completion.");
  }

  // 3. Fetch Bundle
  console.log(`\n[3/5] Fetching bundle file list for task ${taskId}...`);
  const bundle = await getAppeearsBundle(taskId);
  fs.writeFileSync(path.join(rawDir, `bundle_${taskId}.json`), JSON.stringify(bundle, null, 2));

  console.log(`  -> Found ${bundle.files.length} files in task bundle:`);
  bundle.files.forEach((f) => {
    console.log(`     - [${f.file_type}] ${f.file_name} (${(f.file_size / 1024).toFixed(1)} KB)`);
  });

  // 4. Download files
  console.log(`\n[4/5] Downloading bundle files to server/data/modis/raw/...`);
  const downloadedFiles = [];
  for (const f of bundle.files) {
    const fileBuf = await downloadAppeearsFile(taskId, f.file_id);
    const destPath = path.join(rawDir, f.file_name);
    fs.writeFileSync(destPath, Buffer.from(fileBuf));
    downloadedFiles.push({ ...f, localPath: destPath });
    console.log(`  -> Downloaded: ${f.file_name}`);
  }

  // 5. Parse CSV Results
  console.log(`\n[5/5] Parsing and validating observations...`);
  // Look for the main CSV output containing MOD13Q1 data
  const dataCsv = downloadedFiles.find(
    (f) => f.file_name.endsWith(".csv") && !f.file_name.includes("Granule-List")
  );

  if (!dataCsv) {
    console.warn("Could not find primary data CSV in bundle files.");
    return;
  }

  const csvContent = fs.readFileSync(dataCsv.localPath, "utf-8");
  const records = parseCSV(csvContent);
  console.log(`  -> Parsed ${records.length} raw records from ${dataCsv.file_name}`);

  // Format and validate records for Cumilla and Chattogram
  const districtMap = {
    cumilla: {
      districtCode: "cumilla",
      districtName: "Cumilla",
      adminPolygonPcode: "BD2019",
      refCoord: [91.18503, 23.46186],
    },
    chattogram: {
      districtCode: "chattogram",
      districtName: "Chattogram",
      adminPolygonPcode: "BD2015",
      refCoord: [91.8317, 22.3384],
    },
  };

  const parsedObservations = [];

  for (const row of records) {
    // AppEEARS point output columns typically include:
    // ID (or Category / Latitude / Longitude), Date, MOD13Q1_061__250m_16_days_NDVI, etc.
    const pointId = (row["ID"] || row["id"] || "").toLowerCase();
    const districtInfo = districtMap[pointId];

    if (!districtInfo) {
      // Try matching by latitude/longitude if ID isn't directly present
      continue;
    }

    // Identify layer columns dynamically
    const ndviCol = Object.keys(row).find((k) => k.includes("NDVI"));
    const eviCol = Object.keys(row).find((k) => k.includes("EVI"));
    const qaCol = Object.keys(row).find((k) => k.includes("pixel_reliability"));
    const doyCol = Object.keys(row).find((k) => k.includes("composite_day_of_the_year"));
    const dateStr = row["Date"] || row["date"] || "";

    const rawNdvi = ndviCol && row[ndviCol] !== "" ? parseFloat(row[ndviCol]) : null;
    const rawEvi = eviCol && row[eviCol] !== "" ? parseFloat(row[eviCol]) : null;
    const rawQa = qaCol && row[qaCol] !== "" ? parseInt(row[qaCol], 10) : null;
    const rawDoy = doyCol && row[doyCol] !== "" ? parseInt(row[doyCol], 10) : null;

    const validated = validateModisObservation({
      rawNdvi,
      rawEvi,
      pixelReliability: rawQa,
      compositeDoy: rawDoy,
    });

    const obsDate = new Date(dateStr);
    const dateLabel = dateStr;

    parsedObservations.push({
      districtCode: districtInfo.districtCode,
      districtName: districtInfo.districtName,
      adminPolygonPcode: districtInfo.adminPolygonPcode,
      date: obsDate,
      dateLabel,
      compositeDayOfYear: validated.compositeDoy,
      ndvi: validated.ndvi,
      evi: validated.evi,
      rawNdvi,
      rawEvi,
      pixelReliability: validated.pixelReliability,
      qualityClassification: validated.qualityClassification,
      isReliableQuality: validated.isReliableQuality,
      sourceDataset: MODIS.datasetKey,
      sourceProduct: MODIS.productName,
      sourceGranuleId: row["Granule"] || row["granule"] || `MOD13Q1.A2024${String(validated.compositeDoy).padStart(3, "0")}`,
      taskId,
      coordinates: {
        type: "Point",
        coordinates: [parseFloat(row["Longitude"] || districtInfo.refCoord[0]), parseFloat(row["Latitude"] || districtInfo.refCoord[1])],
      },
      geodesicDistanceKm: 0.0,
      metadata: {
        rawRow: row,
      },
    });
  }

  // Save parsed observations to disk for review
  const parsedPath = path.join(parsedDir, "parsed_modis_observations.json");
  fs.writeFileSync(parsedPath, JSON.stringify(parsedObservations, null, 2));

  console.log(`\n=========================================================`);
  console.log(`                VALIDATION SUMMARY RESULTS               `);
  console.log(`=========================================================`);
  console.log(`Total Extracted Observations: ${parsedObservations.length}`);

  ["cumilla", "chattogram"].forEach((dist) => {
    const subset = parsedObservations.filter((o) => o.districtCode === dist);
    console.log(`\n--- District: ${dist.toUpperCase()} (${subset.length} records) ---`);
    subset.forEach((o, idx) => {
      console.log(`  [Record ${idx + 1}] Date: ${o.dateLabel} (DOY ${o.compositeDayOfYear})`);
      console.log(`     NDVI: ${o.ndvi} (Raw: ${o.rawNdvi})`);
      console.log(`     EVI:  ${o.evi} (Raw: ${o.rawEvi})`);
      console.log(`     Pixel Reliability: ${o.pixelReliability} -> [${o.qualityClassification}] (Reliable: ${o.isReliableQuality})`);
      console.log(`     Coordinates: [${o.coordinates.coordinates.join(", ")}]`);
    });
  });

  console.log(`\n[note] Results saved to ${parsedPath}`);
  console.log(`[guard] MongoDB was NOT modified. Zero records inserted.`);
}

main().catch((err) => {
  console.error("\n[fatal] Execution error:", err);
  process.exit(1);
});
