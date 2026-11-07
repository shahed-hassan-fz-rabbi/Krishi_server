/**
 * Contract & Agreement tests for Python Scientific Processing CLI.
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { executePythonAnalysis } from "../src/services/climate/analysis.service.js";

test("Python CLI executes rainfall analysis cleanly via stdin/stdout contract", async () => {
  const snapshot = {
    district: "chattogram",
    parameters: ["PRECTOTCORR"],
    dateRange: { start: "2021-04-01", end: "2021-04-30" },
    observations: Array.from({ length: 30 }, (_, i) => ({
      dateLabel: `2021-04-${String(i + 1).padStart(2, "0")}`,
      parameter: "PRECTOTCORR",
      value: 10.0,
      quality: "ok",
      unit: "mm/day",
      timeStandard: "LST",
    })),
  };

  const envelope = await executePythonAnalysis({ snapshot, parameter: "PRECTOTCORR" });
  assert.equal(envelope.success, true);
  assert.equal(envelope.meta.district, "chattogram");
  assert.equal(envelope.meta.parameter, "PRECTOTCORR");
  assert.equal(envelope.meta.time_standard, "LST");
  assert.equal(envelope.meta.dataset_provenance, "nasa:power:daily:point");
  assert.equal(envelope.meta.formula_version, "v1.0.0-phase3");

  const april = envelope.data.monthly_series.find((m) => m.year === 2021 && m.month === 4);
  assert.ok(april);
  assert.equal(april.total_mm, 300.0);
  assert.equal(april.wet_days, 30);
  assert.equal(april.dry_days, 0);
  assert.equal(april.is_complete, true);
});

test("Python CLI calculates temperature summaries and diurnal ranges", async () => {
  const t2mObs = Array.from({ length: 31 }, (_, i) => ({
    dateLabel: `2021-01-${String(i + 1).padStart(2, "0")}`,
    parameter: "T2M",
    value: 20.0,
    quality: "ok",
    unit: "C",
  }));
  const maxObs = Array.from({ length: 31 }, (_, i) => ({
    dateLabel: `2021-01-${String(i + 1).padStart(2, "0")}`,
    parameter: "T2M_MAX",
    value: 25.0,
    quality: "ok",
    unit: "C",
  }));
  const minObs = Array.from({ length: 31 }, (_, i) => ({
    dateLabel: `2021-01-${String(i + 1).padStart(2, "0")}`,
    parameter: "T2M_MIN",
    value: 15.0,
    quality: "ok",
    unit: "C",
  }));

  const snapshot = {
    district: "cumilla",
    parameters: ["T2M", "T2M_MAX", "T2M_MIN"],
    dateRange: { start: "2021-01-01", end: "2021-01-31" },
    observations: [...t2mObs, ...maxObs, ...minObs],
  };

  const envelope = await executePythonAnalysis({ snapshot, parameter: "T2M" });
  assert.equal(envelope.success, true);
  assert.equal(envelope.meta.district, "cumilla");
  assert.equal(envelope.meta.parameter, "T2M");

  const jan = envelope.data.monthly_series.find((m) => m.year === 2021 && m.month === 1);
  assert.ok(jan);
  assert.equal(jan.mean_t2m, 20.0);
  assert.equal(jan.mean_max, 25.0);
  assert.equal(jan.mean_min, 15.0);
  assert.equal(jan.diurnal_range, 10.0);
});

test("Python CLI rejects malformed snapshots and non-supported districts", async () => {
  const badSnapshot = {
    district: "sylhet", // non-supported district
    parameters: ["T2M"],
    observations: [{ dateLabel: "2021-01-01", parameter: "T2M", value: 20, quality: "ok" }],
  };

  await assert.rejects(
    () => executePythonAnalysis({ snapshot: badSnapshot }),
    (err) => err.message.includes("Invalid or unsupported district")
  );
});
