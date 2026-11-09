import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";

import { env, isGoogleOAuthConfigured } from "../src/config/env.config.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { SESSION_COOKIE_NAME, verifyToken } from "../src/utils/token.util.js";
import { verifyGoogleIdToken } from "../src/services/auth/google.oauth.service.js";
import { findOrCreateGoogleUser } from "../src/controllers/auth.controller.js";

const testDatabaseName = `km_auth_google_${process.pid}_${randomUUID().slice(0, 8)}`;
let server;
let baseUrl;
let databaseConnected = false;

before(async () => {
  await connectDatabase({ databaseName: testDatabaseName, required: true });
  databaseConnected = true;

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

test("GET /auth/google/status reports configuration state without exposing secrets", async () => {
  const res = await fetch(`${baseUrl}/auth/google/status`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(typeof body.data.configured, "boolean");
  // Client ID may be string or null, but client secret must NEVER be in response
  assert.equal(body.data.clientSecret, undefined);
  assert.equal(body.data.googleClientSecret, undefined);
});

test("GET /auth/google returns 503 or redirect based on configuration", async () => {
  const res = await fetch(`${baseUrl}/auth/google`, { redirect: "manual" });

  if (isGoogleOAuthConfigured()) {
    assert.equal(res.status, 302);
    const location = res.headers.get("location");
    assert.match(location, /accounts\.google\.com/);
    assert.match(location, /state=/);

    // Verify state cookie is set with httpOnly
    const setCookie = res.headers.get("set-cookie");
    assert.match(setCookie, /km_oauth_state=/);
    assert.match(setCookie, /HttpOnly/i);
  } else {
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, "GOOGLE_AUTH_NOT_CONFIGURED");
  }
});

test("GET /auth/google/callback redirects with error when user cancels consent", async () => {
  const res = await fetch(`${baseUrl}/auth/google/callback?error=access_denied`, {
    redirect: "manual",
  });

  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.match(location, /error=cancelled/);
});

test("GET /auth/google/callback rejects state mismatch (CSRF protection)", async () => {
  const res = await fetch(`${baseUrl}/auth/google/callback?code=fake_code&state=forged_state`, {
    headers: {
      Cookie: "km_oauth_state=genuine_state",
    },
    redirect: "manual",
  });

  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.match(location, /error=state_mismatch/);
});

test("Google ID token verification rejects unverified email addresses", async () => {
  const mockClient = {
    async verifyIdToken() {
      return {
        getPayload: () => ({
          sub: "google-123456",
          email: "unverified@example.com",
          email_verified: false,
          name: "Unverified User",
        }),
      };
    },
  };

  await assert.rejects(
    async () => {
      await verifyGoogleIdToken("dummy_token", mockClient);
    },
    (err) => {
      assert.equal(err.code, "EMAIL_NOT_VERIFIED");
      return true;
    }
  );
});

test("Google ID token verification extracts validated profile when email is verified", async () => {
  const mockClient = {
    async verifyIdToken() {
      return {
        getPayload: () => ({
          sub: "google-verified-987",
          email: "farmer.rahim@gmail.com",
          email_verified: true,
          name: "Rahim Mia",
          picture: "https://lh3.googleusercontent.com/photo.jpg",
        }),
      };
    },
  };

  const profile = await verifyGoogleIdToken("dummy_token", mockClient);
  assert.equal(profile.googleId, "google-verified-987");
  assert.equal(profile.email, "farmer.rahim@gmail.com");
  assert.equal(profile.name, "Rahim Mia");
  assert.equal(profile.picture, "https://lh3.googleusercontent.com/photo.jpg");
});

/* ==========================================================================
 * REGRESSION SUITE: User Role Validation & Safe Account Linking
 * ========================================================================== */

test("Regression 1: New Google user receives 'farmer' role", async () => {
  const newProfile = {
    googleId: "google-new-farmer-001",
    email: "new.google.farmer@gmail.com",
    name: "New Google Farmer",
    picture: "https://lh3.googleusercontent.com/new_farmer.jpg",
  };

  const user = await findOrCreateGoogleUser(newProfile);
  assert.ok(user._id);
  assert.equal(user.role, "farmer");
  assert.equal(user.authProvider, "google");
  assert.equal(user.googleId, "google-new-farmer-001");
  assert.equal(user.preferredDistrict, "chattogram");
});

test("Regression 2: Existing farmer account links successfully", async () => {
  const existingFarmer = await User.create({
    name: "Existing Local Farmer",
    email: "local.farmer@krishimama.local",
    passwordHash: await User.hashPassword("SecurePass123!"),
    preferredDistrict: "cumilla",
    role: "farmer",
  });

  const profile = {
    googleId: "google-linked-farmer-002",
    email: "local.farmer@krishimama.local",
    name: "Updated Farmer Name",
    picture: "https://lh3.googleusercontent.com/linked_farmer.jpg",
  };

  const linkedUser = await findOrCreateGoogleUser(profile);
  assert.equal(linkedUser._id.toString(), existingFarmer._id.toString());
  assert.equal(linkedUser.googleId, "google-linked-farmer-002");
  assert.equal(linkedUser.role, "farmer");
  assert.equal(linkedUser.preferredDistrict, "cumilla");

  // Verify password hash is preserved on database document
  const reloaded = await User.findById(linkedUser._id).select("+passwordHash");
  assert.ok(reloaded.passwordHash, "Must preserve local password hash");
  const passValid = await reloaded.comparePassword("SecurePass123!");
  assert.equal(passValid, true);
});

test("Regression 3: Existing extension_officer role is strictly preserved", async () => {
  const officer = await User.create({
    name: "Agricultural Officer Kabir",
    email: "kabir.officer@dae.gov.bd",
    passwordHash: await User.hashPassword("OfficerPass123!"),
    preferredDistrict: "cumilla",
    role: "extension_officer",
  });

  const profile = {
    googleId: "google-officer-003",
    email: "kabir.officer@dae.gov.bd",
    name: "Kabir Officer",
    picture: null,
  };

  const linkedOfficer = await findOrCreateGoogleUser(profile);
  assert.equal(linkedOfficer._id.toString(), officer._id.toString());
  assert.equal(linkedOfficer.role, "extension_officer", "Must not downgrade officer to farmer");
  assert.equal(linkedOfficer.googleId, "google-officer-003");
});

test("Regression 4: Existing admin role is strictly preserved without granting new privileges", async () => {
  const admin = await User.create({
    name: "System Admin",
    email: "admin.super@krishimama.local",
    passwordHash: await User.hashPassword("SuperAdminPass123!"),
    preferredDistrict: "chattogram",
    role: "admin",
  });

  const profile = {
    googleId: "google-admin-004",
    email: "admin.super@krishimama.local",
    name: "System Admin",
    picture: null,
  };

  const linkedAdmin = await findOrCreateGoogleUser(profile);
  assert.equal(linkedAdmin._id.toString(), admin._id.toString());
  assert.equal(linkedAdmin.role, "admin", "Must preserve existing admin role");
  assert.equal(linkedAdmin.googleId, "google-admin-004");
});

test("Regression 5: Legacy/invalid role (e.g. 'writer', 'reader') is safely normalized to 'farmer'", async () => {
  // Directly insert a legacy document bypassing mongoose validation to simulate old database entries
  const rawId = new mongoose.Types.ObjectId();
  await mongoose.connection.collection("users").insertOne({
    _id: rawId,
    name: "Legacy Account",
    email: "legacy.writer@gmail.com",
    role: "writer", // Invalid role from past project seed
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const profile = {
    googleId: "google-legacy-005",
    email: "legacy.writer@gmail.com",
    name: "Legacy Account Fixed",
    picture: null,
  };

  // Must not throw "User validation failed: role: Role must be 'farmer'..."
  const normalizedUser = await findOrCreateGoogleUser(profile);
  assert.equal(normalizedUser._id.toString(), rawId.toString());
  assert.equal(normalizedUser.role, "farmer", "Legacy role must be normalized to farmer");
  assert.equal(normalizedUser.googleId, "google-legacy-005");
  assert.equal(normalizedUser.preferredDistrict, "chattogram");
});

test("Regression 6: Duplicate verified email does not create duplicate users", async () => {
  const profile = {
    googleId: "google-dup-006",
    email: "unique.user@gmail.com",
    name: "Unique User",
    picture: null,
  };

  const firstCall = await findOrCreateGoogleUser(profile);
  const secondCall = await findOrCreateGoogleUser(profile);

  assert.equal(firstCall._id.toString(), secondCall._id.toString());
  const count = await User.countDocuments({ email: "unique.user@gmail.com" });
  assert.equal(count, 1, "Must never create duplicate user documents for the same email");
});

test("Regression 7: Google authentication token can be verified and contains valid role", async () => {
  const profile = {
    googleId: "google-jwt-007",
    email: "jwt.farmer@gmail.com",
    name: "JWT Farmer",
    picture: null,
  };

  const user = await findOrCreateGoogleUser(profile);
  const tokenUtil = await import("../src/utils/token.util.js");
  const token = tokenUtil.signToken(user);
  const decoded = tokenUtil.verifyToken(token);

  assert.equal(decoded.sub, user._id.toString());
  assert.equal(decoded.role, "farmer");
  assert.equal(decoded.email, "jwt.farmer@gmail.com");
});
