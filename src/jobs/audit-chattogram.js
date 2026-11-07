import "../config/env.config.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { District } from "../models/district.model.js";
import { NasaDataset } from "../models/nasadataset.model.js";
import { NasaObservation } from "../models/nasaobservation.model.js";

async function auditChattogram() {
  await connectDatabase({ required: true });

  // 1. Chattogram District Record
  const district = await District.findOne({ code: "chattogram" }).lean();

  // 2. Dataset Metadata
  const datasets = await NasaDataset.find({}).lean();

  // 3. Parameter counts, earliest/latest dates, quality flags
  const paramAggregation = await NasaObservation.aggregate([
    { $match: { districtCode: "chattogram" } },
    {
      $group: {
        _id: "$parameter",
        total: { $sum: 1 },
        earliestDate: { $min: "$dateLabel" },
        latestDate: { $max: "$dateLabel" },
        qualityOk: { $sum: { $cond: [{ $eq: ["$quality", "ok"] }, 1, 0] } },
        qualityMissing: { $sum: { $cond: [{ $eq: ["$quality", "missing"] }, 1, 0] } },
        qualityAbsent: { $sum: { $cond: [{ $eq: ["$quality", "absent"] }, 1, 0] } },
        sentinelCount: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$value", -999] },
                  { $eq: ["$value", -999.0] },
                  { $eq: ["$sentinelValue", -999] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // 4. Year-by-year counts (all params combined and PRECTOTCORR)
  const yearlyAggregation = await NasaObservation.aggregate([
    { $match: { districtCode: "chattogram" } },
    {
      $project: {
        year: { $substr: ["$dateLabel", 0, 4] },
        parameter: 1,
      },
    },
    {
      $group: {
        _id: "$year",
        totalObservations: { $sum: 1 },
        rainfallObservations: {
          $sum: { $cond: [{ $eq: ["$parameter", "PRECTOTCORR"] }, 1, 0] },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // 5. Duplicate check: identical (districtCode, parameter, dateLabel)
  const duplicateAggregation = await NasaObservation.aggregate([
    { $match: { districtCode: "chattogram" } },
    {
      $group: {
        _id: { parameter: "$parameter", dateLabel: "$dateLabel" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 },
  ]);

  // 6. Index check on NasaObservation
  const indexes = await NasaObservation.collection.indexes();

  const result = {
    district,
    datasets: datasets.map((d) => ({
      datasetKey: d.datasetKey,
      community: d.community,
      product: d.product,
      timeStandard: d.timeStandard,
      parameters: Object.keys(d.parameters || {}),
      coverage: d.coverage,
    })),
    parameterStats: paramAggregation,
    yearlyBreakdown: yearlyAggregation,
    duplicateCount: duplicateAggregation.length,
    duplicateSample: duplicateAggregation,
    indexes: indexes.map((idx) => ({ name: idx.name, key: idx.key, unique: idx.unique })),
  };

  console.log(JSON.stringify(result, null, 2));

  await disconnectDatabase();
}

auditChattogram().catch((err) => {
  console.error("Audit failed:", err.message);
  process.exit(1);
});
