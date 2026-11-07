/**
 * Data-source provenance registry — one record per dataset (separate from any
 * cache). Records the verified API contract: endpoint, community, units per
 * parameter, fill value, and the mandatory LST time-standard disclosure.
 * Collection name is explicit so it does not depend on the URI's database name.
 */
import mongoose from "mongoose";

const parameterMetaSchema = new mongoose.Schema(
  {
    unit: { type: String, required: true },
    longName: { type: String, required: true },
  },
  { _id: false }
);

const nasaDatasetSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    datasetKey: { type: String, required: true }, // e.g. "nasa:power:daily:point"
    product: { type: String, required: true },
    provider: { type: String, required: true }, // "NASA POWER (Langley Research Center)"
    endpoint: { type: String, required: true },
    community: { type: String, default: "AG" },
    apiVersionAtLastIngest: { type: String, default: null }, // echoed per run in logs
    sources: { type: [String], default: [] }, // e.g. ["MERRA2","SYN1DEG","POWER"]
    parameters: { type: Map, of: parameterMetaSchema }, // units + long name per parameter
    fillValue: { type: Number, required: true }, // verified: -999 (never converted to 0)
    timeStandard: { type: String, required: true }, // "LST"
    timeStandardDisclosure: { type: String, required: true },
    spatialResolutionNote: { type: String, default: "Point interpolation from gridded sources" },
    coverage: {
      // Updated by the ingestion job after verified runs (probes are NOT proof).
      firstObservedDate: { type: Date, default: null },
      lastObservedDate: { type: Date, default: null },
      lastVerifiedAt: { type: Date, default: null },
    },
    sourceUrls: { type: [String], default: [] },
  },
  { collection: "nasadatasets", timestamps: true }
);

nasaDatasetSchema.index({ datasetKey: 1 }, { unique: true });

export const NasaDataset = mongoose.model("NasaDataset", nasaDatasetSchema);
