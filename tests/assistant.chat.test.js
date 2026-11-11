import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";

import { User } from "../src/models/user.model.js";
import { Conversation } from "../src/models/conversation.model.js";
import { signToken } from "../src/utils/token.util.js";

dotenv.config();

test("Krishi Mama AI Assistant API — End-to-End Grounded Conversational Tests", async () => {
  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);

  const testUser = await User.create({ name: "Rotation Test", email: `rotation-chat-${Date.now()}@example.test`, password: "TestOnlyPassword123!", preferredDistrict: "cumilla" });
  const token = signToken(testUser);
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const chatUrl = `http://127.0.0.1:${port}/api/v1/assistant/chat`;

  try {
    // 1. Question 1: আমন কাটার পর সরিষা বপন
    const q1Res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: "কুমিল্লায় আমন ধান কাটার পর সরিষা কখন বপন করা ভালো?",
        district: "cumilla",
      }),
    });
    assert.equal(q1Res.status, 200);
    const q1Json = await q1Res.json();
    assert.equal(q1Json.success, true);
    assert.equal(q1Json.data.language, "bn");
    assert.ok(q1Json.data.answer.includes("সরিষা"));
    assert.ok(q1Json.data.answer.includes("নভেম্বর"));
    assert.ok(q1Json.data.sources.length > 0);
    assert.ok(q1Json.data.conversationId);

    // 2. Question 2: ঐতিহাসিক বৃষ্টিপাত
    const q2Res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: "গত কয়েক বছরে কুমিল্লায় বৃষ্টিপাত কেমন ছিল?",
        district: "cumilla",
      }),
    });
    assert.equal(q2Res.status, 200);
    const q2Json = await q2Res.json();
    assert.equal(q2Json.success, true);
    assert.ok(q2Json.data.answer.includes("বৃষ্টিপাত"));
    assert.ok(q2Json.data.answer.includes("নাসা পাওয়ার") || q2Json.data.answer.includes("NASA POWER"));

    // 3. Question 3: NASA SMAP মাটির আর্দ্রতা
    const q3Res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: "NASA SMAP দিয়ে মাটির আর্দ্রতা সম্পর্কে কী জানা যায়?",
        district: "cumilla",
      }),
    });
    assert.equal(q3Res.status, 200);
    const q3Json = await q3Res.json();
    assert.equal(q3Json.success, true);
    assert.ok(q3Json.data.answer.includes("আর্দ্রতা"));
    assert.ok(
      q3Json.data.answer.includes("০-৫") ||
      q3Json.data.answer.includes("০ থেকে ৫") ||
      q3Json.data.answer.includes("0-5") ||
      q3Json.data.limitations.some((l) => l.includes("0-5 cm"))
    );
    assert.equal(q3Json.data.dataDate, "2024-01-03");

    // 4. Question 4: NDVI এবং EVI সবুজতা সূচক
    const q4Res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: "NDVI এবং EVI কী বোঝায়?",
        district: "cumilla",
      }),
    });
    assert.equal(q4Res.status, 200);
    const q4Json = await q4Res.json();
    assert.equal(q4Json.success, true);
    assert.ok(q4Json.data.answer.includes("NDVI") || q4Json.data.answer.includes("এনডিভিআই"));
    assert.ok(q4Json.data.answer.includes("সবুজতা"));
    assert.equal(q4Json.data.dataDate, "2024-01-17");

    // 5. Question 5: আমন থেকে সরিষায় যাওয়ার হ্যান্ডঅফ প্ল্যানার
    const q5Res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: "আমন থেকে সরিষায় যাওয়ার হ্যান্ডঅফ প্ল্যানার কী ফলাফল দেখাচ্ছে?",
        district: "cumilla",
      }),
    });
    assert.equal(q5Res.status, 200);
    const q5Json = await q5Res.json();
    assert.equal(q5Json.success, true);
    assert.ok(q5Json.data.answer.includes("১০০%") || q5Json.data.answer.includes("100%"));

    // 6. Question 6: বোরো থেকে আউশে যাওয়ার ঐতিহাসিক ফলাফল
    const q6Res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: "বোরো থেকে আউশে যাওয়ার ঐতিহাসিক ফলাফল কী?",
        district: "cumilla",
      }),
    });
    assert.equal(q6Res.status, 200);
    const q6Json = await q6Res.json();
    assert.equal(q6Json.success, true);
    assert.ok(q6Json.data.answer.includes("৮৪%") || q6Json.data.answer.includes("84%"));

    // 7. Question 7: সরিষা চাষের সরকারি নির্দেশনা
    const q7Res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: "সরিষা চাষের সরকারি নির্দেশনা কী?",
        district: "cumilla",
      }),
    });
    assert.equal(q7Res.status, 200);
    const q7Json = await q7Res.json();
    assert.equal(q7Json.success, true);
    assert.ok(q7Json.data.answer.includes("বারি সরিষা") || q7Json.data.answer.includes("BARI Sarisha") || q7Json.data.answer.includes("সরিষা"));

    // 8. Negative: খালি মেসেজ (Empty message)
    const emptyRes = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "" }),
    });
    assert.equal(emptyRes.status, 400);
    const emptyJson = await emptyRes.json();
    assert.equal(emptyJson.success, false);
    assert.equal(emptyJson.error.code, "MISSING_MESSAGE");

    // 9. Edge case: অনুমোদনহীন জেলা (Unsupported district)
    const invalidDistRes = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: "সিলেটে ধান চাষের নিয়ম কী?",
        district: "sylhet",
      }),
    });
    assert.equal(invalidDistRes.status, 200);
    const invalidDistJson = await invalidDistRes.json();
    assert.equal(invalidDistJson.success, true);
    assert.equal(invalidDistJson.data.dataQuality, "district_unsupported");
    assert.ok(invalidDistJson.data.answer.includes("কুমিল্লা") && invalidDistJson.data.answer.includes("চট্টগ্রাম"));
  } finally {
    await Conversation.deleteMany({ userId: testUser._id });
    await User.deleteOne({ _id: testUser._id });
    server.close();
    await mongoose.connection.close();
  }
});
