/**
 * Unit tests for Ingestion Service helper functions (zero network).
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateYearChunks } from "../src/services/nasa/ingestion.service.js";

test("generateYearChunks produces exactly 25 annual chunks for 2001-2025", () => {
  const chunks = generateYearChunks("2001-01-01", "2025-12-31");
  assert.equal(chunks.length, 25);
  assert.equal(chunks[0].year, 2001);
  assert.equal(chunks[0].startIso, "2001-01-01");
  assert.equal(chunks[0].endIso, "2001-12-31");
  assert.equal(chunks[24].year, 2025);
  assert.equal(chunks[24].startIso, "2025-01-01");
  assert.equal(chunks[24].endIso, "2025-12-31");
});

test("generateYearChunks handles partial year spans correctly", () => {
  const chunks = generateYearChunks("2021-06-01", "2023-03-31");
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].startIso, "2021-06-01");
  assert.equal(chunks[0].endIso, "2021-12-31");
  assert.equal(chunks[1].startIso, "2022-01-01");
  assert.equal(chunks[1].endIso, "2022-12-31");
  assert.equal(chunks[2].startIso, "2023-01-01");
  assert.equal(chunks[2].endIso, "2023-03-31");
});

test("generateYearChunks handles single year span", () => {
  const chunks = generateYearChunks("2024-01-01", "2024-12-31");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].year, 2024);
  assert.equal(chunks[0].startIso, "2024-01-01");
  assert.equal(chunks[0].endIso, "2024-12-31");
});
