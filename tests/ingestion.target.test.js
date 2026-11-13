/**
 * Stage 8 — offline ingestion-target safety tests (zero MongoDB connection).
 *
 * 1. Unit: assertIngestionTarget fails closed for anything but krishi_mama.
 * 2. Static: all four NASA ingestion jobs select krishi_mama explicitly and
 *    call the runtime guard, so no job can silently fall back to `test`.
 * 3. Integrity: the approved Stage-6 manifest still matches its SHA-256 anchor.
 * 4. Allowlists: GPM granule IDs and SMAP keys hard-coded in the jobs match the
 *    manifest exactly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { INGESTION_TARGET_DATABASE, assertIngestionTarget } from "../src/config/ingestionTarget.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf-8");

test("INGESTION_TARGET_DATABASE is exactly krishi_mama", () => {
  assert.equal(INGESTION_TARGET_DATABASE, "krishi_mama");
});

test("assertIngestionTarget fails closed for every non-target connection", () => {
  assert.doesNotThrow(() => assertIngestionTarget({ name: "krishi_mama" }));
  assert.throws(() => assertIngestionTarget({ name: "test" }), /ABORT/);
  assert.throws(() => assertIngestionTarget({ name: "" }), /ABORT/);
  assert.throws(() => assertIngestionTarget({}), /ABORT/);
  assert.throws(() => assertIngestionTarget(null), /ABORT/);
  assert.throws(() => assertIngestionTarget(undefined), /ABORT/);
  // The thrown error must never mention writing on a wrong target.
  try {
    assertIngestionTarget({ name: "test" });
    assert.fail("guard did not throw");
  } catch (error) {
    assert.match(String(error.message), /Zero writes performed/);
  }
});

const POWER_JOB = "src/jobs/ingest-power.js";
const SMAP_JOB = "src/jobs/ingest-smap-validated-file.js";
const GPM_JOB = "src/jobs/ingest-gpm-pilot.js";
const MODIS_JOB = "src/jobs/ingest-modis.js";

test("ingest-power.js selects the approved target and asserts it", () => {
  const src = read(POWER_JOB);
  assert.match(src, /INGESTION_TARGET_DATABASE, assertIngestionTarget/);
  assert.match(src, /connectDatabase\(\{ databaseName: INGESTION_TARGET_DATABASE \}\)/);
  assert.match(src, /assertIngestionTarget\(mongoose\.connection\)/);
});

test("ingest-smap-validated-file.js selects the approved target and asserts it", () => {
  const src = read(SMAP_JOB);
  assert.match(src, /INGESTION_TARGET_DATABASE, assertIngestionTarget/);
  assert.match(src, /dbName: INGESTION_TARGET_DATABASE/);
  assert.match(src, /assertIngestionTarget\(mongoose\.connection\)/);
});

test("ingest-gpm-pilot.js selects the approved target and asserts it", () => {
  const src = read(GPM_JOB);
  assert.match(src, /INGESTION_TARGET_DATABASE, assertIngestionTarget/);
  assert.match(src, /dbName: INGESTION_TARGET_DATABASE/);
  assert.match(src, /assertIngestionTarget\(mongoose\.connection\)/);
});

test("ingest-modis.js selects the approved target and asserts it", () => {
  const src = read(MODIS_JOB);
  assert.match(src, /INGESTION_TARGET_DATABASE, assertIngestionTarget/);
  assert.match(src, /dbName: INGESTION_TARGET_DATABASE/);
  assert.match(src, /assertIngestionTarget\(mongoose\.connection\)/);
});

test("ingest-modis.js keeps the --confirm dry-run gate before any connection", () => {
  const src = read(MODIS_JOB);
  const dryRunReturn = src.indexOf("return;");
  const connectCall = src.indexOf("mongoose.connect");
  assert.ok(dryRunReturn !== -1 && connectCall !== -1 && dryRunReturn < connectCall,
    "dry-run must return before mongoose.connect");
  assert.match(src, /parsed_modis_observations_e0405649-2665-439d-87eb-a08608108fcd\.json/);
});

test("approved Stage-6 manifest still matches its SHA-256 integrity anchor", () => {
  const manifestPath = path.resolve(__dirname, "../data/ingestion/stage6_ingestion_manifest.json");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");
  assert.equal(sha, "03a827e63755f74865c3103afeeb69236ba186d4d4ca60ad08d6885766face58");
});

test("GPM job allowlist equals the manifest-approved granule IDs", () => {
  const manifest = JSON.parse(read("data/ingestion/stage6_ingestion_manifest.json"));
  const approved = [...new Set(manifest.records.filter((r) => r.dataset === "GPM").map((r) => r.provenance.granuleId))].sort();
  const src = read(GPM_JOB);
  const listed = [...src.matchAll(/"(3B-HHR\.MS\.MRG\.3IMERG\.[^"]+\.V07B\.HDF5)"/g)].map((m) => m[1]).sort();
  assert.equal(JSON.stringify(listed), JSON.stringify(approved));
});

test("SMAP job approved-key set equals the manifest-approved SMAP records", () => {
  const manifest = JSON.parse(read("data/ingestion/stage6_ingestion_manifest.json"));
  const approved = manifest.records.filter((r) => r.dataset === "SMAP")
    .map((r) => `${r.uniqueKey.districtCode}|${r.uniqueKey.dateLabel}|${r.uniqueKey.orbit}`).sort();
  const src = read(SMAP_JOB);
  const listed = [...src.matchAll(/"(cumilla\|2024-01-\d\d\|(?:AM|PM))"/g)].map((m) => m[1]).sort();
  assert.equal(JSON.stringify(listed), JSON.stringify(approved));
});
