/**
 * Krishi Mama — Agricultural Weather Intelligence Test Suite.
 * Validates deterministic BMD threshold evaluation, crop vulnerability mapping,
 * coordinate resolution for all 8 divisions, and forecast data structures.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveLocationCoordinates, BMD_THRESHOLDS } from "../src/config/weather.config.js";
import { assessAgriculturalRisks } from "../src/services/weather/risk.engine.js";
import { getLiveForecast } from "../src/services/weather/forecast.service.js";
import { getSeasonalOutlook } from "../src/services/weather/seasonal.service.js";

test("resolveLocationCoordinates - resolves centroids for all 8 divisions and districts", () => {
  const divisions = ["dhaka", "chattogram", "rajshahi", "khulna", "barishal", "sylhet", "rangpur", "mymensingh"];

  for (const div of divisions) {
    const loc = resolveLocationCoordinates(div);
    assert.ok(loc.latitude > 20 && loc.latitude < 27, `Invalid latitude for ${div}: ${loc.latitude}`);
    assert.ok(loc.longitude > 88 && loc.longitude < 93, `Invalid longitude for ${div}: ${loc.longitude}`);
    assert.ok(loc.type === "division_centroid" || loc.type === "district_centroid");
  }

  // District resolution
  const cumilla = resolveLocationCoordinates("cumilla");
  assert.equal(cumilla.type, "district_centroid");
  assert.equal(cumilla.isRepresentative, false);

  // Exact coordinates
  const custom = resolveLocationCoordinates({ latitude: 22.35, longitude: 91.82, locationName: "Custom Farm" });
  assert.equal(custom.type, "farm_coordinates");
  assert.equal(custom.latitude, 22.35);
});

test("assessAgriculturalRisks - evaluates very heavy rainfall threshold (>=89mm)", () => {
  const mockForecast = {
    shortRangeForecast: [
      {
        date: "2026-06-15",
        precipitationSumMm: 95.0,
        precipitationProbabilityMax: 90,
        temperatureMaxC: 30,
        temperatureMinC: 24,
        windSpeedMaxKmH: 20,
        windGustsMaxKmH: 35,
      },
    ],
  };

  const assessment = assessAgriculturalRisks({
    forecast: mockForecast,
    crop: "monsoon_aman",
    cropStage: "transplanting",
  });

  assert.equal(assessment.overallRiskLevel, "HIGH");
  assert.ok(assessment.alerts.some((a) => a.hazardType === "VERY_HEAVY_RAINFALL"));
  assert.ok(assessment.pauseActionsEn.some((p) => p.includes("Pause chemical spraying")));
});

test("assessAgriculturalRisks - evaluates severe heatwave threshold (>=40°C)", () => {
  const mockForecast = {
    shortRangeForecast: [
      {
        date: "2026-04-20",
        precipitationSumMm: 0,
        precipitationProbabilityMax: 10,
        temperatureMaxC: 41.5,
        temperatureMinC: 28,
        windSpeedMaxKmH: 15,
        windGustsMaxKmH: 25,
      },
    ],
  };

  const assessment = assessAgriculturalRisks({
    forecast: mockForecast,
    crop: "boro_rice",
    cropStage: "flowering",
  });

  assert.equal(assessment.overallRiskLevel, "SEVERE");
  assert.ok(assessment.alerts.some((a) => a.hazardType === "SEVERE_HEATWAVE"));
});

test("assessAgriculturalRisks - evaluates coldwave threshold (<=6°C) for Boro seedbeds", () => {
  const mockForecast = {
    shortRangeForecast: [
      {
        date: "2026-01-10",
        precipitationSumMm: 0,
        precipitationProbabilityMax: 0,
        temperatureMaxC: 18,
        temperatureMinC: 5.5,
        windSpeedMaxKmH: 10,
        windGustsMaxKmH: 15,
      },
    ],
  };

  const assessment = assessAgriculturalRisks({
    forecast: mockForecast,
    crop: "boro_rice",
    cropStage: "nursery",
  });

  assert.equal(assessment.overallRiskLevel, "SEVERE");
  assert.ok(assessment.alerts.some((a) => a.hazardType === "SEVERE_COLDWAVE"));
});

test("assessAgriculturalRisks - evaluates squall / high wind gusts (>=55 km/h)", () => {
  const mockForecast = {
    shortRangeForecast: [
      {
        date: "2026-04-12",
        precipitationSumMm: 12.0,
        precipitationProbabilityMax: 60,
        temperatureMaxC: 33,
        temperatureMinC: 22,
        windSpeedMaxKmH: 35,
        windGustsMaxKmH: 62.0,
      },
    ],
  };

  const assessment = assessAgriculturalRisks({
    forecast: mockForecast,
    crop: "boro_rice",
    cropStage: "grain_filling",
  });

  assert.equal(assessment.overallRiskLevel, "MODERATE");
  assert.ok(assessment.alerts.some((a) => a.hazardType === "SQUALL_WARNING"));
});

test("getLiveForecast - retrieves structured forecast with 7-day short-range and 9-day extended", async () => {
  const forecast = await getLiveForecast({ locationIdentifier: "Sylhet" });

  assert.ok(forecast.location);
  assert.equal(forecast.shortRangeForecast.length, 7);
  assert.equal(forecast.extendedForecast.length, 9);
  assert.equal(forecast.shortRangeForecast[0].isExtended, false);
  assert.equal(forecast.extendedForecast[0].isExtended, true);
  assert.ok(forecast.meta.provider.includes("Open-Meteo"));
});

test("getSeasonalOutlook - retrieves 6-week subseasonal and 3-month seasonal blocks", async () => {
  const outlook = await getSeasonalOutlook({ locationIdentifier: "Rajshahi" });

  assert.ok(outlook.location);
  assert.equal(outlook.subSeasonalWeeklyOutlook.length, 6);
  assert.equal(outlook.seasonalMonthlyOutlook.length, 3);
  assert.ok(outlook.meta.sourceSystem.includes("Open-Meteo Seasonal"));
  assert.equal(outlook.seasonalMonthlyOutlook[0].tercileProbabilities.isOmitted, true);
});
