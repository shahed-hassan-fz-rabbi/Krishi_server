import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";

import "../src/config/env.config.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";

const testDatabaseName = `km_auth_${process.pid}_${randomUUID().slice(0, 8)}`;
let server;
let baseUrl;
let databaseConnected = false;

before(async () => {
  await connectDatabase({ databaseName: testDatabaseName, required: true });
  databaseConnected = true;
  assert.equal(mongoose.connection.name, testDatabaseName, "auth tests must use their isolated test database");

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
  if (!databaseConnected) return;
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.dropDatabase();
    }
  } finally {
    await disconnectDatabase();
  }
});

test("POST /auth/register creates a new user, hashes password, sets httpOnly cookie, and enforces role=farmer", async () => {
  const payload = {
    name: "Karim Farmer",
    email: "karim@krishimama.local",
    password: "SecurePassword123!",
    preferredDistrict: "chattogram",
    role: "admin", // Malicious privilege escalation attempt
  };

  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.user.name, "Karim Farmer");
  assert.equal(body.data.user.email, "karim@krishimama.local");
  assert.equal(body.data.user.preferredDistrict, "chattogram");
  assert.equal(body.data.user.role, "farmer"); // Server strictly overrode "admin"
  assert.equal(body.data.user.passwordHash, undefined); // Never exposed
  assert.ok(body.data.token, "JWT token should be returned");

  // Verify Set-Cookie header contains km_session and HttpOnly
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "Set-Cookie header must be present");
  assert.ok(setCookie.includes("km_session="));
  assert.ok(/httponly/i.test(setCookie));

  // Verify in database that password was hashed
  const storedUser = await User.findOne({ email: "karim@krishimama.local" }).select("+passwordHash");
  assert.ok(storedUser);
  assert.ok(storedUser.passwordHash.startsWith("$2"), "Password must be bcrypt hashed");
  assert.notEqual(storedUser.passwordHash, payload.password);
});

test("POST /auth/register rejects duplicate email with 409 Conflict", async () => {
  const payload = {
    name: "Karim Duplicate",
    email: "karim@krishimama.local",
    password: "AnotherPassword123!",
  };

  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, "EMAIL_ALREADY_EXISTS");
});

test("POST /auth/register rejects invalid email and weak password with 400", async () => {
  const resBadEmail = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Bad Email",
      email: "not-an-email",
      password: "ValidPassword123!",
    }),
  });
  assert.equal(resBadEmail.status, 400);
  assert.equal((await resBadEmail.json()).error.code, "VALIDATION_ERROR");

  const resWeakPass = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Weak Pass",
      email: "weak@krishimama.local",
      password: "short",
    }),
  });
  assert.equal(resWeakPass.status, 400);
  assert.equal((await resWeakPass.json()).error.code, "VALIDATION_ERROR");
});

test("POST /auth/login authenticates valid user and rejects incorrect password", async () => {
  // Correct login
  const resValid = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "karim@krishimama.local",
      password: "SecurePassword123!",
    }),
  });

  assert.equal(resValid.status, 200);
  const bodyValid = await resValid.json();
  assert.equal(bodyValid.success, true);
  assert.equal(bodyValid.data.user.email, "karim@krishimama.local");
  assert.ok(bodyValid.data.token);

  const cookie = resValid.headers.get("set-cookie");
  assert.ok(cookie && cookie.includes("km_session="));

  // Incorrect password
  const resWrong = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "karim@krishimama.local",
      password: "IncorrectPassword999!",
    }),
  });
  assert.equal(resWrong.status, 401);
  const bodyWrong = await resWrong.json();
  assert.equal(bodyWrong.error.code, "INVALID_CREDENTIALS");

  // Non-existent email
  const resNonExistent = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "nobody@krishimama.local",
      password: "SecurePassword123!",
    }),
  });
  assert.equal(resNonExistent.status, 401);
  assert.equal((await resNonExistent.json()).error.code, "INVALID_CREDENTIALS");
});

test("GET /auth/me returns user profile with valid cookie or Bearer token, rejects unauthorized", async () => {
  // 1. Unauthorized without token
  const resUnauth = await fetch(`${baseUrl}/auth/me`);
  assert.equal(resUnauth.status, 401);
  assert.equal((await resUnauth.json()).error.code, "UNAUTHORIZED");

  // Login to get token and cookie
  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "karim@krishimama.local",
      password: "SecurePassword123!",
    }),
  });
  const loginBody = await loginRes.json();
  const token = loginBody.data.token;
  const rawCookie = loginRes.headers.get("set-cookie");
  const cookieMatch = rawCookie.match(/km_session=([^;]+)/);
  const cookieValue = cookieMatch ? cookieMatch[1] : "";

  // 2. Authorized via Bearer header
  const resBearer = await fetch(`${baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(resBearer.status, 200);
  const bodyBearer = await resBearer.json();
  assert.equal(bodyBearer.data.user.email, "karim@krishimama.local");
  assert.equal(bodyBearer.data.user.passwordHash, undefined);

  // 3. Authorized via Cookie
  const resCookie = await fetch(`${baseUrl}/auth/me`, {
    headers: { Cookie: `km_session=${cookieValue}` },
  });
  assert.equal(resCookie.status, 200);
  const bodyCookie = await resCookie.json();
  assert.equal(bodyCookie.data.user.email, "karim@krishimama.local");

  // 4. Invalid token
  const resInvalid = await fetch(`${baseUrl}/auth/me`, {
    headers: { Authorization: "Bearer totally-invalid-token" },
  });
  assert.equal(resInvalid.status, 401);
  assert.equal((await resInvalid.json()).error.code, "INVALID_TOKEN");
});

test("PATCH /auth/profile updates preferredDistrict and name", async () => {
  // Login first
  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "karim@krishimama.local",
      password: "SecurePassword123!",
    }),
  });
  const token = (await loginRes.json()).data.token;

  const patchRes = await fetch(`${baseUrl}/auth/profile`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name: "Karim Updated",
      preferredDistrict: "cumilla",
    }),
  });

  assert.equal(patchRes.status, 200);
  const patchBody = await patchRes.json();
  assert.equal(patchBody.data.user.name, "Karim Updated");
  assert.equal(patchBody.data.user.preferredDistrict, "cumilla");

  // Verify persistence in DB
  const updatedUser = await User.findOne({ email: "karim@krishimama.local" });
  assert.equal(updatedUser.name, "Karim Updated");
  assert.equal(updatedUser.preferredDistrict, "cumilla");
});

test("POST /auth/logout clears the session cookie", async () => {
  const res = await fetch(`${baseUrl}/auth/logout`, {
    method: "POST",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);

  const cookie = res.headers.get("set-cookie");
  assert.ok(cookie);
  // Clearing cookie sets either max-age=0 or expires in past
  assert.ok(
    cookie.includes("km_session=;") ||
    cookie.includes("Max-Age=0") ||
    cookie.includes("Expires=Thu, 01 Jan 1970")
  );
});

test("POST /auth/login rejects missing credentials with 400 VALIDATION_ERROR", async () => {
  const resMissing = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(resMissing.status, 400);
  const body = await resMissing.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, "VALIDATION_ERROR");
});

test("CORS allows credentialed requests from localhost:3000", async () => {
  const preflightRes = await fetch(`${baseUrl}/auth/me`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Authorization",
    },
  });

  assert.equal(preflightRes.status, 204);
  assert.equal(preflightRes.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(preflightRes.headers.get("access-control-allow-credentials"), "true");
});
