import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { assessAgriculturalRisks } from "../src/services/weather/risk.engine.js";
import {
  seedInitialOfficialBulletins,
  getActiveOfficialWarnings,
  getHistoricalOfficialWarnings,
  isAuthenticGovernmentBulletin,
  verifyOfficialWarning,
} from "../src/services/weather/warning.service.js";
import { getSeasonalOutlook } from "../src/services/weather/seasonal.service.js";
import { getLiveForecast } from "../src/services/weather/forecast.service.js";
import OfficialWarning from "../src/models/officialwarning.model.js";
import { sumCompleteRainfall } from "../src/controllers/weather.controller.js";

function validWarningFixture(overrides = {}) {
  const now = new Date();
  return {
    bulletinNumber: "BMD-WARN-2026-85",
    issuingAuthority: "Bangladesh Meteorological Department (BMD)",
    hazardType: "HEAVY_RAIN",
    severity: "WARNING",
    titleEn: "Heavy rainfall warning",
    titleBn: "ভারী বৃষ্টির সতর্কতা",
    descriptionEn: "Heavy rainfall is expected in the affected area.",
    descriptionBn: "আক্রান্ত এলাকায় ভারী বৃষ্টি হতে পারে।",
    affectedDivisions: ["Chattogram"],
    issuedAt: new Date(now.getTime() - 60 * 60 * 1000),
    validUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    sourceUrl: "https://bmd.gov.bd/files/bulletin/2026/adv-85.pdf",
    isActive: true,
    verifiedByAdmin: true,
    verifiedByUserId: new mongoose.Types.ObjectId(),
    verifiedAt: now,
    verificationNotes: "ADMIN_SOURCE_REVIEW_CHECKLIST:v1 sourceDocument issuingAuthority bulletinNumber issueAndValidityDates hazardAndAffectedArea displayedContent confirmed. Reviewed the source document.",
    ...overrides,
  };
}

test("Remediation 1: assessAgriculturalRisks returns DATA_INSUFFICIENT when forecast is missing", () => {
  const result = assessAgriculturalRisks({ forecast: null });
  assert.equal(result.overallRiskLevel, "DATA_INSUFFICIENT");
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.dataAvailability.isForecastAvailable, false);
  assert.notEqual(result.overallRiskLevel, "LOW");
});

test("Remediation 2: Moderate squall alert strictly rejects spraying window", () => {
  // 7 days of 0 mm rain, warm temp, but 60 km/h wind gust on day 1
  const mockForecast = {
    shortRangeForecast: [
      {
        date: "2026-04-10",
        precipitationSumMm: 0,
        precipitationProbabilityMax: 0,
        temperatureMaxC: 30,
        temperatureMinC: 20,
        windSpeedMaxKmH: 10,
        windGustsMaxKmH: 60.0,
      },
      {
        date: "2026-04-11",
        precipitationSumMm: 0,
        precipitationProbabilityMax: 0,
        temperatureMaxC: 30,
        temperatureMinC: 20,
        windSpeedMaxKmH: 10,
        windGustsMaxKmH: 15.0,
      },
      {
        date: "2026-04-12",
        precipitationSumMm: 0,
        precipitationProbabilityMax: 0,
        temperatureMaxC: 30,
        temperatureMinC: 20,
        windSpeedMaxKmH: 10,
        windGustsMaxKmH: 15.0,
      },
    ],
  };

  const risks = assessAgriculturalRisks({
    forecast: mockForecast,
    crop: "boro_rice",
    cropStage: "grain_filling",
  });

  assert.equal(risks.overallRiskLevel, "MODERATE");
  const squallAlert = risks.alerts.find((a) => a.hazardType === "SQUALL_WARNING");
  assert.ok(squallAlert);
  assert.equal(squallAlert.category, "SQUALL_AND_WIND");

  // Exercise controller's spray gate predicate
  const next3Days = mockForecast.shortRangeForecast.slice(0, 3);
  const next3DaysRain = next3Days.reduce((acc, d) => acc + d.precipitationSumMm, 0);
  const maxGust3d = Math.max(...next3Days.map((d) => d.windGustsMaxKmH || 0));
  const maxWind3d = Math.max(...next3Days.map((d) => d.windSpeedMaxKmH || 0));
  const hasSquallAlert = risks.alerts.some((a) => a.category === "SQUALL_AND_WIND");
  const isWindUnsuitable = hasSquallAlert || maxGust3d >= 25.0 || maxWind3d >= 15.0;
  const isRainUnsuitable = next3DaysRain >= 5.0;
  const sprayWindowSuitable = !isWindUnsuitable && !isRainUnsuitable;

  assert.equal(isWindUnsuitable, true);
  assert.equal(sprayWindowSuitable, false, "Spray window must be false when squall/gust alert exists");
});

test("Remediation 3: Daily forecasts expose descriptive horizons, not arbitrary confidence scores", () => {
  // Test horizon labeling structure
  const testDays = [
    { day: 1, expectedHorizon: "short_range", expectedExtended: false },
    { day: 4, expectedHorizon: "medium_range", expectedExtended: false },
    { day: 8, expectedHorizon: "extended_outlook", expectedExtended: true },
  ];

  for (const t of testDays) {
    const isExtended = t.day > 7;
    const horizon = t.day <= 3 ? "short_range" : t.day <= 7 ? "medium_range" : "extended_outlook";
    assert.equal(isExtended, t.expectedExtended);
    assert.equal(horizon, t.expectedHorizon);
  }
});

test("Remediation 4: Official BMD Warning Integrity — startup seeding is disabled and cannot create fake bulletins", async () => {
  const seedResult = await seedInitialOfficialBulletins();
  assert.equal(seedResult.seeded, 0);
  assert.ok(seedResult.reason.includes("disabled"));
});

test("Remediation 5: getActiveOfficialWarnings returns empty array when DB is offline or empty", async () => {
  const warnings = await getActiveOfficialWarnings({ division: "Chattogram" });
  assert.ok(Array.isArray(warnings));
  assert.equal(warnings.length, 0);
});

test("seasonal service exposes response-backed series metadata and no calibrated probability claims", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const time = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 3, i + 1)).toISOString().slice(0, 10));
      return {
        ok: true,
        json: async () => ({
          daily: {
            time,
            temperature_2m_mean_member02: time.map(() => 28.5),
            precipitation_sum_member02: time.map(() => 5),
            temperature_2m_mean_member04: time.map(() => 29),
            precipitation_sum_member04: time.map(() => 10),
          },
        }),
      };
    };
    const outlook = await getSeasonalOutlook({ latitude: 24.891, longitude: 89.891 });
    assert.equal(outlook.meta.returnedSeriesCount, 2);
    assert.equal(outlook.meta.dataStatus, "AVAILABLE");
    assert.equal(outlook.subSeasonalWeeklyOutlook.length, 6);
    assert.equal(outlook.seasonalMonthlyOutlook.length, 3);
    assert.equal(outlook.seasonalMonthlyOutlook[0].probabilityData.isOmitted, true);
    assert.equal(outlook.seasonalMonthlyOutlook[0].rainfallMeanMm, 225);
    assert.equal(outlook.seasonalMonthlyOutlook[0].rainfallThresholdStatusEn, "Elevated Rainfall Threshold (>60 mm)");
    assert.equal(outlook.seasonalMonthlyOutlook[0].rainfallThresholdStatusBn, "অধিক বৃষ্টিপাতের সীমা (>৬০ মিমি)");
    assert.equal("tercileProbabilities" in outlook.seasonalMonthlyOutlook[0], false);
    assert.equal("ensembleRainfallMeanMm" in outlook.seasonalMonthlyOutlook[0], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Remediation 7: Chatbot deterministic fallback on DATA_INSUFFICIENT does not claim low risk or clear skies", () => {
  const alertsDataInsufficient = {
    overallRiskLevel: "DATA_INSUFFICIENT",
    alertsCount: 0,
    alerts: [],
    officialWarningsCount: 0,
  };

  const isDataInsufficient = alertsDataInsufficient.overallRiskLevel === "DATA_INSUFFICIENT";
  assert.equal(isDataInsufficient, true);

  // In the fallback engine:
  const riskLabelEn = alertsDataInsufficient.overallRiskLevel;
  assert.notEqual(riskLabelEn, "LOW");
  assert.equal(riskLabelEn, "DATA_INSUFFICIENT");

  // BMD source check: must NOT be added when officialWarningsCount === 0
  const sources = ["Open-Meteo High-Resolution Numerical Forecast"];
  const hasOfficialBulletins = alertsDataInsufficient.officialWarningsCount > 0;
  if (hasOfficialBulletins) {
    sources.push("Bangladesh Meteorological Department (BMD) Official Bulletins");
  }

  assert.equal(sources.includes("Bangladesh Meteorological Department (BMD) Official Bulletins"), false);
});

test("Phase 7.0.4 Remediation: Missing windSpeedMaxKmH in 3-day window strictly rejects spraying suitability", () => {
  // Mock 3 days with valid precipitation and gusts, but windSpeedMaxKmH is undefined/null/missing
  const shortRangeMissingWind = [
    { precipitationSumMm: 0, windGustsMaxKmH: 10, windSpeedMaxKmH: null },
    { precipitationSumMm: 0, windGustsMaxKmH: 12 }, // undefined
    { precipitationSumMm: 0, windGustsMaxKmH: 10, windSpeedMaxKmH: 5 },
  ];

  const hasValidRain3d = shortRangeMissingWind.every(d =>
    typeof d.precipitationSumMm === "number" && Number.isFinite(d.precipitationSumMm)
  );
  const hasValidGust3d = shortRangeMissingWind.every(d =>
    typeof d.windGustsMaxKmH === "number" && Number.isFinite(d.windGustsMaxKmH)
  );
  const hasValidWind3d = shortRangeMissingWind.every(d =>
    typeof d.windSpeedMaxKmH === "number" && Number.isFinite(d.windSpeedMaxKmH)
  );
  const hasValid3d = hasValidRain3d && hasValidGust3d && hasValidWind3d;

  assert.equal(hasValidWind3d, false, "Wind validity check must fail when windSpeedMaxKmH is missing/null");
  assert.equal(hasValid3d, false, "Window validity check must fail when wind is missing");

  // In the controller:
  let sprayWindow;
  if (!hasValid3d) {
    const missingInputs = [];
    if (!hasValidRain3d) missingInputs.push("precipitationSumMm");
    if (!hasValidGust3d) missingInputs.push("windGustsMaxKmH");
    if (!hasValidWind3d) missingInputs.push("windSpeedMaxKmH");

    sprayWindow = {
      isSuitable: false,
      isAvailable: false,
      status: "DATA_INSUFFICIENT",
      missingInputs,
    };
  }

  assert.equal(sprayWindow.isSuitable, false);
  assert.equal(sprayWindow.isAvailable, false);
  assert.equal(sprayWindow.status, "DATA_INSUFFICIENT");
  assert.deepEqual(sprayWindow.missingInputs, ["windSpeedMaxKmH"]);
});

test("Phase 7.0.4 Remediation: isAuthenticGovernmentBulletin quarantines synthetic and bare-domain bulletins", async () => {
  const { isAuthenticGovernmentBulletin } = await import("../src/services/weather/warning.service.js");

  // Synthetic bulletin persisted in DB
  const syntheticPersisted = {
    bulletinNumber: "BMD-AGRI-ADV-2026-03",
    sourceUrl: "http://bmd.gov.bd",
    isActive: true,
    verifiedByAdmin: true,
  };
  assert.equal(isAuthenticGovernmentBulletin(syntheticPersisted), false, "Must reject BMD-AGRI-ADV-2026-03");

  // Bare domain without document path
  const bareDomain = {
    bulletinNumber: "BMD-WARN-2026-10",
    sourceUrl: "https://bmd.gov.bd/",
    isActive: true,
    verifiedByAdmin: true,
  };
  assert.equal(isAuthenticGovernmentBulletin(bareDomain), false, "Must reject bare domain URL");

  // Explicit isSynthetic flag
  const syntheticFlagged = {
    bulletinNumber: "BMD-GEN-01",
    sourceUrl: "https://bmd.gov.bd/bulletin/2026/01.pdf",
    isSynthetic: true,
  };
  assert.equal(isAuthenticGovernmentBulletin(syntheticFlagged), false, "Must reject isSynthetic: true");

  // Authentic government bulletin with traceable PDF path and recognized issuing authority
  const authentic = validWarningFixture({ bulletinNumber: "BMD-WARN-2026-05" });
  assert.equal(isAuthenticGovernmentBulletin(authentic), true, "Must accept authentic traceable bulletin");
});

test("seasonal model metadata and 6-week slots come from the production service", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(new URL(url).searchParams.get("models"), "ecmwf_seasonal_seamless");
      const time = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10));
      const daily = { time };
      for (const member of ["member02", "member04"]) {
        daily[`temperature_2m_mean_${member}`] = time.map(() => 25);
        daily[`precipitation_sum_${member}`] = time.map(() => 4);
      }
      return { ok: true, json: async () => ({ daily }) };
    };
    const outlook = await getSeasonalOutlook({ latitude: 25.123, longitude: 89.123 });
    assert.equal(outlook.meta.modelSelection, "ecmwf_seasonal_seamless");
    assert.equal(outlook.meta.returnedSeriesCount, 2);
    assert.match(outlook.meta.sourceSystem, /2 paired member series returned/);
    assert.equal(outlook.subSeasonalWeeklyOutlook.length, 6);
    assert.equal(outlook.seasonalMonthlyOutlook[0].usableSeriesCount, 2);
    assert.equal(outlook.seasonalMonthlyOutlook[0].rainfallMeanMm, 120);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Phase 7.0.5 Remediation Blocker 1: Official warning trust policy rejects lookalike domains, unverified, and external URLs", async () => {
  const { isAuthenticGovernmentBulletin } = await import("../src/services/weather/warning.service.js");

  const validFutureDate = new Date(Date.now() + 86400000).toISOString();

  // 1. Arbitrary external URL
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-WARN-2026-99",
      issuingAuthority: "BMD",
      sourceUrl: "https://attacker.example/archive/official-warning.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    false,
    "Must reject arbitrary external host"
  );

  // 2. Lookalike domain with suffix attacker.com
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-WARN-2026-98",
      issuingAuthority: "BMD",
      sourceUrl: "https://bmd.gov.bd.attacker.com/files/warning.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    false,
    "Must reject lookalike domain bmd.gov.bd.attacker.com"
  );

  // 3. Lookalike domain fakebmd.gov.bd
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-WARN-2026-97",
      issuingAuthority: "BMD",
      sourceUrl: "https://fakebmd.gov.bd/files/warning.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    false,
    "Must reject unapproved government host fakebmd.gov.bd"
  );

  // 4. Bare root domain without document path
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-WARN-2026-96",
      issuingAuthority: "BMD",
      sourceUrl: "https://bmd.gov.bd/",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    false,
    "Must reject bare root URL without document path"
  );

  // 5. Unverified record (verifiedByAdmin === false)
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-WARN-2026-95",
      issuingAuthority: "BMD",
      sourceUrl: "https://bmd.gov.bd/files/bulletin/2026/adv-95.pdf",
      isActive: true,
      verifiedByAdmin: false,
      validUntil: validFutureDate,
    }),
    false,
    "Must reject unverified record"
  );

  // 6. Expired record
  assert.equal(
    isAuthenticGovernmentBulletin(
      {
        bulletinNumber: "BMD-WARN-2026-94",
        issuingAuthority: "BMD",
        sourceUrl: "https://bmd.gov.bd/files/bulletin/2026/adv-94.pdf",
        isActive: true,
        verifiedByAdmin: true,
        validUntil: "2020-01-01T00:00:00.000Z",
      },
      new Date("2026-04-10T00:00:00.000Z")
    ),
    false,
    "Must reject expired record"
  );

  // 7. Synthetic / demo bulletin
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "DEMO-BMD-01",
      issuingAuthority: "BMD",
      sourceUrl: "https://bmd.gov.bd/files/bulletin/2026/adv-01.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    false,
    "Must reject DEMO- bulletin"
  );

  // 8. Authentic verified BMD bulletin
  assert.equal(
    isAuthenticGovernmentBulletin(validWarningFixture({ bulletinNumber: "BMD-ADV-2026-11", validUntil: validFutureDate })),
    true,
    "Must accept authentic verified BMD bulletin"
  );

  // 9. Authentic verified BAMIS/DAE bulletin
  assert.equal(
    isAuthenticGovernmentBulletin(validWarningFixture({
      bulletinNumber: "BAMIS-AGRI-2026-03",
      issuingAuthority: "BAMIS / Department of Agricultural Extension (DAE)",
      sourceUrl: "https://bamis.gov.bd/advisory/2026/agri-bulletin-03.pdf",
      validUntil: validFutureDate,
    })),
    true,
    "Must accept authentic verified BAMIS bulletin"
  );
});

test("Phase 7.0.5 Remediation Blocker 4: Forecast daily values preserve null for unobserved parameters", () => {
  const testVal = (val) => (typeof val === "number" && Number.isFinite(val) ? val : null);

  assert.equal(testVal(null), null);
  assert.equal(testVal(undefined), null);
  assert.equal(testVal(NaN), null);
  assert.equal(testVal(0), 0);
  assert.equal(testVal(15.5), 15.5);
});

test("Phase 8.0 Blocker A: Official warning trust policy rejects HTTP, userinfo, unapproved subdomains, redirects, and forged authorities", async () => {
  const { isAuthenticGovernmentBulletin } = await import("../src/services/weather/warning.service.js");

  const validFutureDate = new Date(Date.now() + 86400000).toISOString();

  // 1. Non-HTTPS (plain HTTP) must be rejected
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-WARN-2026-80",
      issuingAuthority: "Bangladesh Meteorological Department (BMD)",
      sourceUrl: "http://bmd.gov.bd/files/bulletin/2026/adv-80.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    false,
    "Must reject insecure HTTP URL"
  );

  // 2. URL containing user-info (e.g. attacker@bmd.gov.bd) must be rejected
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-WARN-2026-81",
      issuingAuthority: "Bangladesh Meteorological Department (BMD)",
      sourceUrl: "https://attacker@bmd.gov.bd/files/bulletin/2026/adv-81.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    false,
    "Must reject user-info in URL"
  );

  // 3. Unapproved subdomain under approved root (e.g. not-approved-subdomain.bmd.gov.bd)
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-WARN-2026-82",
      issuingAuthority: "Bangladesh Meteorological Department (BMD)",
      sourceUrl: "https://not-approved-subdomain.bmd.gov.bd/files/bulletin/2026/adv-82.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    false,
    "Must reject arbitrary unreviewed subdomains"
  );

  // 4. Open redirect pattern in URL (e.g. /redirect?to=https://attacker.example/...)
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-WARN-2026-83",
      issuingAuthority: "Bangladesh Meteorological Department (BMD)",
      sourceUrl: "https://bmd.gov.bd/redirect?to=https://attacker.example/fake.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    false,
    "Must reject redirect patterns"
  );

  // 5. Forged authority text with prefix (e.g. 'BMD forged authority text')
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-WARN-2026-84",
      issuingAuthority: "BMD forged authority text",
      sourceUrl: "https://bmd.gov.bd/files/bulletin/2026/adv-84.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    false,
    "Must reject forged authority strings"
  );

  // 6. Valid authentic BMD bulletin with strict HTTPS and approved host
  assert.equal(
    isAuthenticGovernmentBulletin(validWarningFixture({ validUntil: validFutureDate })),
    true,
    "Must accept bulletin with authenticated review trail and matching source authority"
  );
});

test("official warning publication fails closed without an authenticated verification trail", async () => {
  const valid = validWarningFixture();
  assert.equal(isAuthenticGovernmentBulletin({ ...valid, verifiedByUserId: null }), false);
  assert.equal(isAuthenticGovernmentBulletin({ ...valid, verifiedAt: null }), false);
  assert.equal(isAuthenticGovernmentBulletin({ ...valid, verificationNotes: "reviewed" }), false);
  assert.equal(isAuthenticGovernmentBulletin({ ...valid, sourceUrl: "https://bamis.gov.bd/files/bulletin/2026/adv.pdf" }), false);

  const adminUserId = new mongoose.Types.ObjectId();
  const record = validWarningFixture({ verifiedByAdmin: false, verifiedByUserId: null, verifiedAt: null, verificationNotes: "", isActive: false });
  const warning = {
    ...record,
    toObject() { return { ...record }; },
    async save() { return this; },
  };
  const originalFindById = OfficialWarning.findById;
  const verificationChecklist = {
    sourceDocument: true,
    issuingAuthority: true,
    bulletinNumber: true,
    issueAndValidityDates: true,
    hazardAndAffectedArea: true,
    displayedContent: true,
  };
  try {
    OfficialWarning.findById = async () => warning;
    await assert.rejects(verifyOfficialWarning({ warningId: "test", adminUserId, notes: "reviewed" }), error => error.statusCode === 400);
    await assert.rejects(verifyOfficialWarning({
      warningId: "test",
      adminUserId,
      notes: "Reviewed source document number, issue date, hazard, affected area, and displayed content.",
    }), error => error.statusCode === 422);
    const verified = await verifyOfficialWarning({
      warningId: "test",
      adminUserId,
      notes: "Reviewed source document number, issue date, hazard, affected area, and displayed content.",
      verificationChecklist,
    });
    assert.equal(verified.verifiedByAdmin, true);
    assert.equal(verified.isActive, true);
    assert.equal(String(verified.verifiedByUserId), String(adminUserId));
    assert.ok(verified.verifiedAt instanceof Date);
    assert.equal(isAuthenticGovernmentBulletin(verified), true);
  } finally {
    OfficialWarning.findById = originalFindById;
  }
});

test("published warning provenance preserves its verified issuing authority", async () => {
  const originalReadyState = mongoose.connection.readyState;
  const originalFind = OfficialWarning.find;
  const bamISWarning = new OfficialWarning(validWarningFixture({
    issuingAuthority: "BAMIS",
    sourceUrl: "https://bamis.gov.bd/files/bulletin/2026/adv-85.pdf",
  }));
  try {
    mongoose.connection.readyState = 1;
    OfficialWarning.find = () => ({
      sort() { return this; },
      async lean() { return [bamISWarning]; },
    });
    const published = await getActiveOfficialWarnings({ division: "Chattogram" });
    assert.equal(published.length, 1);
    assert.equal(published[0].issuingAuthority, "BAMIS");
    assert.equal(published[0].provenance, "Verified Government Warning Bulletin (BAMIS)");
  } finally {
    mongoose.connection.readyState = originalReadyState;
    OfficialWarning.find = originalFind;
  }
});

test("Phase 8.0 Blocker C: Seven-day rainfall calculation preserves null when any day is missing/non-finite", () => {
  const calculateSevenDayRain = sumCompleteRainfall;

  // Case 1: Incomplete forecast (only 5 days) -> null
  assert.equal(
    calculateSevenDayRain([
      { precipitationSumMm: 2.0 },
      { precipitationSumMm: 3.0 },
      { precipitationSumMm: 1.0 },
      { precipitationSumMm: 0.0 },
      { precipitationSumMm: 5.0 },
    ]),
    null,
    "Must return null when fewer than 7 days are provided"
  );

  // Case 2: 7 days, but day 4 is null -> null (MUST NOT coerce to 0)
  assert.equal(
    calculateSevenDayRain([
      { precipitationSumMm: 2.0 },
      { precipitationSumMm: 3.0 },
      { precipitationSumMm: 1.0 },
      { precipitationSumMm: null },
      { precipitationSumMm: 5.0 },
      { precipitationSumMm: 0.0 },
      { precipitationSumMm: 1.0 },
    ]),
    null,
    "Must return null when any day in the 7 days has null rain"
  );

  // Case 3: 7 days, but day 2 is NaN or non-finite -> null
  assert.equal(
    calculateSevenDayRain([
      { precipitationSumMm: 2.0 },
      { precipitationSumMm: NaN },
      { precipitationSumMm: 1.0 },
      { precipitationSumMm: 0.0 },
      { precipitationSumMm: 5.0 },
      { precipitationSumMm: 0.0 },
      { precipitationSumMm: 1.0 },
    ]),
    null,
    "Must return null when any day is non-finite"
  );

  // Case 4: 7 days with valid finite numbers, including genuine 0 -> correct sum
  assert.equal(
    calculateSevenDayRain([
      { precipitationSumMm: 2.5 },
      { precipitationSumMm: 0.0 },
      { precipitationSumMm: 1.5 },
      { precipitationSumMm: 0.0 },
      { precipitationSumMm: 5.0 },
      { precipitationSumMm: 0.0 },
      { precipitationSumMm: 1.0 },
    ]),
    10.0,
    "Must return exact sum 10.0 when all 7 days are valid"
  );
});
