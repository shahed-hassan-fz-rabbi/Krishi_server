# NASA Stage 8 — Safe Source Preparation Report

**Project:** Krishi Mama — Team NeuralMesh, NASA Space Apps Challenge 2026
**Date:** 2026-11-13
**Stage:** 8 (part 1 of 2) — implementing the Stage-7 enumerated source changes, offline verification, and static safety gates. **No MongoDB connection was made during this preparation phase.**
**Verdict:** ✅ **ALL SAFETY GATES PASSED — SOURCE PREPARATION COMPLETE, EXECUTION AUTHORIZED UNDER CONSOLIDATED AUTHORIZATION**

---

## 1. Executive verdict

All five source-level preparations required by Stage 7 are complete (4 job changes implemented; the 5th — modifying the Stage-6 manifest — **deliberately not done** because manifest modification is prohibited without separate authorization; the POWER SHA-256 remediation evidence is carried in reports instead). A new shared target module with a fail-closed runtime guard makes a silent `test` fallback structurally impossible. Offline verification: **10/10 new guard tests + 67/67 total NASA test suite tests pass; 24/24 static safety gates pass.** The approved manifest is byte-identical to its Stage-7 anchor.

## 2. Git baseline (verified before editing, per instruction)

| Item | Value |
|---|---|
| Branch | `main` |
| HEAD at start | `027a06c` (WIP teammate commit) ← `3d202a6` (NASA work) |
| Working tree | clean |
| No reset/amend/rebase/revert performed | ✅ confirmed |
| Manifest SHA-256 before edits | `03a827e63755f74865c3103afeeb69236ba186d4d4ca60ad08d6885766face58` |
| Manifest SHA-256 after edits | **identical** (manifest untouched) |

## 3. Source changes completed

### 3.1 NEW — `src/config/ingestionTarget.config.js`
Shared approved-target module:
- `INGESTION_TARGET_DATABASE = "krishi_mama"` — the single source of truth for every NASA ingestion job.
- `assertIngestionTarget(connection)` — **fail-closed runtime guard**: throws *before any write* unless `connection.name === "krishi_mama"`; the error explicitly states "Zero writes performed". This makes a silent mongoose-default `test` fallback structurally impossible even if connection plumbing changes later.

### 3.2 `src/jobs/ingest-power.js`
- `connectDatabase({ databaseName: INGESTION_TARGET_DATABASE })` (was no-arg → default `test`).
- `assertIngestionTarget(mongoose.connection)` immediately after a successful connect, before any workflow call.
- No behavior change otherwise (chunks, resume mode, provenance writes all unchanged).

### 3.3 `src/jobs/ingest-smap-validated-file.js`
- `mongoose.connect(..., { dbName: INGESTION_TARGET_DATABASE })` + runtime guard after connect.
- New **`--fresh-database`** flag for the fresh `krishi_mama` path. **The baseline guard is NOT weakened — it is adapted and, for the fresh path, strengthened:**
  - Default mode (no flag): original guard unchanged — `before.length !== 4 → abort` (historical baseline must be present).
  - `--fresh-database` mode: baseline may only be **empty or a subset of the manifest-approved SMAP key set** (`cumilla|2024-01-02|AM`, `cumilla|2024-01-03|AM`, `cumilla|2024-01-05|PM`); any foreign record or count exceeding the approved set aborts before writes.
  - Fingerprint preservation (`Existing SMAP records changed during insert-only write → abort`) applies in **both** modes, unchanged.
  - All scientific gates unchanged: flags 0/8 only, bbox membership, physical range, ≤25 km pixel distance, source-history URL match, `$setOnInsert` insert-only.

### 3.4 `src/jobs/ingest-gpm-pilot.js`
- `mongoose.connect(..., { dbName: INGESTION_TARGET_DATABASE })` + runtime guard.
- New `--granules=` parameterization with a **hard allowlist**: only the 4 manifest-approved granule IDs may ever be ingested (`20240101-S000000-E002959.0000`, `-S060000-E062959.0360`, `-S120000-E122959.0720`, `-S180000-E182959.1080`, all `.V07B.HDF5`). Any unapproved ID throws before any connection. Default (no argument) behavior is unchanged (pilot granule only).
- Per-granule parsing/validation loop added; per-granule `ordered: true` bulkWrite with `$setOnInsert` unchanged; interval records only — **no daily totals possible** (no aggregation code exists).

### 3.5 `src/jobs/ingest-modis.js`
- Source path now the **task-stamped** `data/modis/parsed_modis_observations_e0405649-2665-439d-87eb-a08608108fcd.json` (exact provenance bound to the manifest's AppEEARS task ID).
- `mongoose.connect(uri, { dbName: INGESTION_TARGET_DATABASE })` + runtime guard.
- `--confirm` gate preserved: dry-run returns **before** any connection (statically verified).

### 3.6 NOT implemented (prohibited without separate authorization)
- Adding POWER `sha256` fields to `stage6_ingestion_manifest.json`. Manifest left byte-identical; remediation hashes verified this stage and recorded here:
  - `power_cumilla_20240101_20240107_response.json` → `6af622b8178ad3fd1dfe7e8b01c5f96ca2599a13df1da93f1d77bd5c12878113`
  - `power_chattogram_20240101_20240107_response.json` → `43e5e852995b2a05b628a0f77578764ae5d53780b265ff0a5fd856389d10b577`

## 4. Offline verification performed (zero DB)

### 4.1 New test suite — `tests/ingestion.target.test.js` (10/10 pass)
Unit: `assertIngestionTarget` fails closed for `test`/empty/unknown/`null`/`undefined` and never allows a wrong-target write. Static: all four jobs import the target module, pass `dbName`/`databaseName`, and call the guard; no `mongoose.connect` without `dbName` exists in any of the four jobs; MODIS dry-run returns before connect; manifest hash equals the anchor; GPM allowlist equals the manifest granule set; SMAP approved-key set equals the manifest SMAP records.

### 4.2 Full NASA test suite — **67/67 pass** (57 pre-existing baseline + 10 new), including SMAP flag-0/8-vs-9/fill regression and fill-value-never-zero regression. Syntax checks (`node --check`) pass on all four edited jobs.

### 4.3 Static safety gates — **24/24 PASS**

| Gate | Result |
|---|---|
| 1. Manifest SHA-256 = approved anchor; counts 84/3/8/6 = 101 + 17 | ✅ |
| 2. All manifest source hashes still match disk (3 SMAP `.nc4`, 4 GPM `.HDF5`) + MODIS CSV + parsed JSON + POWER responses | ✅ |
| 3. All four jobs select `krishi_mama` + call runtime guard; no dbName-less `mongoose.connect` anywhere | ✅ |
| 4. GPM allowlist == manifest granule IDs (exactly 4) | ✅ |
| 5. SMAP baseline guard unchanged in default mode; fresh mode manifest-allowlisted; fingerprint + all scientific gates intact | ✅ |
| 6. MODIS task-stamped source; dry-run before connect; 2 rank-1 records `isReliableQuality: false` | ✅ |
| 7. PID 22784 observed untouched — `node`, started 2026-11-12T08:23:57+06:00 (before this stage); never signalled/killed | ✅ |
| 8. No `.env` modification (git-clean check) | ✅ |

## 5. Runtime-guard proof summary (offline proof that `test` is unreachable)

1. `assertIngestionTarget({ name: "test" })` throws (unit-tested).
2. Every connection call site passes `dbName: "krishi_mama"` statically.
3. `MONGODB_TEST_URI` is unset, so no URI-level redirection exists; the guard would catch any that appeared.
4. Every job asserts the live connection name **after** connect and **before** the first write.

## 6. Pre-write execution plan (order fixed; stop-on-failure; no improvised retries)

| Step | Command | Expected (fresh `krishi_mama`) |
|---|---|---|
| 0 | Live pre-write probe: connect with the approved config, assert target, read counts | connection.name = `krishi_mama`, all counts 0 |
| 1 | `node src/jobs/ingest-power.js --district cumilla --start 2024-01-01 --end 2024-01-07` | 42 stored |
| 2 | `node src/jobs/ingest-power.js --district chattogram --start 2024-01-01 --end 2024-01-07` | 42 stored |
| 3 | `node src/jobs/ingest-smap-validated-file.js --file=data/smap/raw/cumilla/SMAP_L3_SM_P_E_20240102_R19240_001_subsetted.nc4 --district=cumilla --fresh-database` | 1 upserted |
| 4 | same for `...20240103_R19240_001...` | 1 upserted |
| 5 | same for `...20240105_R19240_002...` | 1 upserted |
| 6 | `node src/jobs/ingest-gpm-pilot.js --granules=<4 approved IDs, comma-separated>` | 8 upserted |
| 7 | `node src/jobs/ingest-modis.js --confirm` | 6 upserted, pass-2 idempotent |
| 8 | Read-only reconciliation vs manifest + `test` baselines unchanged | 101 keys set-equal |

Live POWER re-fetch is within manifest scope (same 7-day window; values must reconcile with the validated responses).

## 7. Isolation statement (standing, unchanged)

`krishi_mama` shares the `ac-r5wtnka` Atlas cluster with the backend (PID 22784) — a different database name does **not** prove cluster-level isolation. Isolation rests on: owner confirmation (Stage 6, sole owner, isolated dev DB), explicit `dbName` + fail-closed runtime guard, insert-only `$setOnInsert` upserts that cannot modify/delete any existing document, and read-only verification of `test` after execution.

## 8. Explicit statement

No MongoDB connection, query, or write occurred during this preparation phase. No `.env`, credential, schema, index, manifest, or raw source file was modified; PID 22784 was never touched; no commit, push, or deploy was performed.
