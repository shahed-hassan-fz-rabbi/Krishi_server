/**
 * Ingestion logging service — creates and advances one `dataingestionlogs`
 * record per run. All counters support the binding reporting requirement:
 * requested vs actual range, sentinel counts (never stored as values), and the
 * total missing/absent accounting used for coverage reports.
 */
import { DataIngestionLog } from "../../models/dataingestionlog.model.js";

/**
 * Opens a run. Caller supplies runId, requested range, districts and parameters.
 */
export async function openIngestionRun({ runId, requestedRange, districtCodes, parameters, kind = "ingestion" }) {
  return DataIngestionLog.create({
    runId,
    datasetKey: "nasa:power:daily:point",
    kind,
    status: "running",
    requestedRange,
    actualRange: { start: null, end: null },
    districtCodes,
    parameters,
    startedAt: new Date(),
    counts: {
      spansTotal: 0,
      spansSuccess: 0,
      spansFailed: 0,
      observationsUpserted: 0,
      datesMissingOrAbsent: 0,
      sentinelFlagged: 0,
    },
    spans: [],
  });
}

/**
 * Appends/updates one span result. `validation` is the validatePowerResponse
 * data block; failure cases pass null with an errorMessage.
 */
export async function recordSpan(runId, span) {
  const log = await DataIngestionLog.findOne({ runId });
  if (!log) throw new Error(`ingestion log ${runId} not found`);

  const entry = {
    startLabel: span.startLabel,
    endLabel: span.endLabel,
    returnedStartLabel: span.returnedStartLabel ?? null,
    returnedEndLabel: span.returnedEndLabel ?? null,
    status: span.status ?? "running",
    attempts: span.attempts ?? 0,
    httpStatus: span.httpStatus ?? null,
    stored: span.stored ?? 0,
    errorMessage: span.errorMessage ?? null,
    durationMs: span.durationMs ?? null,
    perParameter: span.perParameter ?? undefined,
  };
  log.spans.push(entry);

  if (!log.counts) {
    log.counts = {
      spansTotal: 0,
      spansSuccess: 0,
      spansFailed: 0,
      observationsUpserted: 0,
      datesMissingOrAbsent: 0,
      sentinelFlagged: 0,
    };
  }

  if (entry.status === "success") {
    log.counts.spansSuccess = (log.counts.spansSuccess || 0) + 1;
    log.counts.observationsUpserted = (log.counts.observationsUpserted || 0) + entry.stored;
    if (span.perParameter) {
      for (const meta of Object.values(span.perParameter)) {
        log.counts.sentinelFlagged = (log.counts.sentinelFlagged || 0) + (meta.sentinelCount ?? 0);
        log.counts.datesMissingOrAbsent = (log.counts.datesMissingOrAbsent || 0) + (meta.absentCount ?? 0);
      }
    }
  } else if (entry.status === "failed" || entry.status === "exhausted_retries") {
    log.counts.spansFailed = (log.counts.spansFailed || 0) + 1;
  }
  log.counts.spansTotal = log.spans.length;

  if (!log.actualRange) {
    log.actualRange = { start: null, end: null };
  }

  // Keep the actual returned envelope (first/last successfully returned day).
  if (span.returnedStartLabel) {
    if (!log.actualRange.start || span.returnedStartLabel < log.actualRange.start) {
      log.actualRange.start = span.returnedStartLabel;
    }
  }
  if (span.returnedEndLabel) {
    if (!log.actualRange.end || span.returnedEndLabel > log.actualRange.end) {
      log.actualRange.end = span.returnedEndLabel;
    }
  }
  if (span.apiVersion) log.apiVersionEchoed = span.apiVersion;
  if (span.timeStandard) log.timeStandardEchoed = span.timeStandard;

  await log.save();
  return log;
}

/** Closes a run with an overall status and optional error. */
export async function closeIngestionRun(runId, status, errorMessage = null) {
  const log = await DataIngestionLog.findOne({ runId });
  if (!log) throw new Error(`ingestion log ${runId} not found`);
  log.status = status;
  log.errorMessage = errorMessage;
  log.finishedAt = new Date();
  log.durationMs = log.finishedAt.getTime() - log.startedAt.getTime();
  await log.save();
  return log;
}
