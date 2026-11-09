/** Insert-only ingestion for one already inspected SMAP subset file. */
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
import { SmapObservation } from "../models/smapobservation.model.js";

const execFileAsync = promisify(execFile);
const targetDistricts = {
  cumilla: { bbox: { minLat: 23, maxLat: 23.9, minLon: 90.7, maxLon: 91.7 }, admin: "BD2019" },
};

function getArgs() {
  const file = process.argv.find(x => x.startsWith("--file="))?.slice(7);
  const district = process.argv.find(x => x.startsWith("--district="))?.slice(11)?.toLowerCase();
  if (!file || district !== "cumilla") throw new Error("Pass --file=<staged HDF5 subset> --district=cumilla");
  return { file: path.resolve(file), district };
}

function geodesicKm(lat1, lon1, lat2, lon2) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fingerprint(docs) {
  return JSON.stringify(docs.map(d => ({
    districtCode: d.districtCode, dateLabel: d.dateLabel, orbit: d.orbit,
    soilMoisture: d.soilMoisture, retrievalQualityFlag: d.retrievalQualityFlag,
    latitude: d.latitude, longitude: d.longitude, granuleId: d.granuleId,
  })).sort((a, b) => `${a.districtCode}:${a.dateLabel}:${a.orbit}`.localeCompare(`${b.districtCode}:${b.dateLabel}:${b.orbit}`)));
}

async function main() {
  const { file, district: districtCode } = getArgs();
  const bytes = await fs.readFile(file);
  const fileSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const { stdout } = await execFileAsync(process.env.PYTHON || "python", ["science/smap_parser.py", file, districtCode], { maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (!parsed.success) throw new Error(`SMAP parser rejected the inspected file: ${parsed.error || "unknown error"}`);
  const dateMatch = path.basename(file).match(/SMAP_L3_SM_P_E_(\d{8})_R\d+_\d+/);
  if (!dateMatch) throw new Error("Cannot verify date/source granule from staged filename");
  const dateLabel = `${dateMatch[1].slice(0, 4)}-${dateMatch[1].slice(4, 6)}-${dateMatch[1].slice(6, 8)}`;
  const producerGranuleId = `SMAP_L3_SM_P_E_${dateMatch[1]}_${path.basename(file).match(/_R\d+_\d+/)[0].slice(1)}.h5`;
  const target = DISTRICTS.find(d => d.code === districtCode);
  const bbox = targetDistricts[districtCode].bbox;
  const orbitResults = parsed.districts?.[districtCode]?.observations || {};
  const docs = [];
  for (const orbit of ["AM", "PM"]) {
    const observation = orbitResults[orbit];
    if (!observation) continue;
    const pixel = observation.spatial_verification?.pixel_coords || {};
    const rawFlag = observation.retrieval_qual_flag;
    if (!Number.isFinite(pixel.lat) || !Number.isFinite(pixel.lon) ||
        pixel.lat < bbox.minLat || pixel.lat > bbox.maxLat || pixel.lon < bbox.minLon || pixel.lon > bbox.maxLon) continue;
    if (![0, 8].includes(rawFlag) || observation.is_recommended !== true ||
        !Number.isFinite(observation.soil_moisture) || observation.soil_moisture < SMAP.minValid || observation.soil_moisture > 0.5) continue;
    const sourceHistory = parsed.source_metadata?.history || "";
    if (!sourceHistory.includes(producerGranuleId)) throw new Error("HDF5 source history does not match its producer granule");
    const sourceUrl = sourceHistory.match(/https:\/\/opendap\.earthdata\.nasa\.gov\/[^?]+/)?.[0];
    if (!sourceUrl) throw new Error("HDF5 source history has no verifiable OPeNDAP source URL");
    const q = observation.qa_breakdown || {};
    const ancillary = observation.surface_diagnostics || {};
    const pixelDistance = geodesicKm(target.latitude, target.longitude, pixel.lat, pixel.lon);
    if (pixelDistance > 25) throw new Error(`SMAP ${orbit} pixel is unexpectedly far from Cumilla (${pixelDistance.toFixed(2)} km)`);
    docs.push({
      districtCode, dateLabel, date: new Date(`${dateLabel}T00:00:00.000Z`),
      acquisitionTimeUtc: observation.acquisition_time_utc ? new Date(observation.acquisition_time_utc) : null,
      orbit, soilMoisture: observation.soil_moisture, soilMoistureDca: observation.soil_moisture_dca,
      unit: observation.unit || SMAP.unit, retrievalQualityFlag: rawFlag,
      retrievalQualityDcaFlag: observation.retrieval_qual_flag_dca, isRecommendedQuality: true,
      qualityClassification: "recommended", surfaceFlag: observation.surface_flag,
      qaBits: { bit0NotRecommended: !q.bit0_recommended, bit1NotAttempted: !q.bit1_attempted,
        bit2NotSuccessful: !q.bit2_successful, bit3FreezeThawUnsuccessful: q.bit3_freeze_thaw_unsuccessful === true, rawFlag },
      surfaceTemperatureK: ancillary.surface_temperature_k, freezeThawFraction: ancillary.freeze_thaw_fraction,
      bulkDensity: ancillary.bulk_density, clayFraction: ancillary.clay_fraction,
      staticWaterFraction: ancillary.static_water_body_fraction, radarWaterFraction: ancillary.radar_water_body_fraction,
      soilPorosity: Number.isFinite(ancillary.bulk_density) ? Number((1 - ancillary.bulk_density / 2.65).toFixed(4)) : null,
      latitude: pixel.lat, longitude: pixel.lon, targetReferenceLat: target.latitude, targetReferenceLon: target.longitude,
      geodesicDistanceKm: Number(pixelDistance.toFixed(3)), adminPolygonPcode: targetDistricts[districtCode].admin,
      datasetKey: SMAP.datasetKey, granuleId: producerGranuleId, sourceUrl, sourceFileSha256: fileSha256,
      sourceMetadata: { productVersion: "006", collectionConceptId: SMAP.collectionConceptId,
        stagedFile: path.basename(file), sourceHistory, parserProduct: parsed.product },
      ingestionRunId: `smap-cumilla-${dateLabel}-${Date.now()}`, provenanceDatasetId: SMAP.datasetKey,
    });
  }
  if (!docs.length) throw new Error("No Cumilla orbit passed coordinate, value, and quality gates; zero database writes performed");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000, connectTimeoutMS: 8000 });
  try {
    await SmapObservation.init();
    const before = await SmapObservation.find({}).select("districtCode dateLabel orbit soilMoisture retrievalQualityFlag latitude longitude granuleId").lean();
    if (before.length !== 4) throw new Error(`Expected preserved SMAP baseline of 4; found ${before.length}; zero writes performed`);
    const beforeFingerprint = fingerprint(before);
    const result = await SmapObservation.bulkWrite(docs.map(doc => ({ updateOne: {
      filter: { districtCode: doc.districtCode, dateLabel: doc.dateLabel, orbit: doc.orbit },
      update: { $setOnInsert: doc }, upsert: true,
    }})), { ordered: true });
    const after = await SmapObservation.find({}).select("districtCode dateLabel orbit soilMoisture retrievalQualityFlag latitude longitude granuleId").lean();
    const baselineAfter = after.filter(doc => doc.dateLabel !== dateLabel);
    if (fingerprint(baselineAfter) !== beforeFingerprint) throw new Error("Existing SMAP records changed during insert-only write");
    const readback = await SmapObservation.find({ districtCode, dateLabel }).select("districtCode dateLabel orbit soilMoisture unit retrievalQualityFlag isRecommendedQuality latitude longitude geodesicDistanceKm granuleId sourceFileSha256 sourceUrl").lean();
    if (readback.length !== docs.length || readback.some(doc => ![0, 8].includes(doc.retrievalQualityFlag) || doc.isRecommendedQuality !== true)) {
      throw new Error("SMAP read-back did not match the validated recommended observations");
    }
    console.log(JSON.stringify({ dateLabel, districtCode, sourceGranuleId: producerGranuleId, sourceFileSha256: fileSha256,
      acceptedOrbits: docs.map(d => d.orbit), upserted: result.upsertedCount, matchedExisting: result.matchedCount,
      baselineCount: before.length, finalCount: after.length, baselinePreserved: fingerprint(baselineAfter) === beforeFingerprint,
      readback: readback.map(({ districtCode, dateLabel, orbit, soilMoisture, unit, retrievalQualityFlag, isRecommendedQuality, latitude, longitude, geodesicDistanceKm }) => ({ districtCode, dateLabel, orbit, soilMoisture, unit, retrievalQualityFlag, isRecommendedQuality, latitude, longitude, geodesicDistanceKm })) }));
  } finally { await mongoose.disconnect(); }
}

main().catch(error => { console.error(`SMAP validated-file ingestion stopped: ${error.message}`); process.exitCode = 1; });
