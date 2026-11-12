/** Resumable, insert-only SMAP expansion for a maximum two-day range. */
import dotenv from "dotenv";
dotenv.config();

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SMAP } from "../config/smap.config.js";
import { DISTRICTS } from "../config/climate.config.js";
import { getEarthdataAuthHeader } from "../services/nasa/earthdata.auth.js";
import { searchSmapGranules } from "../services/nasa/smap.client.js";
import { fetchWithRetry } from "../services/nasa/fetch-with-retry.js";
import { persistValidatedSmapObservations } from "../services/nasa/smap.persistence.js";

const execFileAsync = promisify(execFile);
const districts = {
  cumilla: { lat: "23.1:23.8", lon: "90.8:91.6", admin: "BD2019", bbox: { minLat: 23.0, maxLat: 23.9, minLon: 90.7, maxLon: 91.7 } },
  chattogram: { lat: "22.0:22.7", lon: "91.5:92.2", admin: "BD2015", bbox: { minLat: 21.8, maxLat: 22.9, minLon: 91.3, maxLon: 92.4 } },
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function dateRangeArgs() {
  const start = process.argv.find(x => x.startsWith("--start="))?.slice(8);
  const end = process.argv.find(x => x.startsWith("--end="))?.slice(6);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || "") || !/^\d{4}-\d{2}-\d{2}$/.test(end || "") || start > end) {
    throw new Error("Pass a valid range using --start=YYYY-MM-DD --end=YYYY-MM-DD");
  }
  if ([start, end].some(value => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) {
    throw new Error("SMAP range contains a non-existent calendar date");
  }
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days > 2) throw new Error("SMAP expansion is limited to two days per invocation");
  const district = process.argv.find(x => x.startsWith("--district="))?.slice(11) || "chattogram";
  if (!districts[district]) throw new Error("Pass --district=chattogram or --district=cumilla");
  return { start, end, district };
}

function geodesicKm(lat1, lon1, lat2, lon2) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(h));
}

async function submitHarmony(districtCode, dateRange, authHeader) {
  const subset = districts[districtCode];
  const startUtc = `${dateRange.start}T00:00:00Z`;
  const endUtc = `${dateRange.end}T23:59:59Z`;
  const url = `${SMAP.harmonyBaseUrl}/${SMAP.collectionConceptId}/ogc-api-coverages/1.0.0/collections/all/coverage/rangeset?subset=lat(${subset.lat})&subset=lon(${subset.lon})&subset=time("${startUtc}":"${endUtc}")&forceAsync=true`;
  // Harmony job submission is a POST without a known idempotency key; don't
  // retry it automatically because a lost response could create duplicate jobs.
  const response = await fetchWithRetry(url, { headers: { Authorization: authHeader, "User-Agent": "KrishiMama/1.0" }, signal: AbortSignal.timeout(60000) }, { attempts: 1 });
  if (response.status === 401) throw new Error("NASA Harmony authentication failed (HTTP 401)");
  if (response.status === 403) throw new Error("NASA Harmony authorization failed (HTTP 403)");
  if (response.status === 429) throw new Error("NASA Harmony rate limit reached (HTTP 429)");
  if (!response.ok) throw new Error(`NASA Harmony submission returned HTTP ${response.status}`);
  const submitted = await response.json();
  if (!submitted.jobID) throw new Error("Harmony response did not include a job ID");
  const pollUrl = `${SMAP.harmonyBaseUrl}/jobs/${submitted.jobID}`;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(4000);
    const poll = await fetchWithRetry(pollUrl, { headers: { Authorization: authHeader, "User-Agent": "KrishiMama/1.0" }, signal: AbortSignal.timeout(30000) });
    if (poll.status === 401 || poll.status === 403 || poll.status === 429) {
      throw new Error(`NASA Harmony poll stopped on HTTP ${poll.status}`);
    }
    if (!poll.ok) throw new Error(`NASA Harmony poll returned HTTP ${poll.status}`);
    const status = await poll.json();
    if (status.status === "successful") return { jobId: submitted.jobID, links: status.links || [] };
    if (status.status === "failed") throw new Error(`NASA Harmony job ${submitted.jobID} failed`);
  }
  throw new Error(`NASA Harmony job ${submitted.jobID} exceeded the bounded polling window`);
}

function dateFromGranule(fileName) {
  const date = fileName.match(/_(\d{4})(\d{2})(\d{2})_/);
  return date ? `${date[1]}-${date[2]}-${date[3]}` : null;
}

async function parseFile(filePath, districtCode, runId) {
  const { stdout } = await execFileAsync(process.env.PYTHON || "python", ["science/smap_parser.py", filePath, districtCode], { maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (!parsed.success) throw new Error(`SMAP parser rejected ${path.basename(filePath)}: ${parsed.error || "unknown parser error"}`);
  const code = parsed.districts?.[districtCode];
  if (!code) throw new Error(`SMAP parser did not return ${districtCode}`);
  const dateLabel = dateFromGranule(path.basename(filePath));
  if (!dateLabel) throw new Error(`Could not identify date in SMAP granule name ${path.basename(filePath)}`);
  const target = DISTRICTS.find(d => d.code === districtCode);
  const docs = [];
  for (const [orbit, observation] of Object.entries(code.observations || {})) {
    if (!['AM', 'PM'].includes(orbit)) throw new Error(`Unexpected SMAP orbit ${orbit}`);
    const q = observation.qa_breakdown || {};
    const coords = observation.spatial_verification || {};
    const pixel = coords.pixel_coords || {};
    if (!Number.isFinite(pixel.lat) || !Number.isFinite(pixel.lon) ||
        pixel.lat < districts[districtCode].bbox.minLat || pixel.lat > districts[districtCode].bbox.maxLat ||
        pixel.lon < districts[districtCode].bbox.minLon || pixel.lon > districts[districtCode].bbox.maxLon) {
      continue;
    }
    const rawFlag = observation.retrieval_qual_flag;
    if (!Number.isInteger(rawFlag)) throw new Error(`Missing SMAP retrieval quality flag for ${districtCode} ${dateLabel} ${orbit}`);
    // Only persist actual in-range values whose V006 retrieval flag is recommended.
    // NSIDC defines retrieval_qual_flag values 0 and 8 as recommended quality.
    if (![0, 8].includes(rawFlag) || !Number.isFinite(observation.soil_moisture) || observation.is_recommended !== true) continue;
    const ancillary = observation.surface_diagnostics || {};
    const doc = {
      districtCode,
      dateLabel,
      date: new Date(`${dateLabel}T00:00:00.000Z`),
      acquisitionTimeUtc: observation.acquisition_time_utc ? new Date(observation.acquisition_time_utc) : null,
      orbit,
      soilMoisture: observation.soil_moisture,
      soilMoistureDca: observation.soil_moisture_dca,
      unit: observation.unit || SMAP.unit,
      retrievalQualityFlag: rawFlag,
      retrievalQualityDcaFlag: observation.retrieval_qual_flag_dca,
      isRecommendedQuality: observation.is_recommended === true,
      qualityClassification: observation.is_recommended === true ? "recommended" : "not_recommended",
      surfaceFlag: observation.surface_flag,
      qaBits: {
        bit0NotRecommended: !q.bit0_recommended,
        bit1NotAttempted: !q.bit1_attempted,
        bit2NotSuccessful: !q.bit2_successful,
        bit3FreezeThawUnsuccessful: q.bit3_freeze_thaw_unsuccessful === true,
        rawFlag,
      },
      surfaceTemperatureK: ancillary.surface_temperature_k,
      freezeThawFraction: ancillary.freeze_thaw_fraction,
      bulkDensity: ancillary.bulk_density,
      clayFraction: ancillary.clay_fraction,
      staticWaterFraction: ancillary.static_water_body_fraction,
      radarWaterFraction: ancillary.radar_water_body_fraction,
      soilPorosity: Number.isFinite(ancillary.bulk_density) ? Number((1 - ancillary.bulk_density / 2.65).toFixed(4)) : null,
      latitude: pixel.lat,
      longitude: pixel.lon,
      targetReferenceLat: target.latitude,
      targetReferenceLon: target.longitude,
      geodesicDistanceKm: coords.geodesic_distance_km ?? geodesicKm(target.latitude, target.longitude, pixel.lat, pixel.lon),
      adminPolygonPcode: districts[districtCode].admin,
      datasetKey: SMAP.datasetKey,
      granuleId: path.basename(filePath).replace(/_subsetted\.nc4$/i, ""),
      sourceUrl: `${SMAP.harmonyBaseUrl}/${SMAP.collectionConceptId}`,
      ingestionRunId: runId,
      provenanceDatasetId: SMAP.datasetKey,
    };
    if (doc.soilMoisture !== null && (!Number.isFinite(doc.soilMoisture) || doc.soilMoisture < 0 || doc.soilMoisture > SMAP.maxValid)) {
      throw new Error(`Out-of-range SMAP value for ${districtCode} ${dateLabel} ${orbit}`);
    }
    docs.push(doc);
  }
  if (docs.length === 0) {
    throw new Error(`SMAP ${districtCode} ${dateLabel} has no in-bounds, non-fill, recommended-quality AM/PM observations`);
  }
  return docs;
}

let stage = "argument_validation";
async function main() {
  const dateRange = dateRangeArgs();
  const apply = process.argv.includes("--apply");
  stage = "Earthdata credential resolution";
  const authHeader = getEarthdataAuthHeader();
  const runId = `smap-${dateRange.start}-${dateRange.end}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const validatedDocs = [];
  const discoveredGranules = [];
  let downloadedFiles = 0, skipped = 0;
  try {
    const districtCode = dateRange.district;
    stage = `NASA CMR granule discovery for ${districtCode}`;
    const granules = await searchSmapGranules({
      startDate: dateRange.start,
      endDate: dateRange.end,
      districtCode,
      limit: 50,
    });
    if (granules.length === 0) throw new Error(`NASA CMR found no ${SMAP.productName} granules over ${districtCode} for the requested dates`);
    const discoveredDates = new Set(granules.map((granule) => granule.dateLabel));
    discoveredGranules.push(...granules.map(({ granuleId, title, dateLabel, updated }) => ({ granuleId, title, dateLabel, updated })));

    {
      stage = `NASA Harmony submission for ${districtCode}`;
      console.log(`SMAP expansion: requesting bounded Harmony subset for ${districtCode}.`);
      const result = await submitHarmony(districtCode, dateRange, authHeader);
      const links = result.links.filter(link => {
        if (typeof link?.href !== "string") return false;
        try {
          const parsed = new URL(link.href);
          return parsed.protocol === "https:" && (link.rel === "data" || /\.(?:nc4|h5)$/i.test(parsed.pathname));
        } catch {
          return false;
        }
      });
      const uniqueLinks = [...new Map(links.map(link => [link.href, link])).values()];
      if (uniqueLinks.length === 0) throw new Error(`Harmony returned no data files for ${districtCode}`);
      for (const link of uniqueLinks) {
        const remoteName = path.basename(new URL(link.href).pathname) || `${districtCode}-${Date.now()}.nc4`;
        const granuleDate = dateFromGranule(remoteName);
        if (!granuleDate || !discoveredDates.has(granuleDate)) {
          throw new Error(`Harmony file ${remoteName} does not match a granule discovered by CMR for ${districtCode}`);
        }
        const fileName = `${districtCode}_${remoteName}`;
        const dest = path.resolve("data/smap/raw", fileName);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        try {
          await fs.access(dest);
          skipped += 1;
        } catch (error) {
          // Only ENOENT is expected; surface other filesystem errors.
          if (error.code !== "ENOENT") throw error;
          const file = await fetchWithRetry(link.href, { headers: { Authorization: authHeader, "User-Agent": "KrishiMama/1.0" }, signal: AbortSignal.timeout(60000) });
          if (file.status === 401 || file.status === 403 || file.status === 429) throw new Error(`NASA Harmony download stopped on HTTP ${file.status}`);
          if (!file.ok) throw new Error(`NASA Harmony download returned HTTP ${file.status}`);
          const bytes = Buffer.from(await file.arrayBuffer());
          if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) throw new Error(`Unexpected SMAP subset size (${bytes.length} bytes)`);
          await fs.writeFile(dest, bytes, { flag: "wx" });
          downloadedFiles += 1;
        }
        const observations = await parseFile(dest, districtCode, runId);
        if (observations.some(obs => obs.dateLabel < dateRange.start || obs.dateLabel > dateRange.end)) {
          throw new Error(`SMAP granule ${fileName} escaped requested date range`);
        }
        validatedDocs.push(...observations);
      }
    }
    const uniqueDocs = [...new Map(validatedDocs.map((doc) => [`${doc.districtCode}:${doc.dateLabel}:${doc.orbit}`, doc])).values()];
    if (uniqueDocs.length === 0) throw new Error("No unique, validated SMAP observations remain after district, geolocation, fill-value, and quality checks");

    if (!apply) {
      const stagingDir = path.resolve("data/smap/recovery-staging");
      await fs.mkdir(stagingDir, { recursive: true });
      const stagedPath = path.join(stagingDir, `${runId}.json`);
      await fs.writeFile(stagedPath, JSON.stringify({
        runId,
        dateRange,
        discoveredGranules,
        downloadedFiles,
        reusedFiles: skipped,
        validatedObservationCount: uniqueDocs.length,
        observations: uniqueDocs,
        persistedToDatabase: false,
      }, null, 2), { flag: "wx" });
      console.log(JSON.stringify({ runId, dateRange, discoveredGranules: discoveredGranules.length, downloadedFiles, reusedFiles: skipped, validatedObservationCount: uniqueDocs.length, stagedPath, persistedToDatabase: false }));
      console.log("Dry run complete. Re-run with --apply only after reviewing and explicitly authorizing database persistence.");
      return;
    }

    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
    stage = "MongoDB Atlas connection after data validation";
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
    console.log("SMAP expansion: database connection established after NASA data validation.");
    const persistence = await persistValidatedSmapObservations(uniqueDocs);
    console.log(JSON.stringify({ runId, dateRange, discoveredGranules: discoveredGranules.length, downloadedFiles, reusedFiles: skipped, validatedObservationCount: uniqueDocs.length, ...persistence }));
  } finally {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error(`SMAP expansion stopped during ${stage}: ${error.message}`);
  process.exitCode = 1;
});
