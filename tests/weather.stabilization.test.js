import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createApp } from "../src/app.js";
import { getLiveForecast } from "../src/services/weather/forecast.service.js";
import { getSeasonalOutlook } from "../src/services/weather/seasonal.service.js";

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

function dateSeries(length) {
  const start = new Date("2026-01-01T00:00:00Z");
  return Array.from({ length }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
}

function validForecastBody() {
  const time = dateSeries(16);
  return {
    timezone: "Asia/Dhaka",
    daily: {
      time,
      temperature_2m_max: time.map(() => 30),
      temperature_2m_min: time.map(() => 20),
      precipitation_sum: time.map(() => 0),
      precipitation_probability_max: time.map(() => 0),
      wind_speed_10m_max: time.map(() => 10),
      wind_gusts_10m_max: time.map(() => 15),
      weather_code: time.map(() => 0),
    },
  };
}

function validSeasonalBody() {
  const time = dateSeries(183);
  return {
    daily: {
      time,
      temperature_2m_mean: time.map(() => 25),
      precipitation_sum: time.map(() => 1),
    },
  };
}

test("forecast service accepts complete provider data and rejects missing measurements", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => jsonResponse(validForecastBody());
    const forecast = await getLiveForecast({ latitude: 20.011, longitude: 89.011 });
    assert.equal(forecast.shortRangeForecast.length, 7);
    assert.equal(forecast.extendedForecast.length, 9);
    assert.equal(forecast.shortRangeForecast[0].precipitationSumMm, 0);

    globalThis.fetch = async () => {
      const body = validForecastBody();
      body.daily.temperature_2m_max[4] = null;
      return jsonResponse(body);
    };
    await assert.rejects(
      getLiveForecast({ latitude: 20.012, longitude: 89.012 }),
      error => error.statusCode === 502 && /incomplete temperature_2m_max/.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("seasonal service rejects incomplete data instead of substituting zeros or default temperatures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => jsonResponse(validSeasonalBody());
    const outlook = await getSeasonalOutlook({ latitude: 20.021, longitude: 89.021 });
    assert.equal(outlook.subSeasonalWeeklyOutlook.length, 6);
    assert.equal(outlook.seasonalMonthlyOutlook.length, 3);
    assert.equal(outlook.subSeasonalWeeklyOutlook[0].expectedRainfallMeanMm, 7);

    globalThis.fetch = async () => {
      const body = validSeasonalBody();
      body.daily.precipitation_sum[2] = null;
      return jsonResponse(body);
    };
    await assert.rejects(
      getSeasonalOutlook({ latitude: 20.022, longitude: 89.022 }),
      error => error.statusCode === 502 && /no complete values for week 1/.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("weather routes reject unknown locations and report provider outages as 503", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("http://127.0.0.1:")) return originalFetch(input, init);
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("blocked in isolated test"), { code: "EACCES" }),
    });
  };

  const server = http.createServer(createApp());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  try {
    const invalid = await originalFetch(`${baseUrl}/weather/outlook?district=unknown-place`);
    assert.equal(invalid.status, 400);

    const outlook = await originalFetch(`${baseUrl}/weather/outlook?district=sylhet`);
    assert.equal(outlook.status, 503);

    const cropPlanning = await originalFetch(`${baseUrl}/weather/crop-planning?district=chattogram`);
    assert.equal(cropPlanning.status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = originalFetch;
  }
});
