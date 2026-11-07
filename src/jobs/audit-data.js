import "../config/env.config.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { District } from "../models/district.model.js";
import { NasaDataset } from "../models/nasadataset.model.js";
import { NasaObservation } from "../models/nasaobservation.model.js";
import { DataIngestionLog } from "../models/dataingestionlog.model.js";
import { DISTRICTS, PARAMETER_NAMES, PARAMETER_CATALOG } from "../config/climate.config.js";

async function runAudit() {
  const conn = await connectDatabase();
  if (!conn.connected) {
    console.error("DB connection failed:", conn.reason);
    process.exit(1);
  }

  console.log("=== MONGODB DATA AUDIT REPORT ===");

  // 1. Total counts
  const totalObs = await NasaObservation.countDocuments();
  console.log(`Total NasaObservation documents: ${totalObs}`);

  // 2. District counts & coordinates
  const districts = await District.find({}).lean();
  console.log(`\nDistricts registered: ${districts.length}`);
  for (const d of districts) {
    const obsCount = await NasaObservation.countDocuments({ districtCode: d.code });
    console.log(`  [${d.code}] ${d.nameEn} (${d.nameBn}): lat=${d.latitude}, lon=${d.longitude}, obsCount=${obsCount}`);
  }

  // 3. Per parameter counts for each district
  console.log("\nPer-parameter counts per district:");
  for (const d of districts) {
    console.log(`\n  District: ${d.code}`);
    for (const p of PARAMETER_NAMES) {
      const pCount = await NasaObservation.countDocuments({ districtCode: d.code, parameter: p });
      const sample = await NasaObservation.findOne({ districtCode: d.code, parameter: p }).lean();
      console.log(`    ${p.padEnd(20)}: ${pCount} records | unit: "${sample?.unit}" (catalog: "${PARAMETER_CATALOG[p].unit}")`);
    }
  }

  // 4. Date ranges & duplicates check
  console.log("\nDate ranges and duplicate verification:");
  for (const d of districts) {
    const [first, last] = await Promise.all([
      NasaObservation.findOne({ districtCode: d.code }).sort({ dateLabel: 1 }).lean(),
      NasaObservation.findOne({ districtCode: d.code }).sort({ dateLabel: -1 }).lean(),
    ]);
    console.log(`  ${d.code}: range ${first?.dateLabel} to ${last?.dateLabel}`);

    // Check duplicates via aggregation
    const dupes = await NasaObservation.aggregate([
      { $match: { districtCode: d.code } },
      { $group: { _id: { p: "$parameter", dl: "$dateLabel" }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 5 },
    ]);
    console.log(`  ${d.code} duplicate keys: ${dupes.length}`);
  }

  // 5. Quality flags and timeStandard consistency
  console.log("\nQuality flags distribution:");
  const qualities = await NasaObservation.aggregate([
    { $group: { _id: "$quality", count: { $sum: 1 } } },
  ]);
  for (const q of qualities) {
    console.log(`  quality "${q._id}": ${q.count}`);
  }

  console.log("\nTime standard consistency:");
  const timeStandards = await NasaObservation.aggregate([
    { $group: { _id: "$timeStandard", count: { $sum: 1 } } },
  ]);
  for (const ts of timeStandards) {
    console.log(`  timeStandard "${ts._id}": ${ts.count}`);
  }

  // 6. Dataset Provenance record
  const ds = await NasaDataset.findById("nasa:power:daily:point").lean();
  console.log("\nDataset Provenance:");
  console.log(`  _id: ${ds?._id}`);
  console.log(`  product: ${ds?.product}`);
  console.log(`  timeStandard: ${ds?.timeStandard}`);
  console.log(`  timeStandardDisclosure: ${ds?.timeStandardDisclosure}`);
  console.log(`  coverage:`, ds?.coverage);

  // 7. Ingestion Logs
  const latestLog = await DataIngestionLog.findOne({ status: "completed" }).sort({ createdAt: -1 }).lean();
  console.log("\nLatest Ingestion Log:");
  console.log(`  runId: ${latestLog?.runId}`);
  console.log(`  status: ${latestLog?.status}`);
  console.log(`  actualRange:`, latestLog?.actualRange);
  console.log(`  spansTotal: ${latestLog?.counts?.spansTotal}, spansSuccess: ${latestLog?.counts?.spansSuccess}`);
  console.log(`  observationsUpserted: ${latestLog?.counts?.observationsUpserted}`);

  await disconnectDatabase();
}

runAudit().catch(err => {
  console.error("Audit error:", err);
  process.exit(1);
});
