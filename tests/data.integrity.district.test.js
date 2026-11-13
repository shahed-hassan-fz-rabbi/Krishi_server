import test from "node:test";
import assert from "node:assert/strict";
import { resolveLocationCoordinates } from "../src/config/weather.config.js";
import { resolveLocationContext } from "../src/controllers/weather.controller.js";
import { assistantChatService } from "../src/services/ai/chat.service.js";
import { GeminiAssistantClient } from "../src/services/ai/gemini.client.js";
import { toolExecutors } from "../src/services/ai/tools.executor.js";
import { getLiveForecast } from "../src/services/weather/forecast.service.js";
import { getSeasonalOutlook } from "../src/services/weather/seasonal.service.js";

test("unknown or missing weather locations fail closed without choosing a district", async () => {
  assert.equal(resolveLocationCoordinates("Dhaka"), null);
  assert.equal(resolveLocationCoordinates(undefined), null);

  await assert.rejects(
    resolveLocationContext({ query: { location: "Dhaka" } }),
    (error) => error.statusCode === 400 && /unknown weather location/i.test(error.message),
  );
  await assert.rejects(
    resolveLocationContext({ query: {} }),
    (error) => error.statusCode === 400 && /supported district/i.test(error.message),
  );
  await assert.rejects(getLiveForecast({ locationIdentifier: "Dhaka" }), (error) => error.statusCode === 400);
  await assert.rejects(getSeasonalOutlook({ locationIdentifier: "Dhaka" }), (error) => error.statusCode === 400);
});

test("assistant and handoff tools do not turn absent or unknown district into Cumilla", async () => {
  const missing = await assistantChatService.handleChat({ message: "What is rainfall?" });
  assert.equal(missing.dataQuality, "district_unsupported");
  assert.equal(missing.dataDate, null);
  assert.match(missing.answer, /select Cumilla or Chattogram/i);

  const unknown = await assistantChatService.handleChat({ message: "Rainfall?", district: "Dhaka" });
  assert.equal(unknown.dataQuality, "district_unsupported");
  assert.deepEqual(unknown.meta.toolsCalled, []);

  const handoff = await toolExecutors.getHandoffPlan({ transition: "aman-mustard" });
  assert.match(handoff.error, /not supported/i);
});

test("weather assistant tools fail closed without a supported district before provider access", async () => {
  for (const toolName of [
    "getLocationWeatherForecast",
    "getActiveWeatherAlerts",
    "getAgriculturalRiskAssessment",
    "getWeeklyWeatherOutlook",
    "getSeasonalCropOutlook",
  ]) {
    const result = await toolExecutors[toolName]({ crop: "Aman" });
    assert.equal(result.error, "SUPPORTED_DISTRICT_REQUIRED", toolName);
    assert.equal(result.status, "UNAVAILABLE", toolName);
    assert.deepEqual(new Set(result.supportedDistricts), new Set(["cumilla", "chattogram"]), toolName);
  }
});

test("Gemini passes the selected district to weather tools when the model omits location", async () => {
  const originalExecutor = toolExecutors.getLocationWeatherForecast;
  let receivedArgs;
  toolExecutors.getLocationWeatherForecast = async (args) => {
    receivedArgs = args;
    return { status: "UNAVAILABLE" };
  };

  try {
    const client = new GeminiAssistantClient("A".repeat(32), "isolated-test-model");
    let callCount = 0;
    client.ai = { models: { generateContent: async () => {
      callCount += 1;
      return callCount === 1
        ? { functionCalls: [{ name: "getLocationWeatherForecast", args: {} }], candidates: [{ content: { role: "model", parts: [] } }] }
        : { text: "Unavailable for this district." };
    } } };

    await client.generateGroundedResponse({ message: "Weather?", district: "Chattogram" });
    assert.equal(receivedArgs.location, "Chattogram");
    assert.equal(receivedArgs.district, "Chattogram");
  } finally {
    toolExecutors.getLocationWeatherForecast = originalExecutor;
  }
});
