/**
 * Phase 8.2 AI Assistant Grounding Verification Script (Offline Mode)
 */

import assert from "node:assert/strict";
import mongoose from "mongoose";
import { assistantChatService } from "../src/services/ai/chat.service.js";
import { toolExecutors } from "../src/services/ai/tools.executor.js";

async function run() {
  console.log("--- Starting AI Assistant Offline Grounding Verification ---");

  // Ensure DB disconnected
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  console.log("MongoDB connection state:", mongoose.connection.readyState, "(0 = disconnected)");

  // 1. Soil moisture Bangla query for Cumilla
  console.log("\n[Test 1] Bangla Soil Moisture Query (Cumilla):");
  const res1 = await assistantChatService.handleChat({
    message: "কুমিল্লার মাটির আর্দ্রতা কেমন?",
    district: "cumilla",
  });
  console.log("  Answer snippet:", res1.answer.slice(0, 150) + "...");
  console.log("  Sources:", res1.sources);
  console.log("  Provenance:", res1.provenance);
  console.log("  Data date:", res1.dataDate);
  console.log("  Tools called:", res1.meta.toolsCalled);
  assert.ok(res1.answer.includes("আর্দ্রতা") || res1.answer.includes("SMAP") || res1.answer.includes("০.৪২৫৯") || res1.answer.includes("0.4259") || res1.answer.includes("৪২.৬%"));
  assert.ok(res1.meta.toolsCalled.includes("getSoilMoistureLatest"));
  assert.equal(res1.dataDate, "2024-01-03");

  // 2. Rainfall seasonal query for Chattogram in Bangla
  console.log("\n[Test 2] Bangla Seasonal Rainfall Query (Chattogram):");
  const res2 = await assistantChatService.handleChat({
    message: "চট্টগ্রামে বর্ষাকালে কত বৃষ্টিপাত হয়?",
    district: "chattogram",
  });
  console.log("  Answer snippet:", res2.answer.slice(0, 150) + "...");
  console.log("  Tools called:", res2.meta.toolsCalled);
  assert.ok(res2.meta.toolsCalled.includes("getClimateRainfall"));
  assert.ok(res2.answer.includes("চট্টগ্রাম") || res2.answer.includes("Chattogram"));

  // 3. Crop handoff planner query in Bangla
  console.log("\n[Test 3] Bangla Crop Handoff Query (Aman-Mustard):");
  const res3 = await assistantChatService.handleChat({
    message: "আমন কাটার পর সরিষা চাষের পরিকল্পনা কী?",
    district: "cumilla",
  });
  console.log("  Answer snippet:", res3.answer.slice(0, 150) + "...");
  console.log("  Tools called:", res3.meta.toolsCalled);
  assert.ok(res3.meta.toolsCalled.includes("getHandoffPlan"));
  assert.ok(res3.answer.includes("সরিষা") || res3.answer.includes("আমন"));

  // 4. Unsupported district rejection
  console.log("\n[Test 4] Unsupported District Rejection:");
  const res4 = await assistantChatService.handleChat({
    message: "রাজশাহীর মাটির অবস্থা কি?",
    district: "rajshahi",
  });
  console.log("  Answer snippet:", res4.answer);
  console.log("  Data quality:", res4.dataQuality);
  assert.equal(res4.dataQuality, "district_unsupported");
  assert.ok(res4.answer.includes("কুমিল্লা") && res4.answer.includes("চট্টগ্রাম"));

  // 5. Short-term forecast disclaimer verification
  console.log("\n[Test 5] Direct Tool Climatological Disclaimer:");
  const normals = await toolExecutors.getClimateNormals({ district: "cumilla" });
  console.log("  Normals disclaimer:", normals.scientificDisclaimer);
  assert.ok(normals.scientificDisclaimer.includes("not a deterministic short-term weather forecast"));

  console.log("\nAll AI assistant offline grounding tests PASSED successfully!");
}

run().catch((err) => {
  console.error("AI Assistant Grounding Test Failed:", err);
  process.exit(1);
});
