import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../src/services/nasa/fetch-with-retry.js";
import { searchSmapGranules } from "../src/services/nasa/smap.client.js";
import { persistValidatedSmapObservations } from "../src/services/nasa/smap.persistence.js";
import { SMAP } from "../src/config/smap.config.js";

const response = (status, body = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(),
  json: async () => body,
});

test("bounded NASA retry backs off on transient network failure and then succeeds", async () => {
  let calls = 0;
  const delays = [];
  const result = await fetchWithRetry("https://cmr.example.test", {}, {
    attempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 50,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("simulated network unavailable");
      return response(200);
    },
    sleepImpl: async (ms) => delays.push(ms),
  });

  assert.equal(result.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("NASA 401 authentication failure is not retried", async () => {
  let calls = 0;
  const result = await fetchWithRetry("https://harmony.example.test", {}, {
    fetchImpl: async () => { calls += 1; return response(401); },
    sleepImpl: async () => assert.fail("401 must not be retried"),
  });
  assert.equal(result.status, 401);
  assert.equal(calls, 1);
});

test("CMR discovery uses district-specific bounds and deduplicates real granules", async () => {
  let requestedUrl;
  const granule = {
    id: "G1",
    title: "SMAP_L3_SM_P_E_20240105_R19240_001.h5",
    updated: "2024-01-06T00:00:00Z",
    links: [{ href: "https://nsidc.org/data/G1.h5?download=1", rel: "http://esipfed.org/ns/fedsearch/1.1/data#" }],
  };
  const results = await searchSmapGranules({
    startDate: "2024-01-05",
    endDate: "2024-01-06",
    districtCode: "chattogram",
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return response(200, { feed: { entry: [granule, granule, { ...granule, id: "G2", title: "bad title" }] } });
    },
  });

  assert.equal(requestedUrl.searchParams.get("bounding_box"), "91.3,21.8,92.4,22.9");
  assert.equal(requestedUrl.searchParams.get("collection_concept_id"), SMAP.collectionConceptId);
  assert.equal(requestedUrl.searchParams.get("temporal"), "2024-01-05T00:00:00Z,2024-01-06T23:59:59Z");
  assert.equal(results.length, 1);
  assert.equal(results[0].granuleId, "G1");
  assert.equal(results[0].dateLabel, "2024-01-05");
});

test("CMR discovery rejects invalid ranges and unsupported districts before networking", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response(200); };
  await assert.rejects(searchSmapGranules({ startDate: "2024-02-30", endDate: "2024-03-01", fetchImpl }), /valid ordered/);
  await assert.rejects(searchSmapGranules({ startDate: "2024-03-01", endDate: "2024-02-28", fetchImpl }), /valid ordered/);
  await assert.rejects(searchSmapGranules({ startDate: "2024-01-01", endDate: "2024-01-01", districtCode: "dhaka", fetchImpl }), /does not support district/);
  assert.equal(calls, 0);
});

test("CMR authentication failures remain distinct and do not retry", async () => {
  let calls = 0;
  await assert.rejects(searchSmapGranules({
    startDate: "2024-01-05",
    endDate: "2024-01-05",
    fetchImpl: async () => { calls += 1; return response(401); },
  }), /CMR_SEARCH_FAILED: HTTP 401/);
  assert.equal(calls, 1);
});

test("CMR network unavailability stops after the bounded retry count", async () => {
  let calls = 0;
  await assert.rejects(searchSmapGranules({
    startDate: "2024-01-05",
    endDate: "2024-01-05",
    fetchImpl: async () => { calls += 1; throw new Error("fetch failed"); },
  }), /fetch failed/);
  assert.equal(calls, 3);
});

test("validated observation persistence is isolated, deduplicated, and insert-only", async () => {
  const calls = [];
  let countCalls = 0;
  const model = {
    async init() { calls.push({ type: "init" }); },
    async countDocuments() { countCalls += 1; return countCalls === 1 ? 4 : 5; },
    async updateOne(filter, update, options) {
      calls.push({ type: "update", filter, update, options });
      return { upsertedCount: 1 };
    },
  };
  const observation = {
    districtCode: "chattogram",
    dateLabel: "2024-01-05",
    orbit: "AM",
    soilMoisture: 0.2741,
    retrievalQualityFlag: 8,
    isRecommendedQuality: true,
    qualityClassification: "recommended",
    latitude: 22.34,
    longitude: 91.83,
    ingestionRunId: "offline-test-run",
  };
  const result = await persistValidatedSmapObservations([observation, { ...observation }], { model });
  const updates = calls.filter((call) => call.type === "update");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].filter, { districtCode: "chattogram", dateLabel: "2024-01-05", orbit: "AM" });
  assert.deepEqual(updates[0].update, { $setOnInsert: observation });
  assert.equal(updates[0].options.upsert, true);
  assert.deepEqual(result, { baselineCount: 4, finalCount: 5, inserted: 1, baselinePreserved: true });
});

test("persistence rejects quality flag 9 and missing coordinates before touching storage", async () => {
  let storageTouched = false;
  const model = {
    async init() { storageTouched = true; },
    async countDocuments() { storageTouched = true; return 0; },
    async updateOne() { storageTouched = true; return { upsertedCount: 1 }; },
  };
  const validShape = {
    districtCode: "chattogram", dateLabel: "2024-01-05", orbit: "AM", soilMoisture: 0.27,
    retrievalQualityFlag: 9, isRecommendedQuality: false, qualityClassification: "not_recommended",
    latitude: 22.34, longitude: 91.83,
  };
  await assert.rejects(persistValidatedSmapObservations([validShape], { model }), /fails the recommended-quality gate/);
  await assert.rejects(persistValidatedSmapObservations([{ ...validShape, retrievalQualityFlag: 0, isRecommendedQuality: true, qualityClassification: "recommended", latitude: null }], { model }), /invalid measurement\/geolocation/);
  await assert.rejects(persistValidatedSmapObservations([{ ...validShape, retrievalQualityFlag: 0, isRecommendedQuality: true, qualityClassification: "recommended", latitude: 24.5 }], { model }), /invalid measurement\/geolocation/);
  await assert.rejects(persistValidatedSmapObservations([{ ...validShape, dateLabel: "2024-02-30", retrievalQualityFlag: 0, isRecommendedQuality: true, qualityClassification: "recommended" }], { model }), /invalid district, date, or orbit/);
  assert.equal(storageTouched, false);
});
