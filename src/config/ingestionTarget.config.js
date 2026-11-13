/**
 * Approved ingestion target for the controlled NASA ingestion (Stage 8).
 *
 * Every NASA ingestion job MUST import and use this constant for its
 * connection, and MUST call assertIngestionTarget() after connecting.
 * The runtime guard re-checks the live connection name so no job can
 * silently fall back to the mongoose default `test` database.
 *
 * Note: a separate database name does not prove cluster-level isolation —
 * the approved `krishi_mama` database shares the ac-r5wtnka Atlas cluster
 * with the running backend. Isolation is owner-confirmed (2026-11-13) and
 * enforced at the data level by insert-only, `$setOnInsert` upserts that
 * can never modify or delete documents in any other database.
 */
export const INGESTION_TARGET_DATABASE = "krishi_mama";

/** Throws (before any write) unless the live connection is the approved target. */
export function assertIngestionTarget(connection) {
  const actual = connection?.name ?? null;
  if (actual !== INGESTION_TARGET_DATABASE) {
    throw new Error(
      `[ingestion-target] ABORT: connected to "${actual ?? "unknown"}" but the approved target is "${INGESTION_TARGET_DATABASE}". Zero writes performed.`
    );
  }
}
