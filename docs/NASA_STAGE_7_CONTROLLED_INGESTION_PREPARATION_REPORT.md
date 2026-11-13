# NASA Stage 7 — Controlled Ingestion Preparation Report (NO EXECUTION)

**Project:** Krishi Mama — Team NeuralMesh, NASA Space Apps Challenge 2026
**Date:** 2026-11-13
**Stage:** 7 — deterministic dataset-by-dataset execution-plan preparation for a *future* authorized ingestion into the `krishi_mama` database. **No MongoDB connection was made, no ingestion script was executed, and no database write occurred in this stage.**
**Verdict:** ✅ **READY FOR SOURCE-LEVEL EXECUTION-PLAN REVIEW**

---

## 1. Executive verdict

The approved Stage-6 manifest was re-verified offline against every acceptance criterion (**22/23 checks pass; the single failure is a disclosed provenance gap in the POWER records — no SHA-256 field — with remediation evidence provided below and the manifest left byte-identical**). Static source inspection establishes exactly how each of the four ingestion scripts connects, which of them can already target an explicitly named database, and which require small, enumerated source-level changes (not implemented in this stage). All four jobs can be isolated from `test` and from PID 22784, but **none of the four can target `krishi_mama` as-is without a source-level change**, because each either bypasses the shared helper or never passes a database name.

## 2. Approved target and manifest (approvals 1 & 2 — already provided by you)

| Approval | Status | Content |
|---|---|---|
| 1. Target database name | ✅ provided | `krishi_mama` |
| 2. Manifest | ✅ provided | `data/ingestion/stage6_ingestion_manifest.json` — 101 accepted / 17 rejected |
| 3. Source-level execution-plan approval | ⏳ pending | this report's plan + enumerated source changes |
| 4. MongoDB connection approval | ⏳ pending | not requested yet |
| 5. Ingestion/write approval | ⏳ pending | not requested yet |

**Manifest integrity anchor (recorded so silent rewriting is detectable):**
`SHA-256(stage6_ingestion_manifest.json) = 03a827e63755f74865c3103afeeb69236ba186d4d4ca60ad08d6885766face58`

## 3. Manifest reconciliation (offline verification results)

| Check | Result |
|---|---|
| Dataset totals: POWER 84 / SMAP 3 / GPM 8 / MODIS 6, total 101 | ✅ exact |
| Rejects: 13 SMAP fill + 4 SMAP flag-9, total 17 | ✅ exact |
| Unique compound keys within each dataset | ✅ 84/84, 3/3, 8/8, 6/6 unique |
| Every record has provenance | ✅ 101/101 |
| SMAP/GPM/MODIS records carry SHA-256 references | ✅ (source file or upstream CSV hashes) |
| **POWER records carry SHA-256 references** | ⚠️ **0/84** — they reference `responseFile` paths but no hash field. **Gap disclosed; manifest NOT rewritten.** Remediation evidence computed this stage (see below); adding the hashes requires a manifest-regeneration approval. |
| Every record has a valid expected operation | ✅ 101/101; 17/17 rejects marked `reject` |
| No rejected record appears in the accepted list | ✅ 0 overlaps |
| No missing/invalid measurement converted to zero | ✅ clean — the 13 zero values are all POWER `quality: "ok"` genuine zeros (e.g., PRECTOTCORR 0.0 mm/day); sentinel records carry `value: null` |
| No daily-total record | ✅ 0 daily-total fields; GPM records are interval-level only |
| MODIS rank-1 marginal kept separate (`isReliableQuality: false`) | ✅ both rank-1 records |
| Referenced source-file hashes still match on disk | ✅ re-verified: 3 SMAP `.nc4`, 4 GPM `.HDF5`, MODIS results CSV |

**Remediation evidence for the POWER gap (computed this stage, hashes valid on disk):**

| File | SHA-256 |
|---|---|
| `data/power/raw/power_cumilla_20240101_20240107_response.json` | `6af622b8178ad3fd1dfe7e8b01c5f96ca2599a13df1da93f1d77bd5c12878113` |
| `data/power/raw/power_chattogram_20240101_20240107_response.json` | `43e5e852995b2a05b628a0f77578764ae5d53780b265ff0a5fd856389d10b577` |

Supplementary (same gap class, disclosed): the MODIS provenance references the upstream `results.csv` SHA-256 (verified ✅); the derived parsed-JSON file's own hash is not recorded in the manifest — computed here for the future plan: `0cc324d5cc93a7b7447e86b4a42e4ecb830a4c9c16e889daa1360141761b0d0a`.

## 4. Static database configuration audit (source inspection only, no connection)

| Question | Finding (source-level evidence) |
|---|---|
| Does the connection helper support explicit database selection? | **Yes.** `connectDatabase({ databaseName })` in `src/config/database.js` forwards `{ dbName: databaseName }` to `mongoose.connect` (lines 66–91). |
| Must `dbName` be passed? | **Yes, for every connection targeting `krishi_mama`** — `MONGODB_URI` contains no database name, and no script passes `dbName`, so everything currently resolves to the mongoose default database `test`. `MONGODB_TEST_URI` is not set, so `connectDatabase()` always uses `MONGODB_URI`. |
| Shared helper vs independent connection logic | **Shared helper:** `ingest-power.js` (line 51, `connectDatabase()` — no `databaseName` argument today). **Independent `mongoose.connect(process.env.MONGODB_URI)`:** `ingest-modis.js` (line 59), `ingest-gpm-pilot.js` (line 41), `ingest-smap-validated-file.js` (line 97), plus the `expand-*` jobs. |
| Does any script silently fall back to `test`? | **All of them** — with no db name in the URI and no `dbName` option, the mongoose default `test` is the effective target everywhere, including the running server. |
| Can the target be configured without modifying `.env`? | **Not as-is.** The `.env` path is forbidden, so the only route is a small source-level change per script (exact changes in §5). `connectDatabase({ databaseName: "krishi_mama" })` already exists as a mechanism for the shared-helper path — it just needs to be passed. |
| Can PID 22784 remain untouched? | **Yes.** Ingestion into `krishi_mama` does not require restarting, reconfiguring, or touching the backend process; it stays connected to `test` and is unaffected. |

> **Standing isolation warning (preserved):** a separate database name does **not** prove cluster-level isolation — `krishi_mama` would live on the same Atlas cluster (`ac-r5wtnka`, …`b5yy3pn.mongodb.net`) that PID 22784 serves from. Isolation is owner-confirmed (Stage 6), not structural.

## 5. Dataset-by-dataset execution plan (proposed order A→D; nothing executed)

### A. NASA POWER — 84 records

| Item | Value |
|---|---|
| Script path | `server/src/jobs/ingest-power.js` |
| Required arguments | `--district cumilla --start 2024-01-01 --end 2024-01-07`, then `--district chattogram --start 2024-01-01 --end 2024-01-07` (2 runs) |
| Connects to MongoDB? | Yes — shared `connectDatabase()`; **currently targets `test`** |
| Operations | Live POWER API re-request per chunk → pure validator → per-day upserts into `nasaobservations`; sentinel/absent stored as quality flags, never zero; run journal in `dataingestionlogs` |
| Explicit-db safe? | **After a one-line source change** (see §7) — otherwise falls back to `test` |
| Expected counts (fresh `krishi_mama`) | 84 accepted · 0 skipped · 0 rejected |
| Idempotency | Unique `(districtCode, parameter, dateLabel)`; `--resume` skips already-stored chunks |
| Failure/recovery | Per-chunk failure logged and the run continues/fails per chunk without partial silent state; any re-run is safe (idempotent upserts). Values re-fetched from the API must reconcile against the manifest (both derive from the same validated responses). |
| Scientific notes | Historical climate only, LST standard, never live weather; units from the verified catalog stamped per record. |

### B. NASA SMAP — 3 records

| Item | Value |
|---|---|
| Script path | `server/src/jobs/ingest-smap-validated-file.js` |
| Required arguments | 3 runs: `--file=data/smap/raw/cumilla/SMAP_L3_SM_P_E_20240102_R19240_001_subsetted.nc4 --district=cumilla` · same for `20240103_R19240_001` · `20240105_R19240_002` |
| Connects to MongoDB? | Yes — independent `mongoose.connect(MONGODB_URI)`; **currently targets `test`** |
| Operations | Python parser → strict gates (bbox, flags 0/8, recommended, physical range, ≤25 km, source-history URL match) → insert-only `$setOnInsert` upserts; baseline fingerprint compared before/after |
| Explicit-db safe? | **After a source change** (see §7) |
| Expected counts (fresh `krishi_mama`) | 3 accepted · 0 skipped · **17 rejected stay excluded** (13 fill, 4 flag-9) |
| Idempotency | Unique `(districtCode, dateLabel, orbit)`; `$setOnInsert` makes re-runs no-ops |
| Failure/recovery | **Fails closed** — any gate violation throws before connect; zero writes. |
| ⚠️ **Critical incompatibility found** | The script enforces `before.length !== 4 → abort` ("Expected preserved SMAP baseline of 4"). In a **fresh** `krishi_mama` database this guard fails (found 0) and the script would refuse to write. This is a scientific safety guard, so it must not be silently bypassed — the source change required is a documented, owner-approved condition (e.g., accept an empty collection only when a `--fresh-database` flag is passed). Until then this dataset is **source-blocked for the fresh-DB path**. |
| Scientific notes | Surface soil moisture, approximately the **top 5 cm** (`m³/m³`) — explicitly **not** root-zone moisture. |

### C. NASA GPM — 8 records

| Item | Value |
|---|---|
| Script path | `server/src/jobs/ingest-gpm-pilot.js` |
| Required arguments | **None available** — the pilot granule (`3B-HHR…20240101-S000000…0000.V07B.HDF5`) is hardcoded |
| Connects to MongoDB? | Yes — independent `mongoose.connect(MONGODB_URI)`; **currently targets `test`** |
| Operations | Python parser → `validateGpmObservation` → `bulkWrite` `$setOnInsert` upserts into `gpmobservations` |
| Explicit-db safe? | **After a source change** (see §7) |
| Expected counts (fresh `krishi_mama`) | **2 of 8** as-is (pilot granule × 2 districts); the remaining **6 require parameterization** (e.g., a `--granules=` argument like the Stage-3 download script) — source change required |
| Idempotency | Unique `(districtCode, granuleId)`; `$setOnInsert` re-run-safe |
| Failure/recovery | Validation failures throw **before** connect (fails closed); partial-bulk behavior is `ordered: true` |
| Scientific notes | Interval records preserved exactly; **no daily totals**; local days 2024-01-01 (3/48) and 2024-01-02 (1/48) remain **incomplete**; UTC+6 day labels preserved; missing intervals never inferred. |

### D. NASA MODIS — 6 records

| Item | Value |
|---|---|
| Script path | `server/src/jobs/ingest-modis.js` |
| Required arguments | `--confirm` (writes only with this flag; without it the script returns **before** any connect — proven in Stage 5) |
| Connects to MongoDB? | Yes **only with `--confirm`** — independent `mongoose.connect(uri)`; **currently targets `test`** |
| Operations | Loads parsed observations JSON → two upsert passes over `modisobservations` → read-back field verification → cross-collection guard (counts `smapobservations`) |
| Explicit-db safe? | **After a source change** (see §7) |
| Expected counts (fresh `krishi_mama`) | 6 accepted (4 rank-0 primary, 2 rank-1 marginal **separate**, `isReliableQuality: false`) |
| Idempotency | Unique `(districtCode, dateLabel)`; pass-2 must report 0 new upserts |
| Failure/recovery | Idempotency/read-back checks `process.exit(1)` **after** writes if they fail — recovery is a re-run (idempotent), disclosed honestly here. The `smapobservations` count guard is meaningless against a fresh DB (it would read 0 both times — still consistent, but should be interpreted accordingly). |
| ⚠️ Source-path note | The script reads `parsed_modis_observations.json` (the 2026-11-08 file — content identical in keys and values to the manifest's 6 records, verified in Stage 6). To bind ingestion to the approved manifest provenance exactly, the path should point to the task-stamped file/manifest — small source change. |
| Scientific notes | Rank-1 never mixed with rank-0 for primary recommendations; composite dates + DOY + AppEEARS task provenance preserved. |

## 6. Safety and isolation risks (summary)

1. **All four scripts currently write to `test`** — running any of them unmodified would violate the approved target. This is the single biggest risk and the reason no script was executed.
2. **Same cluster as PID 22784** — `krishi_mama` is not structurally isolated; only owner confirmation and careful targeting protect the backend's data.
3. **SMAP baseline guard** assumes the `test` history (4 records) and will abort in a fresh DB — must be addressed by an owner-approved, documented source change, not bypassed.
4. **GPM script coverage** is 2 of 8 records until parameterized.
5. **MODIS post-write failure semantics** exit after writes — acceptable because writes are idempotent, but operators must know re-run == fix.
6. **POWER re-fetch** touches the live API again (network + throttle discipline); the alternative (ingesting from the saved validated responses) would be a new script — either choice needs plan approval.

## 7. Exact source-level changes required (enumerated, NOT implemented)

| # | File | Change | Why |
|---|---|---|---|
| 1 | `src/jobs/ingest-power.js` | Call `connectDatabase({ databaseName: "krishi_mama" })` (or accept `--db=` and forward it) | target an explicit DB through the existing helper |
| 2 | `src/jobs/ingest-smap-validated-file.js` | Add `{ dbName: "krishi_mama" }` to `mongoose.connect` (line 97) **and** an owner-approved `--fresh-database` behavior for the 4-record baseline guard | fresh-DB path must not trip the scientific guard |
| 3 | `src/jobs/ingest-gpm-pilot.js` | Add `{ dbName: "krishi_mama" }` (line 41) **and** optional `--granules=` parameterization (bounded to the 4 approved granule IDs) | target + cover all 8 records |
| 4 | `src/jobs/ingest-modis.js` | Add `{ dbName: "krishi_mama" }` to `mongoose.connect` (line 59) and point the parsed-data path at the manifest/task-stamped source | target + exact provenance binding |
| 5 | `data/ingestion/stage6_ingestion_manifest.json` | *(optional, needs approval)* add POWER response-file SHA-256 fields and the MODIS parsed-JSON hash | close the disclosed provenance gap |

No schema or index change is required anywhere — the models already carry all compound unique indexes, and Mongoose creates them on first connection.

## 8. Future preflight checklist (design — to run at execution time, not now)

1. Manifest SHA-256 equals the recorded anchor `03a827e6…face58` (manifest not silently rewritten).
2. The target database name reported by the live connection equals exactly `krishi_mama` (`mongoose.connection.name`), never `test`.
3. Every job's connection goes through the same explicit-`dbName` path; a negative check confirms no script resolves to `test`.
4. Compound unique keys of all four models exist in `krishi_mama` (index presence check) before any write.
5. Pre-write count snapshot of all five collections in `krishi_mama` (expected 0 in a fresh DB).
6. `test` database baseline counts (POWER 109,572 / GPM 672 / SMAP 5 / MODIS 10) re-read **read-only** before and after execution — unchanged.
7. PID 22784 health endpoint reports the same state as before execution (its `test` connection untouched).
8. Source file hashes re-verified against the manifest (SMAP `.nc4`, GPM `.HDF5`, MODIS CSV, POWER responses).
9. Per-dataset post-write reconciliation: accepted = 84/3/8/6 (total 101), rejects 17 (never inserted), zero duplicates, pass-2 upserts = 0.
10. MODIS rank-1 records present but `isReliableQuality: false` and excluded from any primary-recommendation query path.
11. GPM: exactly 8 interval records; no daily-total document exists anywhere.
12. Sentinel/absent/fill values: zero records where a flagged measurement carries a non-null value or a 0.

## 9. Future post-ingestion read-only verification plan (design — not run)

A single offline verification script (no writes) would:

1. Connect **read-only intent** to `krishi_mama` and enumerate counts per collection: expect `nasaobservations` 84, `smapobservations` 3, `gpmobservations` 8, `modisobservations` 6 — total 101.
2. Pull all keys and compare set-equality against the manifest's 101 unique keys (dataset by dataset) — zero missing, zero extra.
3. For each stored record, verify quality/provenance fields against the manifest row (SMAP flags 0/8 only; GPM `sourceQuality: valid`; MODIS rank & marginal separation; POWER `timeStandard: LST` with units from the catalog).
4. Re-verify the 17 rejects are absent from the database (by unique key).
5. Re-read the `test` baselines and PID 22784's health endpoint read-only, confirming both untouched.
6. Emit a machine-readable reconciliation JSON; any mismatch aborts further stages and is reported honestly.

## 10. Unverified items and blockers (cannot be verified without connecting — not attempted)

| Item | Why unverified |
|---|---|
| Actual creation/health of the `krishi_mama` database (it does not exist yet) | Requires a connection — MongoDB creates a database on first write; creation semantics will be confirmed at execution time |
| URI user's write privileges on a new database | Requires a live authorization check — reported as unverified, to be confirmed in the connection-approval step |
| Index creation timing in the fresh DB (Mongoose `Model.init()`) | Requires a connection; behavior is documented in code, live confirmation deferred |
| PID 22784's exact runtime environment variables | Inspecting the live process was off-limits; its code path (`connectDatabase()` with the same `.env`) is the evidence used |

## 11. Explicit statement

**No MongoDB connection, query, ingestion, or database write occurred in this stage.** No ingestion script was executed (not even with dry-run flags beyond the previously proven safe MODIS dry-run of Stage 5). No `.env`, credential, schema, index, source file, or Git state was modified; PID 22784 was never touched. Every finding above comes from static code inspection, local manifest inspection, and offline hash verification.

---

**Final verdict: READY FOR SOURCE-LEVEL EXECUTION-PLAN REVIEW.** The manifest is verified (with one disclosed POWER provenance gap and remediation evidence), the target mechanics are fully understood, and the exact minimal source changes for an isolated `krishi_mama` ingestion are enumerated. Approvals 3 (plan + source changes), 4 (connection), and 5 (writes) remain with you.
