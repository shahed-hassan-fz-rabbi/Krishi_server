import test from "node:test";
import assert from "node:assert/strict";
import { register, login } from "../src/controllers/auth.controller.js";
import { User } from "../src/models/user.model.js";

function response() {
  return { cookies: [], status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, cookie(...args) { this.cookies.push(args); return this; } };
}

test("phone registration and login use normalized identity and verified password before issuing session", async () => {
  const original = { findOne: User.findOne, create: User.create, hashPassword: User.hashPassword };
  const user = { _id: "507f1f77bcf86cd799439011", name: "Farmer", phone: "+8801712345678", role: "farmer", async comparePassword(password) { return password === "correct-password"; }, async save() {} };
  try {
    User.findOne = async (query) => { assert.deepEqual(query, { phone: user.phone }); return null; };
    User.hashPassword = async () => "hashed-test-password";
    User.create = async (input) => {
      assert.equal(input.phone, user.phone);
      assert.equal(input.email, undefined);
      assert.equal(input.role, "farmer");
      assert.equal(input.passwordHash, "hashed-test-password");
      return user;
    };
    const created = response();
    await register({ body: { name: "Farmer", phone: "01712345678", password: "correct-password", role: "admin" } }, created);
    assert.equal(created.code, 201);
    assert.equal(created.cookies[0][2].httpOnly, true);
    User.findOne = (query) => { assert.deepEqual(query, { phone: user.phone }); return { select: async () => user }; };
    const denied = response();
    await login({ body: { identifier: "01712345678", password: "wrong" } }, denied);
    assert.equal(denied.code, 401);
    assert.equal(denied.cookies.length, 0);
    const accepted = response();
    await login({ body: { identifier: "+8801712345678", password: "correct-password" } }, accepted);
    assert.equal(accepted.code, 200);
    assert.equal(accepted.cookies[0][2].httpOnly, true);
    User.findOne = async () => user;
    const duplicate = response();
    await register({ body: { name: "Farmer", phone: "01712345678", password: "correct-password" } }, duplicate);
    assert.equal(duplicate.code, 409);
    assert.equal(duplicate.cookies.length, 0);
  } finally {
    Object.assign(User, original);
  }
});
