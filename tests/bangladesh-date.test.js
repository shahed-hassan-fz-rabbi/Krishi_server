import { test } from "node:test";
import assert from "node:assert/strict";
import { getBangladeshDateKey } from "../src/utils/bangladesh-date.js";

test("farm date workflows use Bangladesh civil date rather than UTC date", () => {
  assert.equal(getBangladeshDateKey(new Date("2025-01-01T20:00:00.000Z")), "2025-01-02");
  assert.equal(getBangladeshDateKey(new Date("2025-01-02T17:59:59.000Z")), "2025-01-02");
  assert.equal(getBangladeshDateKey(new Date("2025-01-02T18:00:00.000Z")), "2025-01-03");
});
