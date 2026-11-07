/**
 * NASA POWER Ingestion Service.
 *
 * Implements:
 * - Chunked sequential ingestion (default annual chunks) with bounded retries.
 * - Idempotent upserts into `nasaobservations` with unique compound index
 *   ({ districtCode, parameter, dateLabel }).
 * - Explicit quality classification: values are stored ONLY for `ok`. Missing/sentinel
 *   values are flagged as `missing_sentinel` or `absent`, NEVER converted to 0.
 * - Resumable workflow: checks existing stored spans in MongoDB to avoid repeated requests.
 * - Append-only ingestion journal in `dataingestionlogs`.
 * - Coverage aggregation per district and per parameter.
 */
import crypto from "node:crypto";
import { DISTRICTS, PARAMETER_CATALOG, PARAMETER_NAMES, POWER, TARGET_RANGE } from "../../config/climate.config.js";
import { District } from "../../models/district.model.js";
import { NasaDataset } from "../../models/nasadataset.model.js";
import { NasaObservation } from "../../models/nasaobservation.model.js";
import { ensurePowerDatasetProvenance } from "./dataset.registry.js";
import { closeIngestionRun, openIngestionRun, recordSpan } from "./ingestion.logger.js";
import { fetchPowerChunk } from "./power.client.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Splits an ISO range [startIso, endIso] into calendar-year chunks.
 * e.g. "2001-01-01".."2002-12-31" -> [ { startIso: "2001-01-01", endIso: "2001-12-31" }, ... ]
 */
export function generateYearChunks(startIso = TARGET_RANGE.start, endIso = TARGET_RANGE.end) {
  const startYear = parseInt(startIso.slice(0, 4), 10);
  const endYear = parseInt(endIso.slice(0, 4), 10);
  const chunks = [];

  for (let year = startYear; year <= endYear; year += 1) {
    const chunkStart = year === startYear ? startIso : `${year}-01-01`;
    const chunkEnd = year === endYear ? endIso : `${year}-12-31`;
    chunks.push({ startIso: chunkStart, endIso: chunkEnd, year });
  }

  return chunks;
}

/**
 * Checks if a date chunk has already been ingested for a given district and parameters.
 * A chunk is complete ONLY if all requested parameters have all expected calendar days accounted for.
 */
export async function isChunkAlreadyIngested(districtCode, startIso, endIso, parameters = PARAMETER_NAMES) {
  const startUtc = new Date(`${startIso}T00:00:00.000Z`);
  const endUtc = new Date(`${endIso}T00:00:00.000Z`);
  const expectedDays = Math.round((endUtc - startUtc) / 86400000) + 1;

  const counts = await NasaObservation.aggregate([
    {
      $match: {
        districtCode,
        parameter: { $in: parameters },
        date: { $gte: startUtc, $lte: endUtc },
      },
    },
    {
      $group: {
        _id: "$parameter",
        count: { $sum: 1 },
      },
    },
  ]);

  if (counts.length < parameters.length) return false;
  return counts.every((c) => c.count >= expectedDays);
}

/**
 * Ingests a single chunk of NASA POWER data for a district.
 */
export async function ingestChunk({ district, parameters = PARAMETER_NAMES, startIso, endIso, runId }) {
  const startTime = Date.now();
  const fetchResult = await fetchPowerChunk({
    latitude: district.latitude,
    longitude: district.longitude,
    parameters,
    startIso,
    endIso,
  });

  if (!fetchResult.ok) {
    await recordSpan(runId, {
      startLabel: startIso,
      endLabel: endIso,
      status: "failed",
      attempts: fetchResult.attempts,
      httpStatus: fetchResult.httpStatus,
      stored: 0,
      errorMessage: fetchResult.error,
      durationMs: Date.now() - startTime,
    });
    return { ok: false, error: fetchResult.error, stored: 0 };
  }

  const { data } = fetchResult;
  const bulkOps = [];
  let upsertCount = 0;

  for (const param of parameters) {
    const series = data.series[param] || {};
    const unit = PARAMETER_CATALOG[param]?.unit || data.units[param]?.units || "unknown";

    for (const [dateLabel, obs] of Object.entries(series)) {
      const dateUtc = new Date(`${dateLabel}T00:00:00.000Z`);
      const updateDoc = {
        districtCode: district.code,
        parameter: param,
        datasetKey: POWER.datasetKey,
        dateLabel,
        date: dateUtc,
        timeStandard: POWER.timeStandard,
        unit,
        quality: obs.quality,
        value: obs.quality === "ok" ? obs.value : null,
        sentinelValue: obs.quality === "missing_sentinel" ? obs.sentinelValue : null,
        inverseDistanceElevation: data.geometryEchoed?.[2] ?? null,
        ingestionRunId: runId,
        provenanceDatasetId: POWER.datasetKey,
      };

      bulkOps.push({
        updateOne: {
          filter: { districtCode: district.code, parameter: param, dateLabel },
          update: { $set: updateDoc },
          upsert: true,
        },
      });
      upsertCount += 1;
    }
  }

  if (bulkOps.length > 0) {
    // Execute in batches of 1000 to respect MongoDB connection constraints
    const batchSize = 1000;
    for (let i = 0; i < bulkOps.length; i += batchSize) {
      const batch = bulkOps.slice(i, i + batchSize);
      await NasaObservation.bulkWrite(batch, { ordered: false });
    }
  }

  const durationMs = Date.now() - startTime;
  await recordSpan(runId, {
    startLabel: startIso,
    endLabel: endIso,
    returnedStartLabel: data.header.start ? `${data.header.start.slice(0, 4)}-${data.header.start.slice(4, 6)}-${data.header.start.slice(6, 8)}` : startIso,
    returnedEndLabel: data.header.end ? `${data.header.end.slice(0, 4)}-${data.header.end.slice(4, 6)}-${data.header.end.slice(6, 8)}` : endIso,
    status: "success",
    attempts: fetchResult.attempts,
    httpStatus: 200,
    stored: upsertCount,
    perParameter: data.perParameter,
    apiVersion: data.header.apiVersion,
    timeStandard: data.header.timeStandard,
    durationMs,
  });

  return {
    ok: true,
    stored: upsertCount,
    days: data.expectedDayCount,
    durationMs,
  };
}

/**
 * Runs an ingestion workflow across specified districts and date range.
 * Supports resume mode to skip already populated chunks.
 */
export async function runIngestionWorkflow({
  districtCodes = DISTRICTS.map((d) => d.code),
  parameters = PARAMETER_NAMES,
  startIso = TARGET_RANGE.start,
  endIso = TARGET_RANGE.end,
  chunks = null,
  resume = true,
  onProgress = null,
}) {
  await ensurePowerDatasetProvenance();

  const runId = `run_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const targetDistricts = DISTRICTS.filter((d) => districtCodes.includes(d.code));

  if (targetDistricts.length === 0) {
    throw new Error(`No valid districts found for codes: ${districtCodes.join(", ")}`);
  }

  await openIngestionRun({
    runId,
    requestedRange: { start: startIso, end: endIso },
    districtCodes,
    parameters,
    kind: "ingestion",
  });

  const chunkList = chunks || generateYearChunks(startIso, endIso);
  let totalStored = 0;
  let totalChunksProcessed = 0;
  let totalChunksSkipped = 0;
  let failedChunks = 0;

  try {
    for (const district of targetDistricts) {
      for (const chunk of chunkList) {
        if (resume) {
          const alreadyIngested = await isChunkAlreadyIngested(
            district.code,
            chunk.startIso,
            chunk.endIso,
            parameters
          );
          if (alreadyIngested) {
            totalChunksSkipped += 1;
            if (onProgress) {
              onProgress({
                district: district.code,
                chunk,
                status: "skipped",
                reason: "already_ingested",
              });
            }
            continue;
          }
        }

        const res = await ingestChunk({
          district,
          parameters,
          startIso: chunk.startIso,
          endIso: chunk.endIso,
          runId,
        });

        if (res.ok) {
          totalStored += res.stored;
          totalChunksProcessed += 1;
          if (onProgress) {
            onProgress({
              district: district.code,
              chunk,
              status: "success",
              stored: res.stored,
              durationMs: res.durationMs,
            });
          }
        } else {
          failedChunks += 1;
          if (onProgress) {
            onProgress({
              district: district.code,
              chunk,
              status: "failed",
              error: res.error,
            });
          }
        }

        // Polite delay between NASA requests to avoid 429 rate limiting
        await sleep(POWER.interChunkDelayMs);
      }
    }

    const finalStatus = failedChunks === 0 ? "completed" : totalChunksProcessed > 0 ? "partial" : "failed";
    await closeIngestionRun(runId, finalStatus, failedChunks > 0 ? `${failedChunks} chunks failed` : null);

    // Refresh dataset coverage metadata
    await updateDatasetCoverage(POWER.datasetKey);

    return {
      runId,
      status: finalStatus,
      totalStored,
      totalChunksProcessed,
      totalChunksSkipped,
      failedChunks,
    };
  } catch (error) {
    await closeIngestionRun(runId, "failed", error.message);
    throw error;
  }
}

/**
 * Updates coverage timestamp and boundary dates on the NasaDataset record.
 */
export async function updateDatasetCoverage(datasetKey = POWER.datasetKey) {
  const [firstObs, lastObs] = await Promise.all([
    NasaObservation.findOne({ datasetKey }).sort({ date: 1 }).lean(),
    NasaObservation.findOne({ datasetKey }).sort({ date: -1 }).lean(),
  ]);

  if (firstObs && lastObs) {
    await NasaDataset.updateOne(
      { _id: datasetKey },
      {
        $set: {
          "coverage.firstObservedDate": firstObs.date,
          "coverage.lastObservedDate": lastObs.date,
          "coverage.lastVerifiedAt": new Date(),
        },
      }
    );
  }
}

/**
 * Generates detailed coverage statistics for a district across all approved parameters.
 */
export async function generateCoverageReport(districtCode) {
  const report = {
    districtCode,
    parameters: {},
    overall: {
      totalObservations: 0,
      okCount: 0,
      sentinelCount: 0,
      absentCount: 0,
      firstDate: null,
      lastDate: null,
    },
  };

  for (const param of PARAMETER_NAMES) {
    const stats = await NasaObservation.aggregate([
      { $match: { districtCode, parameter: param } },
      {
        $group: {
          _id: "$quality",
          count: { $sum: 1 },
          minDate: { $min: "$dateLabel" },
          maxDate: { $max: "$dateLabel" },
        },
      },
    ]);

    let okCount = 0;
    let sentinelCount = 0;
    let absentCount = 0;
    let minDate = null;
    let maxDate = null;

    for (const s of stats) {
      if (s._id === "ok") okCount = s.count;
      else if (s._id === "missing_sentinel") sentinelCount = s.count;
      else if (s._id === "absent") absentCount = s.count;

      if (!minDate || (s.minDate && s.minDate < minDate)) minDate = s.minDate;
      if (!maxDate || (s.maxDate && s.maxDate > maxDate)) maxDate = s.maxDate;
    }

    const total = okCount + sentinelCount + absentCount;
    report.parameters[param] = {
      total,
      okCount,
      sentinelCount,
      absentCount,
      coveragePercent: total > 0 ? Number(((okCount / total) * 100).toFixed(2)) : 0,
      firstDate: minDate,
      lastDate: maxDate,
      unit: PARAMETER_CATALOG[param]?.unit || "unknown",
    };

    report.overall.totalObservations += total;
    report.overall.okCount += okCount;
    report.overall.sentinelCount += sentinelCount;
    report.overall.absentCount += absentCount;
    if (!report.overall.firstDate || (minDate && minDate < report.overall.firstDate)) {
      report.overall.firstDate = minDate;
    }
    if (!report.overall.lastDate || (maxDate && maxDate > report.overall.lastDate)) {
      report.overall.lastDate = maxDate;
    }
  }

  return report;
}
