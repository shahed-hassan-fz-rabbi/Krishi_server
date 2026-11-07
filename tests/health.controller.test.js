/** Pure freshness policy tests. No MongoDB connection is opened. */
import test from "node:test";
import assert from "node:assert/strict";

import { DATASET_FRESHNESS_WINDOW_MS, isDatasetFresh } from "../src/controllers/health.controller.js";

test("dataset freshness requires a recent verification and an observed date", () => {
  const now = new Date("2026-11-07T00:00:00.000Z");
  assert.equal(isDatasetFresh({ lastObservedDate: "2025-12-31", lastVerifiedAt: now }, now), true);
  assert.equal(isDatasetFresh({ lastObservedDate: "2025-12-31", lastVerifiedAt: new Date(now - DATASET_FRESHNESS_WINDOW_MS - 1) }, now), false);
  assert.equal(isDatasetFresh({ lastObservedDate: null, lastVerifiedAt: now }, now), false);
  assert.equal(isDatasetFresh({ lastObservedDate: "2025-12-31", lastVerifiedAt: "not-a-date" }, now), false);
  assert.equal(isDatasetFresh({ lastObservedDate: "2025-12-31", lastVerifiedAt: new Date(now.getTime() + 1) }, now), false);
});
