/** Resumable, insert-only MOD13Q1 point extraction, limited to 32 days. */
import dotenv from "dotenv";
dotenv.config();

import crypto from "node:crypto";
import mongoose from "mongoose";
import { MODIS } from "../config/modis.config.js";
import { ModisObservation } from "../models/modisobservation.model.js";
import {
  submitAppeearsPointTask, getAppeearsTaskStatus, getAppeearsBundle,
  downloadAppeearsFile, validateModisObservation,
} from "../services/nasa/appeears.client.js";

const points = {
  cumilla: { latitude: 23.46186, longitude: 91.18503, admin: "BD2019" },
  chattogram: { latitude: 22.3384, longitude: 91.8317, admin: "BD2015" },
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function geodesicKm(lat1, lon1, lat2, lon2) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getRange() {
  const start = process.argv.find(x => x.startsWith("--start="))?.slice(8);
  const end = process.argv.find(x => x.startsWith("--end="))?.slice(6);
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid(start) || !valid(end) || start > end) throw new Error("Pass valid --start=YYYY-MM-DD and --end=YYYY-MM-DD");
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
  if (days > 32) throw new Error("MODIS extraction is limited to 32 days per task");
  return { start, end };
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const split = line => {
    const cells = []; let cell = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = !quoted;
      else if (c === "," && !quoted) { cells.push(cell); cell = ""; }
      else cell += c;
    }
    cells.push(cell); return cells;
  };
  const headers = split(lines[0]).map(x => x.trim());
  return lines.slice(1).filter(Boolean).map(line => Object.fromEntries(split(line).map((x, i) => [headers[i], x.trim()])));
}
const number = value => value === "" || value == null || !Number.isFinite(Number(value)) ? null : Number(value);

async function main() {
  const range = getRange();
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
  const runId = `modis-${range.start}-${range.end}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const baselineCount = await ModisObservation.countDocuments();
  try {
    await ModisObservation.init();
    const toAppeearsDate = value => `${value.slice(5, 7)}-${value.slice(8, 10)}-${value.slice(0, 4)}`;
    const submitted = await submitAppeearsPointTask({
      taskName: `krishi-mama-modis-${range.start}-${range.end}-${Date.now()}`,
      startDate: toAppeearsDate(range.start), endDate: toAppeearsDate(range.end),
      coordinates: Object.entries(points).map(([id, p]) => ({ id, latitude: p.latitude, longitude: p.longitude, category: "district_ref" })),
    });
    const taskId = submitted.task_id;
    if (!taskId) throw new Error("AppEEARS did not return a task ID");
    let completed = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      await delay(10000);
      const status = await getAppeearsTaskStatus(taskId);
      if (status.status === "done") { completed = true; break; }
      if (["error", "canceled"].includes(status.status)) throw new Error(`AppEEARS task stopped: ${status.status}`);
    }
    if (!completed) throw new Error(`AppEEARS task ${taskId} exceeded the bounded 400-second poll window`);
    const bundle = await getAppeearsBundle(taskId);
    const csvFile = (bundle.files || []).find(file => /\.csv$/i.test(file.file_name || "") && !/granule[-_ ]list/i.test(file.file_name));
    const granuleFile = (bundle.files || []).find(file => /granule[-_ ]list/i.test(file.file_name || ""));
    if (!csvFile || !granuleFile || csvFile.file_size > 5 * 1024 * 1024 || granuleFile.file_size > 2 * 1024 * 1024) {
      throw new Error("AppEEARS bundle lacks a bounded results CSV or source granule list");
    }
    const bytes = Buffer.from(await downloadAppeearsFile(taskId, csvFile.file_id));
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error(`Unexpected MODIS CSV size (${bytes.length} bytes)`);
    const granuleBytes = Buffer.from(await downloadAppeearsFile(taskId, granuleFile.file_id));
    if (!granuleBytes.length || granuleBytes.length > 2 * 1024 * 1024) throw new Error(`Unexpected MODIS granule-list size (${granuleBytes.length} bytes)`);
    const csvSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const granuleListSha256 = crypto.createHash("sha256").update(granuleBytes).digest("hex");
    const sourceGranules = granuleBytes.toString("utf8").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const csv = parseCsv(bytes.toString("utf8"));
    const docs = []; const rejected = { invalidQuality: 0, fillOrOutOfRange: 0 };
    for (const row of csv) {
      const districtCode = (row.ID || row.id || "").toLowerCase();
      if (!points[districtCode]) continue;
      const ndviCol = Object.keys(row).find(k => /NDVI/.test(k));
      const eviCol = Object.keys(row).find(k => /EVI/.test(k) && !/NDVI/.test(k));
      const qaCol = Object.keys(row).find(k => /pixel_reliability/.test(k) && !/Description|bitmask|MODLAND/.test(k));
      const doyCol = Object.keys(row).find(k => /composite_day_of_the_year/.test(k));
      const dateLabel = row.Date || row.date || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateLabel) || dateLabel < range.start || dateLabel > range.end ||
          new Date(`${dateLabel}T00:00:00Z`).toISOString().slice(0, 10) !== dateLabel) {
        throw new Error(`MODIS row has invalid/out-of-window date for ${districtCode}`);
      }
      const rawNdvi = number(row[ndviCol]); const rawEvi = number(row[eviCol]);
      const pixelReliability = number(row[qaCol]); const compositeDoy = number(row[doyCol]);
      if (pixelReliability === null || !Number.isInteger(pixelReliability) || pixelReliability < 0 || pixelReliability > 3) {
        rejected.invalidQuality += 1; continue;
      }
      const validated = validateModisObservation({ rawNdvi, rawEvi, pixelReliability, compositeDoy });
      if (!validated.valid || validated.compositeDoy === null) { rejected.fillOrOutOfRange += 1; continue; }
      const p = points[districtCode];
      const lat = number(row.Latitude); const lon = number(row.Longitude);
      if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        throw new Error(`MODIS geolocation missing or invalid for ${districtCode} ${dateLabel}`);
      }
      const distanceKm = geodesicKm(p.latitude, p.longitude, lat, lon);
      if (distanceKm > 2) throw new Error(`MODIS point for ${districtCode} is ${distanceKm.toFixed(2)} km from its reference coordinate`);
      const year = Number(dateLabel.slice(0, 4));
      const doy = Math.floor((Date.parse(`${dateLabel}T00:00:00Z`) - Date.UTC(year, 0, 1)) / 86400000) + 1;
      const granuleLine = sourceGranules.find(line => line.includes(`.A${year}${String(doy).padStart(3, "0")}.`));
      const sourceGranuleId = row.Granule || row.granule || (granuleLine ? pathGranuleId(granuleLine) : null);
      if (!sourceGranuleId) throw new Error(`No AppEEARS granule provenance matched ${dateLabel}`);
      docs.push({
        districtCode, dateLabel, date: new Date(`${dateLabel}T00:00:00.000Z`), compositeDayOfYear: validated.compositeDoy,
        ndvi: validated.ndvi, evi: validated.evi, rawNdvi, rawEvi, pixelReliability: validated.pixelReliability,
        qualityClassification: validated.qualityClassification, isReliableQuality: validated.isReliableQuality,
        latitude: lat, longitude: lon, targetReferenceLat: p.latitude, targetReferenceLon: p.longitude,
        geodesicDistanceKm: Number(distanceKm.toFixed(3)), adminPolygonPcode: p.admin, datasetKey: MODIS.datasetKey,
        taskId, sourceGranuleId, sourceProduct: MODIS.productName,
        sourceMetadata: { collectionConceptId: MODIS.collectionConceptId, requestedDateRange: range,
          csvFile: csvFile.file_name, csvSha256, granuleListFile: granuleFile.file_name,
          granuleListSha256, row }, ingestionRunId: runId, provenanceDatasetId: MODIS.datasetKey,
      });
    }
    if (!docs.length || new Set(docs.map(d => `${d.districtCode}:${d.dateLabel}`)).size !== docs.length) {
      throw new Error("MODIS chunk is empty or contains duplicate district/date observations");
    }
    for (const code of Object.keys(points)) {
      if (!docs.some(doc => doc.districtCode === code)) throw new Error(`MODIS chunk has no valid observations for ${code}`);
    }
    const operations = docs.map(doc => ({ updateOne: {
      filter: { districtCode: doc.districtCode, dateLabel: doc.dateLabel },
      update: { $setOnInsert: doc }, upsert: true,
    }}));
    const result = await ModisObservation.bulkWrite(operations, { ordered: true });
    const after = await ModisObservation.countDocuments();
    const keys = docs.map(doc => ({ districtCode: doc.districtCode, dateLabel: doc.dateLabel }));
    const readback = await ModisObservation.find({ $or: keys }).select("districtCode dateLabel ndvi evi pixelReliability compositeDayOfYear taskId sourceGranuleId").lean();
    if (readback.length !== docs.length) throw new Error(`MODIS read-back mismatch: expected ${docs.length}, found ${readback.length}`);
    console.log(JSON.stringify({ runId, taskId, range, downloadedBytes: bytes.length + granuleBytes.length, validatedCsvRows: csv.length,
      validatedObservations: docs.length, upserted: result.upsertedCount, matchedExisting: result.matchedCount,
      qualityClassifications: Object.fromEntries(["good_data", "marginal_data", "snow_ice", "cloudy"].map(q => [q, docs.filter(d => d.qualityClassification === q).length])),
      rejectedRows: rejected,
      baselineCount, finalCount: after, baselinePreserved: after >= baselineCount, readbackCount: readback.length,
      districts: Object.fromEntries(Object.keys(points).map(code => [code, readback.filter(d => d.districtCode === code).length])) }));
  } finally { await mongoose.disconnect(); }
}

function pathGranuleId(url) {
  return new URL(url).pathname.split("/").pop().replace(/\.hdf?$/i, "");
}

main().catch(error => { console.error(`MODIS coverage expansion stopped: ${error.message}`); process.exitCode = 1; });
