/**
 * Read-only MongoDB data audit. This file intentionally uses query/aggregate
 * operations only; it does not create collections or indexes.
 *
 * Run from server/ only in an environment with MongoDB access and a read-only
 * database user: node src/jobs/audit-data-readonly.js
 */
import "../config/env.config.js";
import mongoose from "mongoose";
import { DISTRICTS, PARAMETER_NAMES, POWER, TARGET_RANGE } from "../config/climate.config.js";

// Prevent Mongoose model initialization from auto-creating collections/indexes.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const { connectDatabase, disconnectDatabase } = await import("../config/database.js");
const { District } = await import("../models/district.model.js");
const { NasaDataset } = await import("../models/nasadataset.model.js");
const { NasaObservation } = await import("../models/nasaobservation.model.js");
const { DataIngestionLog } = await import("../models/dataingestionlog.model.js");

const TARGET_START_YEAR = Number(TARGET_RANGE.start.slice(0, 4));
const TARGET_END_YEAR = Number(TARGET_RANGE.end.slice(0, 4));
const expectedDaysInYear = (year) =>
  new Date(Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)).getTime() / 86_400_000;

const mapToObject = (value) => {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, mapToObject(item)]));
  if (Array.isArray(value)) return value.map(mapToObject);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapToObject(item)]));
  }
  return value;
};

async function buildAudit() {
  const [districtDocs, datasetDocs, observationTotals, byQuality, byYearParameter, dateRanges, duplicateKeys, indexes, recentRuns] = await Promise.all([
    District.find({}).select("code nameEn nameBn latitude longitude isDefault enabled coordinateSource createdAt updatedAt").sort({ code: 1 }).lean(),
    NasaDataset.find({}).select("datasetKey product provider endpoint community apiVersionAtLastIngest sources parameters fillValue timeStandard timeStandardDisclosure spatialResolutionNote coverage createdAt updatedAt").sort({ datasetKey: 1 }).lean(),
    NasaObservation.aggregate([
      { $group: { _id: { districtCode: "$districtCode", datasetKey: "$datasetKey", parameter: "$parameter" }, count: { $sum: 1 } } },
      { $sort: { "_id.districtCode": 1, "_id.datasetKey": 1, "_id.parameter": 1 } },
    ]),
    NasaObservation.aggregate([
      { $group: {
        _id: { districtCode: "$districtCode", datasetKey: "$datasetKey", parameter: "$parameter", quality: "$quality" },
        count: { $sum: 1 },
        nullValueCount: { $sum: { $cond: [{ $eq: [{ $ifNull: ["$value", null] }, null] }, 1, 0] } },
        sentinelValueCount: { $sum: { $cond: [{ $ne: [{ $ifNull: ["$sentinelValue", null] }, null] }, 1, 0] } },
        validButNullCount: { $sum: { $cond: [{ $and: [{ $eq: ["$quality", "ok"] }, { $eq: [{ $ifNull: ["$value", null] }, null] }] }, 1, 0] } },
        validButSentinelLikeCount: { $sum: { $cond: [{ $and: [{ $eq: ["$quality", "ok"] }, { $lte: ["$value", -900] }] }, 1, 0] } },
      } },
      { $sort: { "_id.districtCode": 1, "_id.datasetKey": 1, "_id.parameter": 1, "_id.quality": 1 } },
    ]),
    NasaObservation.aggregate([
      { $project: {
        districtCode: 1, datasetKey: 1, parameter: 1, dateLabel: 1, quality: 1,
        year: { $substrBytes: ["$dateLabel", 0, 4] },
      } },
      { $group: {
        _id: { districtCode: "$districtCode", datasetKey: "$datasetKey", parameter: "$parameter", year: "$year" },
        documents: { $sum: 1 },
        qualityOkRows: { $sum: { $cond: [{ $eq: ["$quality", "ok"] }, 1, 0] } },
        valid: { $sum: { $cond: [{ $and: [
          { $eq: ["$quality", "ok"] },
          { $ne: [{ $ifNull: ["$value", null] }, null] },
          { $gt: ["$value", -900] },
        ] }, 1, 0] } },
        missingSentinel: { $sum: { $cond: [{ $eq: ["$quality", "missing_sentinel"] }, 1, 0] } },
        absent: { $sum: { $cond: [{ $eq: ["$quality", "absent"] }, 1, 0] } },
      } },
      { $sort: { "_id.districtCode": 1, "_id.datasetKey": 1, "_id.parameter": 1, "_id.year": 1 } },
    ]),
    NasaObservation.aggregate([
      { $group: {
        _id: { districtCode: "$districtCode", datasetKey: "$datasetKey", parameter: "$parameter" },
        firstDate: { $min: "$dateLabel" }, lastDate: { $max: "$dateLabel" },
        timeStandards: { $addToSet: "$timeStandard" }, units: { $addToSet: "$unit" },
      } },
      { $sort: { "_id.districtCode": 1, "_id.datasetKey": 1, "_id.parameter": 1 } },
    ]),
    NasaObservation.aggregate([
      { $group: {
        _id: { districtCode: "$districtCode", parameter: "$parameter", dateLabel: "$dateLabel" },
        documents: { $sum: 1 }, datasetKeys: { $addToSet: "$datasetKey" },
      } },
      { $match: { documents: { $gt: 1 } } },
      { $sort: { "_id.districtCode": 1, "_id.parameter": 1, "_id.dateLabel": 1 } },
    ]),
    NasaObservation.collection.indexes().catch((error) => [{ auditReadError: error.name || "IndexReadError", code: error.code || null }]),
    DataIngestionLog.find({}).select("runId datasetKey kind status requestedRange actualRange districtCodes parameters counts apiVersionEchoed timeStandardEchoed startedAt finishedAt durationMs").sort({ startedAt: -1 }).limit(25).lean(),
  ]);

  const observedYearGroups = new Map(byYearParameter.map((row) => {
    const { districtCode, datasetKey, parameter, year } = row._id;
    return [`${districtCode}|${datasetKey}|${parameter}|${year}`, row];
  }));
  const datasetKeys = new Set([POWER.datasetKey, ...datasetDocs.map((row) => row.datasetKey), ...byYearParameter.map((row) => row._id.datasetKey)]);
  const coverageByYearParameter = [];
  for (const district of DISTRICTS) {
    for (const datasetKey of datasetKeys) {
      for (const parameter of PARAMETER_NAMES) {
        for (let year = TARGET_START_YEAR; year <= TARGET_END_YEAR; year += 1) {
          const expectedDays = expectedDaysInYear(year);
          const row = observedYearGroups.get(`${district.code}|${datasetKey}|${parameter}|${year}`);
          const documents = row?.documents || 0;
          const qualityOkRows = row?.qualityOkRows || 0;
          const valid = row?.valid || 0;
          const missingSentinel = row?.missingSentinel || 0;
          const absent = row?.absent || 0;
          coverageByYearParameter.push({
            districtCode: district.code, datasetKey, parameter, year, expectedDays,
            documents, qualityOkRows,
            inconsistentQualityRows: Math.max(0, qualityOkRows - valid),
            otherQualityRows: Math.max(0, documents - qualityOkRows - missingSentinel - absent),
            missingRecordDays: Math.max(0, expectedDays - documents),
            extraRecords: Math.max(0, documents - expectedDays),
            valid, missingSentinel, absent,
            validCoveragePercent: Number(((valid / expectedDays) * 100).toFixed(2)),
            recordCoveragePercent: Number(((documents / expectedDays) * 100).toFixed(2)),
            completeAt90Percent: valid / expectedDays >= 0.9,
          });
        }
      }
    }
  }

  const currentUniqueIndexKeys = indexes
    .filter((index) => index.unique)
    .map((index) => ({ name: index.name, key: index.key }));

  return {
    audit: "read-only",
    generatedAt: new Date().toISOString(),
    configuredTargetRange: { start: TARGET_RANGE.start, end: TARGET_RANGE.end },
    configuredDataset: { datasetKey: POWER.datasetKey, community: POWER.community, parameters: PARAMETER_NAMES },
    configuredDistricts: DISTRICTS,
    districts: districtDocs,
    datasets: datasetDocs.map(mapToObject),
    observationTotalsByDistrictDatasetParameter: observationTotals,
    observationDateRangesByDistrictDatasetParameter: dateRanges,
    qualityAndValueIntegrityByDistrictDatasetParameter: byQuality,
    coverageByYearParameter,
    duplicateCurrentKeyGroups: duplicateKeys,
    indexes: {
      readOnlyInspectionResult: indexes,
      uniqueIndexes: currentUniqueIndexKeys,
      currentSchemaUniqueKey: ["districtCode", "parameter", "dateLabel"],
      potentialCollisionRule: "Any duplicateCurrentKeyGroups entry with multiple datasetKeys indicates sources collide on the current unique-key shape.",
    },
    recentIngestionRuns: recentRuns,
  };
}

let connected = false;
try {
  await connectDatabase({ required: true });
  connected = true;
  const report = await buildAudit();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  // Do not print raw driver messages: some driver errors include connection details.
  process.stderr.write(`Read-only audit failed; type=${error.name || "Error"}; code=${error.code || "none"}. See the sanitized database connection log for connection failures.\n`);
  process.exitCode = 1;
} finally {
  if (connected) await disconnectDatabase();
}
