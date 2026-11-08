/**
 * Real NASA SMAP Download and Validation Job using NASA Harmony API.
 * Requests independent spatial subsets for Cumilla and Chattogram:
 *   - Cumilla: Lat 23.46186, Lon 91.18503 -> Subset: lat(23.1:23.8), lon(90.8:91.6)
 *   - Chattogram: Lat 22.3384, Lon 91.8317 -> Subset: lat(22.0:22.7), lon(91.5:92.2)
 *
 * Strict Safety Boundaries:
 * - Does NOT write to MongoDB.
 * - Downloads raw files into server/data/smap/raw/<district>/ for independent inspection.
 * - Invokes python server/science/smap_parser.py to validate HDF5 structures.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SMAP } from "../config/smap.config.js";
import {
  getEarthdataAuthHeader,
  isEarthdataConfigured,
  verifyHarmonyAuth,
} from "../services/nasa/earthdata.auth.js";

const DISTRICT_CONFIGS = [
  {
    code: "cumilla",
    name: "Cumilla",
    refLat: 23.46186,
    refLon: 91.18503,
    subsetLat: "23.1:23.8",
    subsetLon: "90.8:91.6",
  },
  {
    code: "chattogram",
    name: "Chattogram",
    refLat: 22.3384,
    refLon: 91.8317,
    subsetLat: "22.0:22.7",
    subsetLon: "91.5:92.2",
  },
];

const TARGET_START = "2024-01-01T00:00:00Z";
const TARGET_END = "2024-01-03T23:59:59Z";

async function processDistrict(dist, authHeader) {
  console.log(`\n=============================================================`);
  console.log(`   PROCESSING DISTRICT: ${dist.name.toUpperCase()} (${dist.code})   `);
  console.log(`   Reference: Lat ${dist.refLat}, Lon ${dist.refLon}`);
  console.log(`   Subset: Lat ${dist.subsetLat}, Lon ${dist.subsetLon}`);
  console.log(`=============================================================`);

  const rawDir = path.resolve("data", "smap", "raw", dist.code);
  fs.mkdirSync(rawDir, { recursive: true });

  const harmonyUrl = `${SMAP.harmonyBaseUrl}/${SMAP.collectionConceptId}/ogc-api-coverages/1.0.0/collections/all/coverage/rangeset?subset=lat(${dist.subsetLat})&subset=lon(${dist.subsetLon})&subset=time("${TARGET_START}":"${TARGET_END}")&forceAsync=true`;

  console.log(`[Submit Request] ${dist.name}...`);
  const initRes = await fetch(harmonyUrl, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      "User-Agent": "KrishiMama/1.0 (NASA Space Apps Challenge 2026; Team NeuralMesh)",
    },
  });

  if (!initRes.ok) {
    console.error(`[Harmony Request Failed] HTTP ${initRes.status}: ${initRes.statusText}`);
    const body = await initRes.text();
    console.error(`[Details] ${body.slice(0, 500)}`);
    return [];
  }

  const jobJson = await initRes.json();
  const jobId = jobJson.jobID;
  const pollUrl = `${SMAP.harmonyBaseUrl}/jobs/${jobId}`;
  console.log(`[Harmony Job] Submitted. Job ID: ${jobId}`);

  let jobComplete = false;
  let jobData = null;
  let attempts = 0;
  const maxAttempts = 35;

  while (!jobComplete && attempts < maxAttempts) {
    attempts++;
    await new Promise((r) => setTimeout(r, 4000));

    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: authHeader, "User-Agent": "KrishiMama/1.0" },
    });

    if (pollRes.ok) {
      jobData = await pollRes.json();
      console.log(`  [Poll ${attempts}] Status: ${jobData.status} (Progress: ${jobData.progress || 0}%)`);
      if (jobData.status === "successful" || jobData.status === "failed") {
        jobComplete = true;
      }
    }
  }

  if (jobData?.status !== "successful") {
    console.error(`[Job Failed] ${dist.name} final status: ${jobData?.status || "timed out"}`);
    return [];
  }

  const links = jobData.links || [];
  const dataLinks = links.filter((l) => l.rel === "data" || l.href?.includes("download"));
  console.log(`Found ${dataLinks.length} result files for ${dist.name}.`);

  const downloadedFiles = [];
  for (let i = 0; i < dataLinks.length; i++) {
    const fileUrl = dataLinks[i].href;
    const fileName = path.basename(new URL(fileUrl).pathname) || `${dist.code}_subset_${i + 1}.nc4`;
    const destPath = path.join(rawDir, fileName);

    console.log(`  Downloading ${fileName}...`);
    const fileRes = await fetch(fileUrl, {
      headers: { Authorization: authHeader, "User-Agent": "KrishiMama/1.0" },
    });

    if (fileRes.ok) {
      const arrayBuffer = await fileRes.arrayBuffer();
      fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
      console.log(`  Saved to ${destPath} (${(arrayBuffer.byteLength / 1024).toFixed(1)} KB)`);
      downloadedFiles.push(destPath);
    }
  }

  return downloadedFiles;
}

async function runHarmonyDownload() {
  console.log("=============================================================");
  console.log("   KRISHI MAMA — INDEPENDENT DUAL-DISTRICT SMAP VALIDATION   ");
  console.log("=============================================================\n");

  const authStatus = await verifyHarmonyAuth();
  if (!authStatus.authenticated) {
    console.error("[ABORT] Authentication required. Please check EARTHDATA_TOKEN in server/.env.");
    return;
  }
  console.log(`[Auth Status] Authenticated: true (Service: NASA Harmony)`);

  const authHeader = getEarthdataAuthHeader();
  const districtFiles = {};

  for (const dist of DISTRICT_CONFIGS) {
    districtFiles[dist.code] = await processDistrict(dist, authHeader);
  }

  // Execute Python scientific parsing for each district independently
  console.log("\n=============================================================");
  console.log("   SCIENTIFIC PARSING & COORDINATE AUDIT                     ");
  console.log("=============================================================");

  for (const dist of DISTRICT_CONFIGS) {
    const files = districtFiles[dist.code] || [];
    console.log(`\n--- RESULTS FOR DISTRICT: ${dist.name.toUpperCase()} (${files.length} files) ---`);

    for (const fpath of files) {
      console.log(`\nFile: ${path.basename(fpath)}`);
      try {
        const stdout = execFileSync("python", ["science/smap_parser.py", fpath, dist.code], {
          encoding: "utf-8",
        });
        const parsed = JSON.parse(stdout);
        console.log(JSON.stringify(parsed, null, 2));
      } catch (err) {
        console.error(`Parsing error: ${err.message}`);
      }
    }
  }

  console.log("\n=============================================================");
  console.log("   INDEPENDENT VALIDATION COMPLETE (ZERO DB WRITES)          ");
  console.log("=============================================================");
}

runHarmonyDownload().catch(console.error);
