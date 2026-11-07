/**
 * Append-only ingestion run journal. Every POWER request span is logged with
 * requested vs actual returned range, sentinel/absent counts per parameter,
 * HTTP outcome, and duration. Failures are NEVER skipped silently — a failed
 * span records failure status and the run ends `partial`/`failed`.
 */
import mongoose from "mongoose";

const spanSchema = new mongoose.Schema(
  {
    startLabel: { type: String, required: true }, // requested range start (ISO)
    endLabel: { type: String, required: true }, // requested range end (ISO)
    returnedStartLabel: { type: String, default: null }, // actual first returned day
    returnedEndLabel: { type: String, default: null }, // actual last returned day
    status: {
      type: String,
      enum: ["running", "success", "failed", "exhausted_retries"],
      default: "running",
    },
    attempts: { type: Number, default: 0 },
    httpStatus: { type: Number, default: null },
    perParameter: { type: Map, of: Object }, // param -> {ok, sentinel, absent, expected}
    stored: { type: Number, default: 0 }, // documents upserted in this span
    errorMessage: { type: String, default: null },
    durationMs: { type: Number, default: null },
  },
  { _id: true }
);

const rangeSchema = new mongoose.Schema(
  {
    start: { type: String, default: null },
    end: { type: String, default: null },
  },
  { _id: false }
);

const dataIngestionLogSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true },
    datasetKey: { type: String, required: true }, // "nasa:power:daily:point"
    kind: {
      type: String,
      enum: ["ingestion", "seed", "probe"],
      default: "ingestion",
    },
    status: {
      type: String,
      enum: ["running", "completed", "partial", "failed"],
      default: "running",
    },
    requestedRange: { type: rangeSchema, required: true },
    actualRange: { type: rangeSchema, default: () => ({ start: null, end: null }) },
    districtCodes: { type: [String], required: true },
    parameters: { type: [String], required: true },
    spans: { type: [spanSchema], default: [] },
    counts: {
      spansTotal: { type: Number, default: 0 },
      spansSuccess: { type: Number, default: 0 },
      spansFailed: { type: Number, default: 0 },
      observationsUpserted: { type: Number, default: 0 },
      datesMissingOrAbsent: { type: Number, default: 0 }, // published-lag + gaps accounting
      sentinelFlagged: { type: Number, default: 0 }, // never stored as values
    },
    apiVersionEchoed: { type: String, default: null },
    timeStandardEchoed: { type: String, default: null },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    errorMessage: { type: String, default: null },
  },
  { collection: "dataingestionlogs", timestamps: true }
);

dataIngestionLogSchema.index({ runId: 1 }, { unique: true });
dataIngestionLogSchema.index({ datasetKey: 1, status: 1, createdAt: -1 });

export const DataIngestionLog = mongoose.model("DataIngestionLog", dataIngestionLogSchema);
