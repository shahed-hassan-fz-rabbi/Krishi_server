/**
 * Controlled SMAP Ingestion Job.
 * Ingests exactly the 4 scientifically validated NASA SMAP observations
 * into the 'smapobservations' collection using idempotent upsert.
 */

import dotenv from "dotenv";
import mongoose from "mongoose";
import { SmapObservation } from "../models/smapobservation.model.js";

dotenv.config();

const VERIFIED_FOUR_RECORDS = [
  {
    districtCode: "cumilla",
    dateLabel: "2024-01-02",
    date: new Date("2024-01-02T00:00:00.000Z"),
    orbit: "AM",
    soilMoisture: 0.3003,
    soilMoistureDca: 0.3003,
    unit: "m^3/m^3",
    retrievalQualityFlag: 8,
    isRecommendedQuality: true,
    qualityClassification: "recommended",
    surfaceFlag: 128,
    qaBits: {
      bit0NotRecommended: false,
      bit1NotAttempted: false,
      bit2NotSuccessful: false,
      bit3FreezeThawUnsuccessful: true,
      rawFlag: 8,
    },
    surfaceTemperatureK: 294.29,
    freezeThawFraction: -9999.0,
    bulkDensity: 1.2319,
    clayFraction: 0.3129,
    staticWaterFraction: 0.001159,
    radarWaterFraction: 0.001159,
    soilPorosity: 0.5351,
    latitude: 23.477951,
    longitude: 91.167015,
    targetReferenceLat: 23.46186,
    targetReferenceLon: 91.18503,
    geodesicDistanceKm: 2.56,
    adminPolygonPcode: "BD2019",
    datasetKey: "nasa:smap:spl3smp_e:v006",
    granuleId: "SMAP_L3_SM_P_E_20240102_R19240_001.h5",
    ingestionRunId: "smap-phase1-verified-ingest-v1",
    provenanceDatasetId: "nasa:smap:spl3smp_e:v006",
  },
  {
    districtCode: "cumilla",
    dateLabel: "2024-01-03",
    date: new Date("2024-01-03T00:00:00.000Z"),
    orbit: "AM",
    soilMoisture: 0.4259,
    soilMoistureDca: 0.4259,
    unit: "m^3/m^3",
    retrievalQualityFlag: 8,
    isRecommendedQuality: true,
    qualityClassification: "recommended",
    surfaceFlag: 128,
    qaBits: {
      bit0NotRecommended: false,
      bit1NotAttempted: false,
      bit2NotSuccessful: false,
      bit3FreezeThawUnsuccessful: true,
      rawFlag: 8,
    },
    surfaceTemperatureK: 293.85,
    freezeThawFraction: -9999.0,
    bulkDensity: 1.2319,
    clayFraction: 0.3129,
    staticWaterFraction: 0.001159,
    radarWaterFraction: 0.001159,
    soilPorosity: 0.5351,
    latitude: 23.477951,
    longitude: 91.167015,
    targetReferenceLat: 23.46186,
    targetReferenceLon: 91.18503,
    geodesicDistanceKm: 2.56,
    adminPolygonPcode: "BD2019",
    datasetKey: "nasa:smap:spl3smp_e:v006",
    granuleId: "SMAP_L3_SM_P_E_20240103_R19240_001.h5",
    ingestionRunId: "smap-phase1-verified-ingest-v1",
    provenanceDatasetId: "nasa:smap:spl3smp_e:v006",
  },
  {
    districtCode: "chattogram",
    dateLabel: "2024-01-02",
    date: new Date("2024-01-02T00:00:00.000Z"),
    orbit: "AM",
    soilMoisture: 0.1719,
    soilMoistureDca: 0.1719,
    unit: "m^3/m^3",
    retrievalQualityFlag: 9,
    isRecommendedQuality: false,
    qualityClassification: "not_recommended",
    surfaceFlag: 143,
    qaBits: {
      bit0NotRecommended: true,
      bit1NotAttempted: false,
      bit2NotSuccessful: false,
      bit3FreezeThawUnsuccessful: true,
      rawFlag: 9,
    },
    surfaceTemperatureK: 294.87,
    freezeThawFraction: -9999.0,
    bulkDensity: 1.1432,
    clayFraction: 0.2903,
    staticWaterFraction: 0.358998,
    radarWaterFraction: 0.358998,
    soilPorosity: 0.5686,
    latitude: 22.330446,
    longitude: 91.820541,
    targetReferenceLat: 22.3384,
    targetReferenceLon: 91.8317,
    geodesicDistanceKm: 1.45,
    adminPolygonPcode: "BD2015",
    datasetKey: "nasa:smap:spl3smp_e:v006",
    granuleId: "SMAP_L3_SM_P_E_20240102_R19240_001.h5",
    ingestionRunId: "smap-phase1-verified-ingest-v1",
    provenanceDatasetId: "nasa:smap:spl3smp_e:v006",
  },
  {
    districtCode: "chattogram",
    dateLabel: "2024-01-03",
    date: new Date("2024-01-03T00:00:00.000Z"),
    orbit: "AM",
    soilMoisture: 0.1871,
    soilMoistureDca: 0.1871,
    unit: "m^3/m^3",
    retrievalQualityFlag: 9,
    isRecommendedQuality: false,
    qualityClassification: "not_recommended",
    surfaceFlag: 143,
    qaBits: {
      bit0NotRecommended: true,
      bit1NotAttempted: false,
      bit2NotSuccessful: false,
      bit3FreezeThawUnsuccessful: true,
      rawFlag: 9,
    },
    surfaceTemperatureK: 294.57,
    freezeThawFraction: -9999.0,
    bulkDensity: 1.1432,
    clayFraction: 0.2903,
    staticWaterFraction: 0.358998,
    radarWaterFraction: 0.358998,
    soilPorosity: 0.5686,
    latitude: 22.330446,
    longitude: 91.820541,
    targetReferenceLat: 22.3384,
    targetReferenceLon: 91.8317,
    geodesicDistanceKm: 1.45,
    adminPolygonPcode: "BD2015",
    datasetKey: "nasa:smap:spl3smp_e:v006",
    granuleId: "SMAP_L3_SM_P_E_20240103_R19240_001.h5",
    ingestionRunId: "smap-phase1-verified-ingest-v1",
    provenanceDatasetId: "nasa:smap:spl3smp_e:v006",
  },
];

async function runIngestion() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("CRITICAL: MONGODB_URI not found in environment.");
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    console.log("[db] Connected to MongoDB Atlas.");

    const initialCount = await SmapObservation.countDocuments();
    console.log(`[db] Initial 'smapobservations' count: ${initialCount}`);

    let upsertedCount = 0;
    let modifiedCount = 0;
    let matchedCount = 0;

    for (const record of VERIFIED_FOUR_RECORDS) {
      const filter = {
        districtCode: record.districtCode,
        dateLabel: record.dateLabel,
        orbit: record.orbit,
      };

      const result = await SmapObservation.updateOne(
        filter,
        { $set: record },
        { upsert: true }
      );

      if (result.upsertedCount > 0) upsertedCount += result.upsertedCount;
      if (result.modifiedCount > 0) modifiedCount += result.modifiedCount;
      if (result.matchedCount > 0) matchedCount += result.matchedCount;

      console.log(
        `[upsert] ${record.districtCode} ${record.dateLabel} (${record.orbit}): ` +
          `SM=${record.soilMoisture} m³/m³, QF=${record.retrievalQualityFlag} (${record.qualityClassification})`
      );
    }

    const finalCount = await SmapObservation.countDocuments();
    console.log(
      `[db] Ingestion complete. Summary: Upserted=${upsertedCount}, Modified=${modifiedCount}, Matched=${matchedCount}, TotalDocs=${finalCount}`
    );

    // Read-back verification
    const storedDocs = await SmapObservation.find().sort({ districtCode: 1, dateLabel: 1 }).lean();
    console.log("\n--- READ-BACK VERIFICATION FROM MONGODB ATLAS ---");
    storedDocs.forEach((doc, idx) => {
      console.log(
        `#${idx + 1}: ID=${doc._id} | District=${doc.districtCode} | Date=${doc.dateLabel} | ` +
          `Orbit=${doc.orbit} | SM=${doc.soilMoisture} | QF=${doc.retrievalQualityFlag} | ` +
          `Class=${doc.qualityClassification} | Recommended=${doc.isRecommendedQuality} | ` +
          `PCode=${doc.adminPolygonPcode} | Dist=${doc.geodesicDistanceKm} km`
      );
    });

    await mongoose.disconnect();
    console.log("[db] Disconnected cleanly.");
  } catch (err) {
    console.error("[error] Ingestion failed:", err);
    process.exit(1);
  }
}

runIngestion();
