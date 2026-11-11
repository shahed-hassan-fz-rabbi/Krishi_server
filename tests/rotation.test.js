import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import rotations from "../src/routes/v1/rotation.routes.js";
import assistant from "../src/routes/v1/assistant.routes.js";
import { compareRotations, validateRotationInput, explainRotationComparison } from "../src/services/rotation.service.js";
import { snapshotService } from "../src/services/snapshot.service.js";
import { User } from "../src/models/user.model.js";
import { Farm } from "../src/models/farm.model.js";
import { RotationPlan } from "../src/models/rotationplan.model.js";
import { signToken } from "../src/utils/token.util.js";
import { errorHandler } from "../src/middleware/error.middleware.js";
import { calendarMonths, checkCropClimate } from "../src/services/rotation-climate.service.js";

const input = { districtCode: "cumilla", baseline: ["monsoon_aman", "boro_rice"], soilType: "unknown", irrigation: "available", drainage: "good", priority: "water" };

test("climate checks match historical months to real stage ranges, including winter rollover", () => {
  assert.deepEqual(calendarMonths([45, 6]), [11, 12, 1, 2]);
  const local = { standardWeeksRange: [45, 6], stages: [{ stageId: "test", standardWeeks: [45, 6], optimalTempRange: [15, 27] }] };
  const snapshot = { data: { temperature: { monthly_historical: {} }, rainfall: { monthly_historical: {} } } };
  for (const month of [11, 12, 1, 2]) {
    snapshot.data.temperature.monthly_historical[month] = { years_used: 25, stats: { count: 25, mean: 20 } };
    snapshot.data.rainfall.monthly_historical[month] = { years_used: 25, stats: { count: 25, mean: 0 } };
  }
  const matched = checkCropClimate(local, snapshot);
  assert.equal(matched.outsideTemperatureChecks, 0);
  assert.equal(matched.checks.length, 4);
  assert.equal(matched.rainfall[0].meanMm, 0);
  snapshot.data.temperature.monthly_historical[11].stats.mean = 30;
  assert.equal(checkCropClimate(local, snapshot).outsideTemperatureChecks, 1);
  snapshot.data.temperature.monthly_historical[11].stats.mean = -999;
  assert.equal(checkCropClimate(local, snapshot).missingTemperatureChecks, 1);
  assert.equal(checkCropClimate(local, null).checks.length, 0);
  assert.equal(checkCropClimate(local, null).missingTemperatureChecks, 4);
});

test("rotation review changes when the NASA record changes, without modifying the farmer baseline", () => {
  const original = snapshotService.getClimateSnapshot;
  try {
    const snapshot = structuredClone(original.call(snapshotService, "cumilla"));
    snapshotService.getClimateSnapshot = () => snapshot;
    for (const row of Object.values(snapshot.data.temperature.monthly_historical)) row.stats.mean = 20;
    const cool = compareRotations(input);
    for (const row of Object.values(snapshot.data.temperature.monthly_historical)) row.stats.mean = 45;
    const hot = compareRotations(input);
    assert.notEqual(cool.strategies[0].climateCheck.outside, hot.strategies[0].climateCheck.outside);
    assert.ok(hot.strategies[0].warnings.includes("climate_temperature_review"));
    assert.deepEqual(hot.strategies[0].cropCodes, input.baseline);
    snapshotService.getClimateSnapshot = () => null;
    assert.ok(compareRotations(input).strategies.every((strategy) => strategy.warnings.includes("climate_data_missing")));
  } finally { snapshotService.getClimateSnapshot = original; }
});

test("fallback explanation uses real results in either language without changing the decision", () => {
  const result = compareRotations(input);
  const original = JSON.stringify(result);
  const answer = explainRotationComparison(result, "en");
  assert.ok(answer.includes(String(result.strategies[0].waterRequirementMm)));
  assert.ok(answer.includes("not an irrigation estimate"));
  assert.ok(explainRotationComparison(result, "bn").includes("পরের ধাপ"));
  assert.equal(JSON.stringify(result), original);
});

test("screening preserves the actual baseline and produces distinct alternatives without inventing measurements", () => {
  const result = compareRotations(input);
  assert.deepEqual(result.strategies[0].cropCodes, input.baseline);
  assert.equal(result.strategies.length, 3);
  assert.equal(new Set(result.strategies.map((s) => [...s.cropCodes].sort().join())).size, 3);
  assert.ok(result.strategies[0].warnings.includes("soil_unknown"));
  assert.ok(result.strategies.every((s) => s.status !== "recommended"));
  assert.ok(result.evidence.power.period.start);
  assert.equal(result.method, "calendar_and_historical_climate_screening");
  assert.ok(result.limitations.includes("monthly_not_daily"));
  assert.ok(result.strategies[0].climateCheck.checked > 0);
});

test("cross-year envelopes are counted and overlapping winter crops require review", () => {
  const result = compareRotations({ ...input, baseline: ["boro_rice", "mustard"] });
  const baseline = result.strategies[0];
  assert.ok(baseline.timeline.some((row) => row.startWeek > row.endWeek));
  assert.ok(baseline.warnings.includes("calendar_overlap"));
  assert.ok(baseline.uncoveredCalendarWeeks >= 0 && baseline.uncoveredCalendarWeeks <= 52);
  assert.equal(baseline.waterRequirementMm, baseline.timeline.reduce((n, row) => n + row.waterRequirementMm, 0));
});

test("priority ordering never overrides absent irrigation and inputs are validated", () => {
  const result = compareRotations({ ...input, priority: "diversity", irrigation: "unavailable" });
  assert.equal(result.strategies[0].status, "constrained");
  assert.ok(result.strategies[0].warnings.includes("boro_no_irrigation"));
  for (const bad of [null, {}, { ...input, baseline: [] }, { ...input, baseline: ["mustard", "mustard"] }, { ...input, districtCode: "dhaka" }, { ...input, baseline: ["mungbean"] }, { ...input, priority: {} }]) {
    assert.throws(() => validateRotationInput(bad), { statusCode: 400 });
  }
});

test("bad QA, sentinels and missing snapshots stay unavailable", () => {
  const original = snapshotService.getSmapSnapshot;
  try {
    snapshotService.getSmapSnapshot = () => ({ observations: [{ dateLabel: "2025-01-01", soilMoisture: -9999, isRecommendedQuality: true }] });
    const evidence = compareRotations(input).evidence.smap;
    assert.equal(evidence.value, null);
    assert.equal(evidence.usable, false);
    snapshotService.getSmapSnapshot = () => null;
    assert.equal(compareRotations(input).evidence.smap.provenance, "UNAVAILABLE");
  } finally { snapshotService.getSmapSnapshot = original; }
});

test("HTTP access and persistence enforce authenticated ownership; client results are not trusted", async () => {
  const app = express(); app.use(express.json()); app.use("/rotations", rotations); app.use("/assistant", assistant); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originals = { findUser: User.findById, findFarm: Farm.findOne, create: RotationPlan.create, find: RotationPlan.find };
  const userId = "507f1f77bcf86cd799439011";
  User.findById = async () => ({ _id: userId });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${signToken({ _id: userId, email: "rotation-test@example.test", role: "farmer" })}` };
  try {
    const publicResponse = await fetch(base + "/rotations/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(publicResponse.status, 200);
    assert.equal((await publicResponse.json()).data.strategies.length, 3);
    assert.equal((await fetch(base + "/rotations/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, districtCode: "invalid" }) })).status, 400);
    for (const [path, method] of [["/rotations/compare", "POST"], ["/rotations/plans", "GET"], ["/rotations/plans", "POST"], ["/rotations/explain", "POST"], ["/assistant/chat", "POST"]]) {
      assert.equal((await fetch(base + path, { method })).status, 401, path);
    }
    const compared = await fetch(base + "/rotations/compare", { method: "POST", headers, body: JSON.stringify(input) });
    assert.equal(compared.status, 200);
    const strategy = (await compared.json()).data.strategies[0];
    let captured;
    RotationPlan.create = async (payload) => { captured = payload; return { ...payload, _id: "test" }; };
    let saved = await fetch(base + "/rotations/plans", { method: "POST", headers, body: JSON.stringify({ input, selectedStrategyId: strategy.id, userId: "attacker", comparison: { fake: true } }) });
    assert.equal(saved.status, 201);
    assert.equal(captured.userId, userId);
    assert.equal(captured.comparison.version, "rotation-screening-v2");
    let filter;
    Farm.findOne = (query) => { filter = query; return { lean: async () => null }; };
    saved = await fetch(base + "/rotations/plans", { method: "POST", headers, body: JSON.stringify({ input, selectedStrategyId: strategy.id, farmId: "507f1f77bcf86cd799439012" }) });
    assert.equal(saved.status, 404);
    assert.equal(String(filter.userId), userId);
    RotationPlan.find = (query) => { filter = query; return { sort: () => ({ limit: () => ({ lean: async () => [] }) }) }; };
    assert.equal((await fetch(base + "/rotations/plans", { headers })).status, 200);
    assert.equal(filter.userId, userId);
    assert.equal((await fetch(base + "/rotations/compare", { method: "POST", headers, body: JSON.stringify({ ...input, baseline: [] }) })).status, 400);
  } finally {
    User.findById = originals.findUser; Farm.findOne = originals.findFarm; RotationPlan.create = originals.create; RotationPlan.find = originals.find;
    await new Promise((resolve) => server.close(resolve));
  }
});
