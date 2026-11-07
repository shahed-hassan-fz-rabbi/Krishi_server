/**
 * Daily point observations from NASA POWER (Phase 3 dataset only).
 *
 * Integrity rules:
 * - Dates are the API's LOCAL SOLAR TIME (LST) calendar days. LST is NOT
 *   Bangladesh Standard Time (UTC+6); `timeStandard: "LST"` is stored on every
 *   document so grouping/labels always carry the disclosure.
 * - Sentinel/missing values are NEVER stored as valid values and never as 0:
 *   quality flag + raw sentinel are kept. Absent dates from the response are
 *   stored as `absent` so coverage accounting is complete.
 * - Unique index (districtCode, parameter, dateLabel) makes ingestion upserts
 *   idempotent — a re-run produces no duplicates.
 */
import mongoose from "mongoose";

const nasaObservationSchema = new mongoose.Schema(
  {
    districtCode: { type: String, required: true, lowercase: true, index: true },
    parameter: { type: String, required: true }, // one of PARAMETER_CATALOG keys
    datasetKey: { type: String, required: true }, // "nasa:power:daily:point"

    // LST calendar day identity. Canonical sort/search key.
    dateLabel: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    // Same LST day stored as a UTC-midnight Date purely for efficient range queries.
    date: { type: Date, required: true },
    timeStandard: { type: String, required: true, default: "LST" },

    // value is present ONLY when quality === "ok". Missing is flagged, never zeroed.
    value: { type: Number, default: null },
    unit: { type: String, required: true }, // stamped from the verified catalog at ingest

    quality: {
      type: String,
      required: true,
      enum: ["ok", "missing_sentinel", "absent"],
    },
    sentinelValue: { type: Number, default: null }, // raw fill_value when missing_sentinel
    inverseDistanceElevation: { type: Number, default: null }, // from geometry echo [2]

    ingestionRunId: { type: String, required: true, index: true },
    provenanceDatasetId: { type: String, ref: "NasaDataset", required: true },
  },
  { collection: "nasaobservations", timestamps: true }
);

nasaObservationSchema.index(
  { districtCode: 1, parameter: 1, dateLabel: 1 },
  { unique: true, name: "uniq_district_param_date" }
);
nasaObservationSchema.index({ districtCode: 1, parameter: 1, date: 1 }); // fast range scans
nasaObservationSchema.index({ datasetKey: 1 }); // provenance rollups

export const NasaObservation = mongoose.model("NasaObservation", nasaObservationSchema);
