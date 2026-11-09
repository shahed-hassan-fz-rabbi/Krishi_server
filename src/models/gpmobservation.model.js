import mongoose from "mongoose";

const gpmObservationSchema = new mongoose.Schema(
  {
    districtCode: { type: String, required: true, lowercase: true, index: true },
    dateLabel: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // Bangladesh local day
    intervalStartUtc: { type: Date, required: true },
    intervalEndUtc: { type: Date, required: true },
    precipitationRateMmHr: { type: Number, default: null },
    precipitationMm: { type: Number, default: null }, // rate x 0.5 hour interval
    randomErrorMmHr: { type: Number, default: null },
    precipitationQualityIndex: { type: Number, default: null }, // relative skill indicator, not probability
    probabilityLiquidPrecipitationPercent: { type: Number, default: null },
    unit: { type: String, required: true, default: "mm/hr" },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    targetReferenceLat: { type: Number, required: true },
    targetReferenceLon: { type: Number, required: true },
    geodesicDistanceKm: { type: Number, required: true },
    sourceQuality: { type: String, required: true, enum: ["valid", "missing_fill"] },
    datasetKey: { type: String, required: true, default: "nasa:gpm:imerg:3imerghh:v07" },
    product: { type: String, required: true },
    runType: { type: String, required: true, enum: ["Final"] },
    productVersion: { type: String, required: true },
    granuleId: { type: String, required: true },
    ingestionRunId: { type: String, required: true, index: true },
    provenance: {
      provider: { type: String, required: true },
      collectionConceptId: { type: String, required: true },
      doi: { type: String, required: true },
      algorithmVersion: { type: String, default: null },
      cmrUpdated: { type: Date, default: null },
      sourceUrl: { type: String, default: null },
      responseSha256: { type: String, default: null },
      timeStandard: { type: String, required: true, default: "UTC" },
    },
  },
  { collection: "gpmobservations", timestamps: true }
);

gpmObservationSchema.index(
  { districtCode: 1, granuleId: 1 },
  { unique: true, name: "uniq_gpm_district_granule" }
);
gpmObservationSchema.index({ districtCode: 1, dateLabel: 1, intervalStartUtc: 1 });
gpmObservationSchema.index({ datasetKey: 1, runType: 1, productVersion: 1 });

export const GpmObservation = mongoose.model("GpmObservation", gpmObservationSchema);
