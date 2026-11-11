import test from "node:test";
import assert from "node:assert/strict";

import {
  validateRegisterInput,
  validateLoginInput,
  validateProfileUpdateInput,
} from "../src/validators/auth.validator.js";
import { User } from "../src/models/user.model.js";
import { resolveJwtSecret } from "../src/config/security.config.js";

test("JWT signing secret uses fallback only outside production", () => {
  assert.throws(() => resolveJwtSecret("production", undefined), /JWT_SECRET must be configured/);
  assert.throws(() => resolveJwtSecret("production", "too-short"), /at least 32 characters/);
  assert.equal(resolveJwtSecret("production", "x".repeat(32)), "x".repeat(32));
  assert.equal(resolveJwtSecret("test", undefined), "krishi-mama-super-secure-jwt-signing-secret-key-32chars");
});

test("validateRegisterInput accepts valid input and enforces role=farmer", () => {
  const result = validateRegisterInput({
    name: "Rahim Mia",
    email: "RAHIM@Example.Com ",
    password: "Password123!",
    preferredDistrict: "cumilla",
    role: "admin", // Malicious privilege escalation attempt
  });

  assert.equal(result.isValid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sanitized.name, "Rahim Mia");
  assert.equal(result.sanitized.email, "rahim@example.com");
  assert.equal(result.sanitized.preferredDistrict, "cumilla");
  assert.equal(result.sanitized.role, "farmer"); // Server strictly overrides role to farmer
});

test("validateRegisterInput rejects missing or too-short name", () => {
  const missingName = validateRegisterInput({
    name: "",
    email: "valid@example.com",
    password: "Password123!",
  });
  assert.equal(missingName.isValid, false);
  assert.ok(missingName.errors.some((e) => e.includes("Name is required")));

  const shortName = validateRegisterInput({
    name: "A",
    email: "valid@example.com",
    password: "Password123!",
  });
  assert.equal(shortName.isValid, false);
  assert.ok(shortName.errors.some((e) => e.includes("at least 2 characters")));
});

test("validateRegisterInput rejects invalid email formats", () => {
  const invalidEmails = ["not-an-email", "missing@domain", "@nodomain.com", "spaces in@email.com"];
  for (const email of invalidEmails) {
    const res = validateRegisterInput({
      name: "Valid Name",
      email,
      password: "Password123!",
    });
    assert.equal(res.isValid, false, `Expected ${email} to be invalid`);
    assert.ok(res.errors.some((e) => e.includes("valid email address")));
  }
});

test("validateRegisterInput rejects passwords under 8 characters", () => {
  const weakPasswords = ["123", "short", "1234567"];
  for (const password of weakPasswords) {
    const res = validateRegisterInput({
      name: "Valid Name",
      email: "valid@example.com",
      password,
    });
    assert.equal(res.isValid, false, `Expected password "${password}" to be rejected`);
    assert.ok(res.errors.some((e) => e.includes("at least 8 characters")));
  }
});

test("validateRegisterInput rejects unsupported districts", () => {
  const res = validateRegisterInput({
    name: "Valid Name",
    email: "valid@example.com",
    password: "Password123!",
    preferredDistrict: "dhaka",
  });
  assert.equal(res.isValid, false);
  assert.ok(res.errors.some((e) => e.includes("chattogram")));
});

test("validateLoginInput requires non-empty email and password", () => {
  const empty = validateLoginInput({});
  assert.equal(empty.isValid, false);
  assert.equal(empty.errors.length, 2);

  const valid = validateLoginInput({
    email: "USER@EXAMPLE.COM ",
    password: "SecretPassword123",
  });
  assert.equal(valid.isValid, true);
  assert.equal(valid.sanitized.email, "user@example.com");
  assert.equal(valid.sanitized.password, "SecretPassword123");
});

test("validateProfileUpdateInput validates partial updates", () => {
  const valid = validateProfileUpdateInput({
    preferredDistrict: "cumilla",
  });
  assert.equal(valid.isValid, true);
  assert.equal(valid.sanitized.preferredDistrict, "cumilla");

  const invalidDist = validateProfileUpdateInput({
    preferredDistrict: "rajshahi",
  });
  assert.equal(invalidDist.isValid, false);

  const emptyUpdate = validateProfileUpdateInput({});
  assert.equal(emptyUpdate.isValid, false);
});

test("User model hashes password with bcrypt and compares securely", async () => {
  const plain = "SuperSecretPassword123!";
  const hash = await User.hashPassword(plain);

  assert.ok(hash.startsWith("$2"), "Expected bcrypt hash format");
  assert.notEqual(hash, plain);

  const dummyUser = new User({
    name: "Test User",
    email: "test@example.com",
    passwordHash: hash,
  });

  const correctMatch = await dummyUser.comparePassword(plain);
  assert.equal(correctMatch, true);

  const wrongMatch = await dummyUser.comparePassword("WrongPassword!");
  assert.equal(wrongMatch, false);

  // Verify toJSON omits passwordHash
  const json = dummyUser.toJSON();
  assert.equal(json.passwordHash, undefined, "passwordHash must never appear in toJSON");
});


test("phone accounts normalize Bangla, local and international mobile numbers", async () => {
  for (const phone of ["01712345678", "+8801712345678", "০০৮৮০১৭১২৩৪৫৬৭৮"]) {
    const result = validateRegisterInput({ name: "Farmer", phone, password: "Password123" });
    assert.equal(result.isValid, true);
    assert.equal(result.sanitized.phone, "+8801712345678");
    assert.equal(result.sanitized.email, undefined);
    const user = new User({ name: "Farmer", phone: result.sanitized.phone, passwordHash: "hashed" });
    await user.validate();
  }
  assert.equal(validateLoginInput({ identifier: "01712345678", password: "secret" }).sanitized.phone, "+8801712345678");
  assert.equal(validateLoginInput({ identifier: "USER@Example.com", password: "secret" }).sanitized.email, "user@example.com");
  for (const identifier of ["01212345678", "0171234567", "+441712345678", { "$ne": null }]) {
    assert.equal(validateLoginInput({ identifier, password: "secret" }).isValid, false);
  }
});
