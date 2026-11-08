/**
 * Parse and validate downloaded AppEEARS MODIS CSV results.
 * Strictly generates dry-run observation records without writing to MongoDB.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { validateModisObservation } from "../services/nasa/appeears.client.js";
import { MODIS } from "../config/modis.config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rawDir = path.resolve(__dirname, "../../data/modis/raw");
const parsedDir = path.resolve(__dirname, "../../data/modis");

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
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

const files = fs.readdirSync(rawDir);
const csvFile = files.find((f) => f.endsWith("-results.csv"));

if (!csvFile) {
  console.error("No -results.csv file found in server/data/modis/raw");
  process.exit(1);
}

const csvPath = path.join(rawDir, csvFile);
const csvContent = fs.readFileSync(csvPath, "utf-8");
const records = parseCSV(csvContent);

// Also read granule list if present
const granuleFile = files.find((f) => f.includes("granule-list"));
let granules = [];
if (granuleFile) {
  granules = fs.readFileSync(path.join(rawDir, granuleFile), "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

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
  const pointId = (row["ID"] || row["id"] || "").toLowerCase();
  const districtInfo = districtMap[pointId];
  if (!districtInfo) continue;

  const ndviCol = Object.keys(row).find((k) => k.includes("NDVI"));
  const eviCol = Object.keys(row).find((k) => k.includes("EVI"));
  const qaCol = Object.keys(row).find((k) => k.includes("pixel_reliability") && !k.includes("bitmask") && !k.includes("Description") && !k.includes("MODLAND"));
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

  // Match source granule by year and DOY if possible
  const compositeYear = dateStr.slice(0, 4);
  const matchedGranule = granules.find((g) => {
    // E.g. MOD13Q1.A2024001
    const doyPart = String(validated.compositeDoy).padStart(3, "0");
    return g.includes(`.A${compositeYear}`) && (g.includes(`A${compositeYear}${doyPart}`) || g.includes(`A${dateStr.slice(0, 4)}`));
  }) || granules[0] || `MOD13Q1.061.${dateLabel}`;

  const sourceGranuleId = matchedGranule.split("/").pop().replace(".hdf", "");

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
    sourceGranuleId,
    coordinates: {
      type: "Point",
      coordinates: [
        parseFloat(row["Longitude"] || districtInfo.refCoord[0]),
        parseFloat(row["Latitude"] || districtInfo.refCoord[1]),
      ],
    },
    geodesicDistanceKm: 0.0,
    metadata: {
      modisTile: row["MODIS_Tile"] || "h26v06",
      lineY250m: parseFloat(row["MOD13Q1_061_Line_Y_250m"] || 0),
      sampleX250m: parseFloat(row["MOD13Q1_061_Sample_X_250m"] || 0),
      viQualityBitmask: row["MOD13Q1_061__250m_16_days_VI_Quality_bitmask"],
      viQualityModlandDesc: row["MOD13Q1_061__250m_16_days_VI_Quality_MODLAND_Description"],
      viUsefulnessDesc: row["MOD13Q1_061__250m_16_days_VI_Quality_VI_Usefulness_Description"],
      aerosolQuantityDesc: row["MOD13Q1_061__250m_16_days_VI_Quality_Aerosol_Quantity_Description"],
      landWaterMaskDesc: row["MOD13Q1_061__250m_16_days_VI_Quality_Land/Water_Mask_Description"],
      pixelReliabilityDesc: row["MOD13Q1_061__250m_16_days_pixel_reliability_MODLAND_Description"],
    },
  });
}

const parsedPath = path.join(parsedDir, "parsed_modis_observations.json");
fs.writeFileSync(parsedPath, JSON.stringify(parsedObservations, null, 2));

console.log("=========================================================");
console.log("          PARSED MODIS OBSERVATIONS DRY-RUN              ");
console.log("=========================================================");
console.log(`Total Observations: ${parsedObservations.length}`);

["cumilla", "chattogram"].forEach((dist) => {
  const subset = parsedObservations.filter((o) => o.districtCode === dist);
  console.log(`\n--- District: ${dist.toUpperCase()} (${subset.length} records) ---`);
  subset.forEach((o, idx) => {
    console.log(`  [Record ${idx + 1}] Date: ${o.dateLabel} (DOY ${o.compositeDayOfYear})`);
    console.log(`     NDVI: ${o.ndvi} | EVI: ${o.evi}`);
    console.log(`     Pixel Reliability: ${o.pixelReliability} -> [${o.qualityClassification}] (Reliable: ${o.isReliableQuality})`);
    console.log(`     Tile: ${o.metadata.modisTile} (Line: ${o.metadata.lineY250m}, Sample: ${o.metadata.sampleX250m})`);
    console.log(`     Aerosol: ${o.metadata.aerosolQuantityDesc} | Usefulness: ${o.metadata.viUsefulnessDesc}`);
    console.log(`     Land/Water: ${o.metadata.landWaterMaskDesc}`);
    console.log(`     Reliability Desc: ${o.metadata.pixelReliabilityDesc}`);
    console.log(`     Source Granule: ${o.sourceGranuleId}`);
  });
});
console.log(`\n[guard] Zero MongoDB writes executed. Stored in ${parsedPath}`);
