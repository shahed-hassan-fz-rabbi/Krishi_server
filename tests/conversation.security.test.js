import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";

import { randomUUID } from "node:crypto";

import "../src/config/env.config.js";
import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { Conversation } from "../src/models/conversation.model.js";

let server;
let baseUrl;

before(async () => {
  const uri = process.env.MONGODB_URI;
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  // Clean test fixtures
  await User.deleteMany({ email: { $regex: /@convtest\.org$/ } });
  await Conversation.deleteMany({});

  server = http.createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await Conversation.deleteMany({});
  await User.deleteMany({ email: { $regex: /@convtest\.org$/ } });
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect();
});

test("Chat History & User Isolation Security Suite", async (t) => {
  let userAToken = "";
  let userBToken = "";
  let userAConversationId = "";

  await t.test("Guest assistant use requires login and creates no conversation", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "কুমিল্লায় আমন ধানের পর সরিষা কখন লাগাবো?",
        district: "cumilla",
        crop: "mustard",
      }),
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error.code, "UNAUTHORIZED");

    // Verify no conversation was created in MongoDB for guests
    const count = await Conversation.countDocuments({});
    assert.equal(count, 0);
  });

  await t.test("Register User A and User B", async () => {
    const resA = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Farmer Alim",
        email: "alim@convtest.org",
        password: "Password123!",
        preferredDistrict: "cumilla",
      }),
    });
    assert.equal(resA.status, 201);
    const dataA = await resA.json();
    userAToken = dataA.data.token;
    assert.ok(userAToken);

    const resB = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Farmer Basher",
        email: "basher@convtest.org",
        password: "Password123!",
        preferredDistrict: "chattogram",
      }),
    });
    assert.equal(resB.status, 201);
    const dataB = await resB.json();
    userBToken = dataB.data.token;
    assert.ok(userBToken);
  });

  await t.test("Unauthenticated user cannot access conversation list (401)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/conversations`);
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error.code, "UNAUTHORIZED");
  });

  await t.test("User A sends first message; creates new persistent conversation in MongoDB", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        message: "কুমিল্লার মাটির আর্দ্রতা পরিস্থিতি কেমন?",
        district: "cumilla",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.isGuest, false);
    assert.ok(data.data.conversationId);
    assert.ok(data.data.title);
    userAConversationId = data.data.conversationId;

    // Verify stored in MongoDB with 2 messages
    const conv = await Conversation.findById(userAConversationId);
    assert.ok(conv);
    assert.equal(conv.messages.length, 2);
    assert.equal(conv.messages[0].role, "user");
    assert.equal(conv.messages[1].role, "assistant");
  });

  await t.test("User A sends second message; appends to existing conversation (4 messages)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        message: "বৃষ্টিপাতের ধারা সম্পর্কে আরও বিস্তারিত বলো",
        district: "cumilla",
        conversationId: userAConversationId,
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.data.conversationId, userAConversationId);

    const conv = await Conversation.findById(userAConversationId);
    assert.equal(conv.messages.length, 4);
    assert.equal(conv.messages[2].role, "user");
    assert.equal(conv.messages[3].role, "assistant");
  });

  await t.test("User A lists conversations; sees their conversation with count and lastMessage", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/conversations`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.conversations.length, 1);
    assert.equal(data.data.conversations[0]._id, userAConversationId);
    assert.equal(data.data.conversations[0].messageCount, 4);
  });

  await t.test("User A fetches single conversation; receives full messages array", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/conversations/${userAConversationId}`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.conversation._id, userAConversationId);
    assert.equal(data.data.conversation.messages.length, 4);
  });

  await t.test("User A renames conversation title", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/conversations/${userAConversationId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({ title: "কুমিল্লা মাটির আর্দ্রতা আলোচনা" }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.data.conversation.title, "কুমিল্লা মাটির আর্দ্রতা আলোচনা");
  });

  await t.test("SECURITY: User B CANNOT read User A's conversation (404 Not Found)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/conversations/${userAConversationId}`, {
      headers: { Authorization: `Bearer ${userBToken}` },
    });

    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error.code, "CONVERSATION_NOT_FOUND");
  });

  await t.test("SECURITY: User B CANNOT rename User A's conversation (404 Not Found)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/conversations/${userAConversationId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({ title: "Hacked by User B" }),
    });

    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.success, false);

    // Verify title was NOT modified
    const conv = await Conversation.findById(userAConversationId);
    assert.equal(conv.title, "কুমিল্লা মাটির আর্দ্রতা আলোচনা");
  });

  await t.test("SECURITY: User B CANNOT append messages to User A's conversation (404)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        message: "Injected question into User A conversation",
        district: "chattogram",
        conversationId: userAConversationId,
      }),
    });

    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.success, false);

    // Verify messages count still 4
    const conv = await Conversation.findById(userAConversationId);
    assert.equal(conv.messages.length, 4);
  });

  await t.test("SECURITY: User B CANNOT delete User A's conversation (404 Not Found)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/conversations/${userAConversationId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userBToken}` },
    });

    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.success, false);

    // Verify conversation still exists
    const conv = await Conversation.findById(userAConversationId);
    assert.ok(conv);
  });

  await t.test("User A deletes conversation; successfully removes and subsequent fetch is 404", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/conversations/${userAConversationId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userAToken}` },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    const getRes = await fetch(`${baseUrl}/api/v1/assistant/conversations/${userAConversationId}`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(getRes.status, 404);
  });
});
