/** Deterministic HTTP validation tests. No MongoDB connection is opened. */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import "../src/config/env.config.js";
import { createApp } from "../src/app.js";

let server;
let baseUrl;

before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
      resolve();
    });
  });
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
});

test("unknown districts are rejected before database access", async () => {
  const res = await fetch(`${baseUrl}/climate/summary?district=sylhet`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, "INVALID_DISTRICT");
  assert.ok(body.error.message.includes("chattogram"));
});

test("malformed, inverted, and out-of-bounds dates are rejected before database access", async () => {
  const malformed = await fetch(`${baseUrl}/climate/rainfall?district=chattogram&from=2021-02-31`);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_DATE");

  const inverted = await fetch(`${baseUrl}/climate/rainfall?district=chattogram&from=2021-12-31&to=2021-01-01`);
  assert.equal(inverted.status, 400);
  assert.equal((await inverted.json()).error.code, "INVALID_DATE_RANGE");

  const outOfBounds = await fetch(`${baseUrl}/climate/rainfall?district=chattogram&from=1999-01-01`);
  assert.equal(outOfBounds.status, 400);
  assert.equal((await outOfBounds.json()).error.code, "DATE_OUT_OF_BOUNDS");
});

test("unsupported temperature metrics are rejected before database access", async () => {
  const res = await fetch(`${baseUrl}/climate/temperature?district=chattogram&metric=fahrenheit`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, "INVALID_METRIC");
});

test("unsupported rainfall groupings are rejected before database access", async () => {
  const res = await fetch(`${baseUrl}/climate/rainfall?district=chattogram&grouping=hourly`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, "INVALID_GROUPING");
});

test("a missing district parameter is rejected before database access", async () => {
  const res = await fetch(`${baseUrl}/climate/summary`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "MISSING_DISTRICT");
});

test("unsupported crop transitions on handoff are rejected with 400", async () => {
  const res = await fetch(`${baseUrl}/climate/handoff?district=cumilla&transition=wheat-corn`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, "INVALID_CROP_TRANSITION");
});

test("unknown routes use the standard error envelope without stack details", async () => {
  const res = await fetch(`${baseUrl}/climate/unknown-subroute`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, "ROUTE_NOT_FOUND");
  assert.equal(body.error.details, undefined);
  assert.deepEqual(body.meta, {});
});
