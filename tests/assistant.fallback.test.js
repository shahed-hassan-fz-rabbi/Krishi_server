import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { GeminiAssistantClient } from "../src/services/ai/gemini.client.js";
import { assistantChatService } from "../src/services/ai/chat.service.js";
import { createApp } from "../src/app.js";

dotenv.config();

test("Gemini client isConfigured rejects placeholders, Unicode, and invalid keys", () => {
  // Empty
  assert.equal(new GeminiAssistantClient("").isConfigured(), false);
  assert.equal(new GeminiAssistantClient(null).isConfigured(), false);

  // Unicode placeholder (e.g. Bengali text)
  assert.equal(new GeminiAssistantClient("তোমার_আসল_API_KEY").isConfigured(), false);

  // Generic placeholder strings
  assert.equal(new GeminiAssistantClient("YOUR_API_KEY_HERE").isConfigured(), false);
  assert.equal(new GeminiAssistantClient("DUMMY_KEY_FOR_TESTS").isConfigured(), false);
  assert.equal(new GeminiAssistantClient("test").isConfigured(), false);

  // Valid length and ASCII characters
  assert.equal(new GeminiAssistantClient("AIzaSyD1234567890abcdefghijklmnopqrst").isConfigured(), true);
});

test("Assistant API enforces message length security limit", async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const chatUrl = `http://127.0.0.1:${port}/api/v1/assistant/chat`;

  try {
    const hugeMessage = "ধান ".repeat(400); // 1600 characters
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: hugeMessage, district: "cumilla" }),
    });

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.error.code, "MESSAGE_TOO_LONG");
  } finally {
    server.close();
  }
});

test("Assistant Chat Service handles ambiguous or unrelated questions safely", async () => {
  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);

  try {
    // 1. Ambiguous query
    const ambigRes = await assistantChatService.handleChat({
      message: "কিছু বলো",
      district: "cumilla",
    });
    assert.equal(ambigRes.language, "bn");
    assert.ok(ambigRes.answer.includes("কৃষি মামা") || ambigRes.answer.length > 20);

    // 2. Unsupported district in parameters
    const unsuppRes = await assistantChatService.handleChat({
      message: "মাটির আর্দ্রতা কত?",
      district: "khulna",
    });
    assert.equal(unsuppRes.dataQuality, "district_unsupported");
    assert.ok(unsuppRes.answer.includes("খুলনা") || unsuppRes.answer.includes("khulna") || unsuppRes.answer.includes("কুমিল্লা"));

    // 3. Unsupported district and crop in message text (Scenario 8)
    const textUnsuppRes = await assistantChatService.handleChat({
      message: "রংপুরে গম চাষের জন্য মাটির আর্দ্রতা কেমন?",
      district: "cumilla",
    });
    assert.equal(textUnsuppRes.dataQuality, "district_unsupported");
    assert.ok(textUnsuppRes.answer.includes("রংপুর") || textUnsuppRes.answer.includes("কুমিল্লা"));

    // 4. Real-time live forecast refusal (Scenario 7)
    const forecastRes = await assistantChatService.handleChat({
      message: "আমার জমিতে আজ বৃষ্টি হবে কি?",
      district: "cumilla",
    });
    assert.ok(forecastRes.answer.includes("পূর্বাভাস") || forecastRes.answer.includes("লাইভ"));

    // 5. Historical vs Live clarification (Scenario 9)
    const histLiveRes = await assistantChatService.handleChat({
      message: "নাসার এই উপাত্ত কি আজকের লাইভ অবস্থা?",
      district: "cumilla",
    });
    assert.ok(histLiveRes.answer.includes("লাইভ") || histLiveRes.answer.includes("ঐতিহাসিক"));

    // 6. Scientific limitations and seed sowing feasibility (Scenario 10)
    const limitRes = await assistantChatService.handleChat({
      message: "স্যাটেলাইটের মাটির আর্দ্রতা ভালো থাকলে কি নিশ্চিত জমিতে বীজ বোনা যাবে?",
      district: "cumilla",
    });
    assert.ok(limitRes.answer.includes("বীজ") || limitRes.answer.includes("জো"));

    // 7. Vegetation condition with 'গাছপালার অবস্থা' (Scenario 2)
    const vegRes = await assistantChatService.handleChat({
      message: "কুমিল্লার ফসলের গাছপালার অবস্থা কেমন?",
      district: "cumilla",
    });
    assert.ok(vegRes.answer.includes("মোডিস") || vegRes.answer.includes("MODIS") || vegRes.sources.some(s => s.includes("MODIS") || s.includes("Core")));
  } finally {
    await mongoose.connection.close();
  }
});
