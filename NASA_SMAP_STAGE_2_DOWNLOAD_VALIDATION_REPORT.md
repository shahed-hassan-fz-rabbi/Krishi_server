# NASA SMAP Stage 2 — Independent Artifact Verification

**Date:** 2026-11-13  
**Scope:** Local, read-only verification of the Stage 2 report and downloaded artifacts  
**Verdict:** **FOUR NEW SMAP SUBSETS PRESENT AND PARSER-VALIDATED; NO DATABASE INGESTION VERIFIED IN THIS AUDIT**

> This report supersedes the earlier status in this file, which was written while the network was returning `EACCES` and before the Stage 2 files appeared in the workspace. The later `NASA_SMAP_REAL_DATA_DOWNLOAD_AND_VALIDATION_REPORT.md` and artifacts were checked after they became available.

## What was independently checked

- Read `NASA_SMAP_REAL_DATA_DOWNLOAD_AND_VALIDATION_REPORT.md`.
- Confirmed four new district-specific `.nc4` subset files exist in `server/data/smap/raw/{cumilla,chattogram}` for 2024-01-04 and 2024-01-05.
- Re-ran `server/science/smap_parser.py` against each new file, without writing files or connecting to MongoDB.
- Calculated exact SHA-256 hashes locally; all match the prefixes/suffixes recorded in the Stage 2 report.
- Confirmed the pre-existing January 1–3 sample files remain in the district folders.
- Ran the existing focused regression tests: **11 passed, 0 failed**.

This independent check verifies the current files, parser output and quality decisions. The actual Harmony submission/download event is supported by the Stage 2 execution report and file hashes/timestamps; this audit did not repeat the network download.

## Newly present files and parser results

| District | File | Bytes | SHA-256 | Parser result |
|---|---|---:|---|---|
| Cumilla | `SMAP_L3_SM_P_E_20240104_R19240_001_subsetted.nc4` | 1,389,923 | `06916f5bccba6e992956655be3d22caa79c50934c45808b9f8822600b51e991c` | Parsed; AM/PM flag 7, fill and out-of-bounds pixels withheld |
| Cumilla | `SMAP_L3_SM_P_E_20240105_R19240_002_subsetted.nc4` | 1,417,121 | `8d822510818d79f887947d3a36311aa1f0d33087e6cfc05f54bb33fc95b91de6` | PM flag 8: 0.3497 m³/m³, recommended, in bounds; AM flag 7 withheld |
| Chattogram | `SMAP_L3_SM_P_E_20240104_R19240_001_subsetted.nc4` | 1,389,915 | `c6dfde996752dea453d3d20febb7ea5165be06091b224bee2c39b4fcd10bd610` | Parsed; AM/PM flag 7, fill and out-of-bounds pixels withheld |
| Chattogram | `SMAP_L3_SM_P_E_20240105_R19240_002_subsetted.nc4` | 1,412,672 | `862e7545fad89d31a93a11ac1fa20138284fcc8b371cb35abfda5888ce7449bf` | PM flag 9, plausible raw value 0.166 but rejected; AM flag 7 withheld |

The parser's selected pixel for each district/date is within the configured district bounding box only for the Cumilla Jan 5 PM and Chattogram Jan 5 PM cases; the Chattogram Jan 5 value remains rejected because retrieval flag 9 is not quality-approved. The Cumilla Jan 5 PM sample is recommended and 2.56 km from its reference point. The Chattogram Jan 5 PM sample is 1.45 km from its reference point but remains rejected by flag 9. Large-distance fallback pixels (~6,415–6,542 km) are flagged outside the district bounds and withheld.

Across these four new files, the independently observed approved count is **one** (Cumilla Jan 5 PM, flag 8). Chattogram has **zero** approved observations in the new files. These are sparse representative-point subset results, not continuous district coverage.

## Quality rule and tests

The current parser applies physical fill/range, retrieval bitmask and in-district location checks. Flag 8 is accepted when all other checks pass. Flag 9 is rejected even with a physically plausible non-null raw measurement. Fill values remain null/withheld rather than becoming zero. The test suite separately verifies only flags 0 and 8 pass and flag 9 fails.

Command from `server/`:

```text
node --test tests/smap.validator.test.js tests/python.contract.test.js
```

Result: **11 passed, 0 failed**. The four-file parser recheck also completed successfully. These results do not involve NASA network access or the live API.

## Download safety and source changes

The Stage 2 execution report documents that `download-smap-harmony.js` was changed to skip existing outputs, use exclusive `wx` creation, and retry downloads at most three times. Current source diff was read-only inspected and contains those safeguards plus the bounded timeouts already present. Existing January 1–3 files are still present, and the four new January 4–5 files use distinct filenames.

## Database and runtime boundary

- This independent verification made no MongoDB/Atlas connection, query, or write.
- The Stage 2 report states there was no ingestion; its job source contains no Mongoose/model dependency and writes only raw subset artifacts plus console output.
- PID 22784 was not restarted or terminated in this audit.
- `.env` and credentials were not changed or printed.
- Git history and stashes were not altered. Existing client/server dirty changes were preserved.

## Current status

Stage 2's requested real-data artifact goal is now supported by the Stage 2 execution report plus independent file/hash/parser verification. Cumilla has a small number of quality-approved samples across the January 1–5 pilot files; Chattogram's newly checked Jan 4–5 files contain no quality-approved samples. No data has been inserted into MongoDB.

GPM, MODIS, POWER collection and all database ingestion remain separate future stages. Do not treat this two-district, short-window SMAP sample as broad or continuous coverage.
