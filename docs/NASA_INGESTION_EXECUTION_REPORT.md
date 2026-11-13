# NASA Ingestion Execution Report

**Project:** Krishi Mama — Team NeuralMesh, NASA Space Apps Challenge 2026
**Date:** 2026-11-13
**Target database:** `krishi_mama` on Atlas cluster `ac-r5wtnka` (…`b5yy3pn.mongodb.net`) — approved by owner (Stage 6), fail-closed runtime-guarded (Stage 8)
**Verdict:** ✅ **EXECUTED SUCCESSFULLY — 101/101 RECORDS INSERTED, 0 SKIPPED, 17 REJECTED (never stored), verified by read-only reconciliation**

---

## 1. Pre-write verification (per authorization, performed immediately before the first write)

A live read-only probe (`km-phase8/prewrite-probe.mjs`) connected with the exact ingestion configuration and confirmed:

| Check | Result |
|---|---|
| Live connection name | **`krishi_mama`** (runtime guard `assertIngestionTarget` passed) |
| Cluster | `ac-r5wtnka-shard-00-00.b5yy3pn.mongodb.net` (expected — same cluster as the backend, documented; DB-name ≠ cluster isolation) |
| `krishi_mama` pre-write counts | POWER 0 · SMAP 0 · GPM 0 · MODIS 0 (fresh DB) |
| `test` baselines (read-only) | POWER 109,572 · SMAP 5 · GPM 672 · MODIS 10 — exactly the documented values |
| Manifest integrity | SHA-256 = `03a827e6…face58` (approved anchor, byte-identical) |
| PID 22784 | running (`node`, started 2026-11-12 08:23+06) — untouched |

## 2. Execution log (order as planned; stop-on-failure; no improvised retries)

| # | Command | Result |
|---|---|---|
| 1 | `node src/jobs/ingest-power.js --district cumilla --start 2024-01-01 --end 2024-01-07` | ✅ `run_1794557771356_d406f8` — **42 stored** (OK=42, sentinel 0, absent 0), guard verified `krishi_mama` |
| 2 | `node src/jobs/ingest-power.js --district chattogram --start 2024-01-01 --end 2024-01-07` | ✅ `run_1794557788030_6139aa` — **42 stored** (OK=42) |
| 2b | chattogram re-run (repeat verification, not a retry) | resume mode **skipped 1 chunk, 0 stored** → idempotency proven, no duplicates |
| 3 | `node src/jobs/ingest-smap-validated-file.js --file=…20240102_R19240_001_subsetted.nc4 --district=cumilla --fresh-database` | ✅ **1 upserted** — AM 2024-01-02, 0.3003 m³/m³, flag 8, baseline 0→1 preserved |
| 4 | same for `…20240103_R19240_001…` | ✅ **1 upserted** — AM 2024-01-03, 0.4259, flag 8, baseline 1→2 preserved |
| 5 | same for `…20240105_R19240_002…` | ✅ **1 upserted** — PM 2024-01-05, 0.3497, flag 8, baseline 2→3 preserved |
| 6 | `node src/jobs/ingest-gpm-pilot.js --granules=<4 approved IDs>` | ✅ **8 upserted** — 2 districts × 4 granules, all `runType: Final`, V07B |
| 7 | `node src/jobs/ingest-modis.js` (dry-run) → `node src/jobs/ingest-modis.js --confirm` | ✅ **6 upserted** — pass 2 idempotent (0 new, 6 matched), `smapobservations` 3→3 untouched, all field checks true |

**No job failed. Zero retry improvisation was needed.**

## 3. Exact final counts (live-verified, read-only)

| Dataset | Collection | Inserted | Skipped | Rejected | Duplicate |
|---|---|---:|---:|---:|---:|
| POWER | `nasaobservations` | **84** | 0 | 0 | 0 |
| SMAP | `smapobservations` | **3** | 0 | 17 (never stored) | 0 |
| GPM | `gpmobservations` | **8** | 0 | 0 | 0 |
| MODIS | `modisobservations` | **6** | 0 | 0 | 0 |
| **Total** | | **101** | **0** | **17** | **0** |

SMAP reject accounting (13 fill + 4 flag-9, all excluded pre-connect by scientific gates — never stored, never zeroed).

## 4. Provenance & source hashes (verified unchanged before execution)

- SMAP `.nc4` SHA-256 ×3: `338925c8…98cd` (01-02), `f1d79ac1…b5d1` (01-03), `8d822510…1de6` (01-05) — re-verified live by the job (`sourceFileSha256` stamped on each document) and matching the manifest.
- GPM: 4 manifest-approved `.V07B.HDF5` granules only (hard allowlist; any other ID throws pre-connect).
- MODIS: task-stamped source `parsed_modis_observations_e0405649-2665-439d-87eb-a08608108fcd.json` (hash `0cc324d5…0d0a` verified pre-run); upstream CSV hash verified against the manifest.
- POWER: live API re-fetch (within manifest scope, same window); values reconciled 84/84 against the validated responses (§5, reconciliation report).
- Ingestion journals (`dataingestionlogs`, `nasadatasets` provenance registry) were written to `krishi_mama` by the POWER workflow internals — disclosed as planned.

## 5. Scientific-rule compliance at execution time

- SMAP: flags 0/8 only (all 3 stored docs are flag 8, `recommended`); surface soil moisture (top ~5 cm), never labelled root-zone.
- GPM: interval records only with UTC interval timestamps; **no daily-total document exists** (incomplete local days 3/48 and 1/48 preserved as incomplete; UTC+6 interpretation untouched).
- MODIS: 4 rank-0 primary + 2 rank-1 marginal kept strictly separate (`isReliableQuality: false`); never mixed into primary recommendations.
- POWER: `timeStandard: LST` on all 84 — historical climate, never live weather.
- No missing/fill/rejected value was converted to zero anywhere.

## 6. Isolation & restrictions compliance

- PID 22784: never restarted, signalled, or touched; still running after ingestion; its `test` database verified unchanged (see reconciliation report).
- `test` database: zero writes (insert-only `$setOnInsert` against an explicitly named other database; post-run counts identical to baselines).
- `.env`/credentials: unmodified, never printed. Schemas/indexes: unmodified (Mongoose auto-created the four existing compound unique indexes in the new DB). Raw NASA source files: never overwritten. Git: no commit/push/deploy performed.

## 7. Unverified / disclosed items

| Item | Status |
|---|---|
| Cluster-level infra isolation | Not structural — same cluster as the backend; isolation rests on owner confirmation + data-level insert-only semantics (accepted per Stage-6 owner confirmation). |
| `krishi_mama` index creation timing | Mongoose `Model.init()` created the unique indexes before writes (jobs awaited them); per-record idempotency observed live. |
| POWER value source | Re-fetched live from the POWER API at execution time (authorized scope); all 84 values reconciled to the validated response data (reconciliation report §2). |
| `dataingestionlogs`/`nasadatasets` support documents | Written to `krishi_mama` by the POWER workflow (planned, disclosed; not part of the 101). |

**Success claim basis:** every count and key in this report was verified by the subsequent read-only reconciliation against the approved manifest — 18/18 checks passed (`NASA_POST_INGESTION_RECONCILIATION_REPORT.md`).
