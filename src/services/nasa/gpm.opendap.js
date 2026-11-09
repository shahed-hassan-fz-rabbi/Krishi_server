import crypto from "node:crypto";
import { GPM } from "../../config/gpm.config.js";
import { validateGpmObservation } from "./gpm.validation.js";

const EPOCH_1980_MS = Date.UTC(1980, 0, 6);
const FIELDS = [
  "precipitation",
  "precipitationQualityIndex",
  "randomError",
  "probabilityLiquidPrecipitation",
];

function numericList(value) {
  return value.split(",").map(token => Number(token.trim()));
}

export function parseGpmOpendapAscii(body, { granuleId, cmrUpdated = null, sourceUrl = null }) {
  if (typeof body !== "string" || !body.startsWith(`Dataset: ${granuleId}`)) {
    throw new Error("OPeNDAP response dataset header does not match the requested granule");
  }

  const variableRows = new Map();
  for (const line of body.split(/\r?\n/).slice(1)) {
    const match = line.match(/^([A-Za-z]\w*)((?:\[\d+\])*)\s*,\s*(.*)$/);
    if (!match) continue;
    const [, name, indexText, valuesText] = match;
    const indexes = [...indexText.matchAll(/\[(\d+)\]/g)].map(x => Number(x[1]));
    if (!variableRows.has(name)) variableRows.set(name, new Map());
    variableRows.get(name).set(indexes.join(":"), numericList(valuesText));
  }

  const row = (name, indexes = []) => variableRows.get(name)?.get(indexes.join(":"));
  const longitudes = row("lon");
  const latitudes = row("lat");
  const time = (row("time") || row("time", [0]))?.[0];
  const timeBounds = row("time_bnds", [0]);
  if (!longitudes || longitudes.length !== 8 || !latitudes || latitudes.length !== 12) {
    throw new Error("OPeNDAP coordinates do not match the expected bounded 8x12 subset");
  }
  if (!Number.isFinite(time) || !timeBounds || timeBounds.length !== 2) {
    throw new Error("OPeNDAP response is missing UTC time metadata");
  }

  for (const field of FIELDS) {
    const rows = variableRows.get(field);
    if (!rows || rows.size !== 8 || [...rows.values()].some(values => values.length !== 12)) {
      throw new Error(`OPeNDAP field ${field} is incomplete for the expected 8x12 region`);
    }
  }

  const startUtc = new Date(EPOCH_1980_MS + time * 1000);
  const startSeconds = timeBounds[0];
  const endSeconds = timeBounds[1];
  if (startSeconds !== time || endSeconds - startSeconds !== 1800) {
    throw new Error("OPeNDAP time bounds are not one expected half-hour interval");
  }

  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const observations = [];
  for (const [districtCode, target] of Object.entries(GPM.districtGridTargets)) {
    const lonOffset = nearestIndex(longitudes, target.longitude);
    const latOffset = nearestIndex(latitudes, target.latitude);
    const read = field => variableRows.get(field).get(`0:${lonOffset}`)[latOffset];
    const rawRate = read("precipitation");
    const rate = isFill(rawRate, GPM.precipitationFillValue) ? null : rawRate;
    const rawQuality = read("precipitationQualityIndex");
    const rawError = read("randomError");
    const rawProbability = read("probabilityLiquidPrecipitation");
    const item = {
      districtCode,
      dateLabel: new Date(startUtc.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10),
      intervalStartUtc: startUtc.toISOString(),
      intervalEndUtc: new Date(EPOCH_1980_MS + endSeconds * 1000).toISOString(),
      precipitationRateMmHr: rate,
      precipitationMm: rate === null ? null : rate * 0.5,
      randomErrorMmHr: isFill(rawError, GPM.randomErrorFillValue) ? null : rawError,
      precipitationQualityIndex: isFill(rawQuality, GPM.qualityIndexFillValue) ? null : rawQuality,
      probabilityLiquidPrecipitationPercent: isFill(rawProbability, GPM.probabilityLiquidFillValue) ? null : rawProbability,
      sourceQuality: rate === null ? "missing_fill" : "valid",
      latitude: latitudes[latOffset],
      longitude: longitudes[lonOffset],
      targetReferenceLat: target.latitude,
      targetReferenceLon: target.longitude,
      geodesicDistanceKm: haversineKm(target.latitude, target.longitude, latitudes[latOffset], longitudes[lonOffset]),
    };
    const validation = validateGpmObservation(item);
    if (!validation.valid) throw new Error(`GPM ${districtCode} observation rejected: ${validation.reason}`);
    observations.push(item);
  }

  return {
    observations,
    timeStartUtc: startUtc.toISOString(),
    timeEndUtc: new Date(EPOCH_1980_MS + endSeconds * 1000).toISOString(),
    responseSha256: digest,
    cmrUpdated: cmrUpdated ? new Date(cmrUpdated) : null,
    sourceUrl,
  };
}

export function buildGpmOpendapUrl(granule) {
  const id = granule.producer_granule_id;
  const match = id.match(/^3B-HHR\.MS\.MRG\.3IMERG\.(\d{4})(\d{2})(\d{2})-S\d{6}-E\d{6}\.\d{4}\.V07B\.HDF5$/);
  if (!match) throw new Error("CMR granule is not the expected GPM IMERG Final V07B product");
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const doy = String(Math.floor((date - Date.UTC(Number(year), 0, 0)) / 86400000)).padStart(3, "0");
  const filePath = `${GPM.opendapBaseUrl}/GPM_L3/GPM_3IMERGHH.07/${year}/${doy}/${id}.ascii`;
  const subset = GPM.regionalSubset;
  const constraints = FIELDS.map(field =>
    `${field}[0][${subset.lonStart}:${subset.lonEnd}][${subset.latStart}:${subset.latEnd}]`
  );
  constraints.push(`time[0]`, `time_bnds[0][0:1]`);
  constraints.push(`lon[${subset.lonStart}:${subset.lonEnd}]`, `lat[${subset.latStart}:${subset.latEnd}]`);
  const url = new URL(filePath);
  url.search = constraints.join(",");
  return url.toString();
}

function nearestIndex(values, target) {
  let index = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (Math.abs(values[i] - target) < Math.abs(values[index] - target)) index = i;
  }
  return index;
}

function isFill(value, fill) {
  return !Number.isFinite(value) || Math.abs(value - fill) <= 0.001;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
