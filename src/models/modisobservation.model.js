/**
 * NASA MODIS 250m 16-Day Vegetation Observation Model (MOD13Q1.061).
 *
 * Enforces:
 * - Idempotent upsert via unique compound index (districtCode, dateLabel).
 * - Exact physical variables: NDVI, EVI, pixel reliability, acquisition DOY.
 * - Strict QA classification: reliable (rank 0) vs marginal/cloud (ranks 1-3).
 */

import mongoose from "mongoose";

const modisObservationSchema = new mongoose.Schema(
  {
    districtCode: { type: String, required: true, lowercase: true, index: true },
    dateLabel: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    date: { type: Date, required: true },
    compositeDayOfYear: { type: Number, default: null },

    // Scaled Vegetation Indices (-0.20 to 1.00)
    ndvi: { type: Number, default: null },
    evi: { type: Number, default: null },

    // Source values as returned by AppEEARS (typically already scaled); the
    // original row and bundle checksums are retained in sourceMetadata.
    rawNdvi: { type: Number, default: null },
    rawEvi: { type: Number, default: null },

    // Quality Assessment (MODIS Pixel Reliability: 0=Good, 1=Marginal, 2=Snow/Ice, 3=Cloud)
    pixelReliability: { type: Number, required: true },
    isReliableQuality: { type: Boolean, required: true, default: false },
    qualityClassification: {
      type: String,
      required: true,
      enum: ["good_data", "marginal_data", "snow_ice", "cloudy", "fill"],
      default: "marginal_data",
      index: true,
    },

    // Spatial representative coordinates
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    targetReferenceLat: { type: Number, default: null },
    targetReferenceLon: { type: Number, default: null },
    geodesicDistanceKm: { type: Number, default: null },
    adminPolygonPcode: { type: String, default: null }, // 'BD2019' or 'BD2015'

    // Scientific metadata & provenance
    datasetKey: { type: String, required: true, default: "nasa:modis:mod13q1:v061" },
    sourceGranuleId: { type: String, default: null },
    sourceProduct: { type: String, default: null },
    sourceMetadata: { type: mongoose.Schema.Types.Mixed, default: null },
    taskId: { type: String, default: null },
    ingestionRunId: { type: String, required: true, index: true },
    provenanceDatasetId: { type: String, ref: "NasaDataset", default: "nasa:modis:mod13q1:v061" },
  },
  { collection: "modisobservations", timestamps: true }
);

modisObservationSchema.index(
  { districtCode: 1, dateLabel: 1 },
  { unique: true, name: "uniq_modis_district_date" }
);
modisObservationSchema.index({ districtCode: 1, isReliableQuality: 1 });
modisObservationSchema.index({ datasetKey: 1 });

export const ModisObservation = mongoose.model("ModisObservation", modisObservationSchema);
