/** GPM IMERG Final V07 point observations and validated Bangladesh-local summaries. */
import { DISTRICTS } from "../config/climate.config.js";
import { GPM } from "../config/gpm.config.js";
import { GpmObservation } from "../models/gpmobservation.model.js";
import { snapshotService } from "../services/snapshot.service.js";
import { summarizeGpmLocalDay } from "../services/nasa/gpm.validation.js";
import { errorResponse, successResponse } from "../utils/response.js";

const validDistricts = new Set(DISTRICTS.map(({ code }) => code));
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HISTORY_DAYS = 31;

function validateRequest(req, { dateRequired = false, range = false } = {}) {
  const district = String(req.query.district || "cumilla").trim().toLowerCase();
  if (!validDistricts.has(district)) return { error: [400, "INVALID_DISTRICT", "Unsupported district."] };
  const date = req.query.date;
  const from = req.query.from;
  const to = req.query.to;
  const validDay = (value) => ISO_DAY.test(value || "") && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (dateRequired && !validDay(date)) return { error: [400, "INVALID_DATE", "date must be a valid YYYY-MM-DD day."] };
  if (range && (!validDay(from) || !validDay(to))) return { error: [400, "INVALID_DATE_RANGE", "from and to must be valid YYYY-MM-DD days."] };
  if (range && from > to) return { error: [400, "INVALID_DATE_RANGE", "from cannot be after to."] };
  if (range && (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 >= MAX_HISTORY_DAYS) {
    return { error: [400, "DATE_RANGE_TOO_LARGE", `History range must be fewer than ${MAX_HISTORY_DAYS + 1} days.`] };
  }
  return { district, date, from, to };
}

function metadata(databaseConnected) {
  return {
    dataset: GPM.product,
    datasetKey: GPM.datasetKey,
    provider: GPM.provider,
    product: GPM.shortName,
    version: GPM.version,
    runType: GPM.runType,
    unit: GPM.precipitationUnit,
    spatialResolution: GPM.spatialResolution,
    temporalResolutionMinutes: GPM.temporalResolutionMinutes,
    timeStandard: "UTC source intervals; Bangladesh Standard Time UTC+06:00 reporting days",
    sourceUrl: GPM.documentationUrl,
    provenance: databaseConnected ? "HISTORICAL_DATABASE" : "UNAVAILABLE",
    databaseConnected,
    limitations: ["Regional grid point estimate, not a farm rain-gauge measurement.", "A daily total is withheld unless all 48 half-hour intervals are valid and unique."],
  };
}

export async function getLatestGpm(req, res, next) {
  try {
    const v = validateRequest(req);
    if (v.error) return errorResponse(res, ...v.error);
    if (!snapshotService.isDbConnected()) return errorResponse(res, 503, "GPM observations are unavailable while the database is disconnected.", "DATA_UNAVAILABLE", undefined, metadata(false));
    const districtFilter = { districtCode: v.district, datasetKey: GPM.datasetKey, runType: GPM.runType, productVersion: GPM.granuleVersion };
    const validObservationCount = await GpmObservation.countDocuments({
      ...districtFilter,
      sourceQuality: "valid",
      precipitationMm: { $type: "number", $gte: 0 },
    });
    if (validObservationCount === 0) return errorResponse(res, 503, "No valid GPM observations are stored for this district.", "DATA_NO_VALID_OBSERVATIONS", undefined, metadata(true));
    const latest = await GpmObservation.findOne(districtFilter).sort({ intervalStartUtc: -1 }).lean();
    if (!latest) return errorResponse(res, 503, "No GPM observations are stored for this district.", "DATA_NOT_INGESTED", undefined, metadata(true));
    if (latest.districtCode !== v.district) return errorResponse(res, 500, "GPM district isolation check failed.", "DATA_ISOLATION_VIOLATION", undefined, metadata(true));
    const dayDocs = await GpmObservation.find({ ...districtFilter, dateLabel: latest.dateLabel }).sort({ intervalStartUtc: 1 }).lean();
    if (dayDocs.some((doc) => doc.districtCode !== v.district)) return errorResponse(res, 500, "GPM district isolation check failed.", "DATA_ISOLATION_VIOLATION", undefined, metadata(true));
    return successResponse(res, 200, {
      districtCode: v.district,
      latestInterval: { observationDate: latest.dateLabel, intervalStartUtc: latest.intervalStartUtc, intervalEndUtc: latest.intervalEndUtc, precipitationRateMmHr: latest.precipitationRateMmHr, precipitationMm: latest.precipitationMm, quality: latest.sourceQuality, ingestedAt: latest.createdAt },
      latestDailySummary: summarizeGpmLocalDay(v.district, latest.dateLabel, dayDocs),
    }, metadata(true));
  } catch (error) { next(error); }
}

export async function getGpmDaily(req, res, next) {
  try {
    const v = validateRequest(req, { dateRequired: true });
    if (v.error) return errorResponse(res, ...v.error);
    if (!snapshotService.isDbConnected()) return errorResponse(res, 503, "GPM observations are unavailable while the database is disconnected.", "DATA_UNAVAILABLE", undefined, metadata(false));
    const docs = await GpmObservation.find({ districtCode: v.district, dateLabel: v.date }).sort({ intervalStartUtc: 1 }).lean();
    const summary = summarizeGpmLocalDay(v.district, v.date, docs);
    return successResponse(res, 200, { ...summary, ingestedAt: docs.reduce((latest, row) => row.createdAt && (!latest || row.createdAt > latest) ? row.createdAt : latest, null) }, metadata(true));
  } catch (error) { next(error); }
}

export async function getGpmHistory(req, res, next) {
  try {
    const v = validateRequest(req, { range: true });
    if (v.error) return errorResponse(res, ...v.error);
    if (!snapshotService.isDbConnected()) return errorResponse(res, 503, "GPM observations are unavailable while the database is disconnected.", "DATA_UNAVAILABLE", undefined, metadata(false));
    const docs = await GpmObservation.find({ districtCode: v.district, dateLabel: { $gte: v.from, $lte: v.to } }).sort({ intervalStartUtc: 1 }).limit(MAX_HISTORY_DAYS * 48).lean();
    const docsByDate = new Map();
    for (const row of docs) {
      if (!docsByDate.has(row.dateLabel)) docsByDate.set(row.dateLabel, []);
      docsByDate.get(row.dateLabel).push(row);
    }
    const days = [];
    for (let cursor = new Date(`${v.from}T00:00:00Z`), end = new Date(`${v.to}T00:00:00Z`); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const dateLabel = cursor.toISOString().slice(0, 10);
      days.push(summarizeGpmLocalDay(v.district, dateLabel, docsByDate.get(dateLabel) || []));
    }
    return successResponse(res, 200, { districtCode: v.district, from: v.from, to: v.to, dailySummaries: days, intervals: docs.map((d) => ({ observationDate: d.dateLabel, intervalStartUtc: d.intervalStartUtc, intervalEndUtc: d.intervalEndUtc, precipitationRateMmHr: d.precipitationRateMmHr, precipitationMm: d.precipitationMm, quality: d.sourceQuality, ingestedAt: d.createdAt })) }, metadata(true));
  } catch (error) { next(error); }
}
