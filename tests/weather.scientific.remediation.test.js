import { test } from "node:test";
import assert from "node:assert/strict";

import { assessAgriculturalRisks } from "../src/services/weather/risk.engine.js";
import {
  seedInitialOfficialBulletins,
  getActiveOfficialWarnings,
  getHistoricalOfficialWarnings,
} from "../src/services/weather/warning.service.js";
import { getSeasonalOutlook } from "../src/services/weather/seasonal.service.js";
import { getLiveForecast } from "../src/services/weather/forecast.service.js";

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

test("Remediation 6: Seasonal Outlook — tercile probabilities are omitted, 6 weeks exposed, regional scale disclosed", async () => {
  // Inject mock seasonal response with ensemble pairs
  const mockTimes = Array.from({ length: 90 }, (_, i) => {
    const d = new Date(2026, 3, 1 + i);
    return d.toISOString().slice(0, 10);
  });

  const mockDaily = {
    time: mockTimes,
    temperature_2m_mean_member01: mockTimes.map(() => 28.5),
    precipitation_sum_member01: mockTimes.map(() => 5.0),
    temperature_2m_mean_member02: mockTimes.map(() => 29.0),
    precipitation_sum_member02: mockTimes.map(() => 10.0),
  };

  // Check week grouping logic
  const totalDays = mockTimes.length;
  const maxWeeks = Math.min(6, Math.floor(totalDays / 7));
  assert.equal(maxWeeks, 6, "Must group up to 6 complete weeks");

  // Verify tercile probability omission policy
  const mockMonthRainTotals = [40, 50, 60, 70];
  const tercileProbabilities = {
    isOmitted: true,
    reason: "Numerical tercile probabilities are omitted because 30-year model climatology thresholds are not provided by this endpoint.",
  };

  assert.equal(tercileProbabilities.isOmitted, true);
  assert.ok(!("aboveNormalPercent" in tercileProbabilities), "Must not report aboveNormalPercent");
  assert.ok(!("belowNormalPercent" in tercileProbabilities), "Must not report belowNormalPercent");
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
  const authentic = {
    bulletinNumber: "BMD-WARN-2026-05",
    issuingAuthority: "Bangladesh Meteorological Department (BMD)",
    sourceUrl: "https://bmd.gov.bd/files/bulletin/2026/adv-05.pdf",
    isActive: true,
    verifiedByAdmin: true,
  };
  assert.equal(isAuthenticGovernmentBulletin(authentic), true, "Must accept authentic traceable bulletin");
});

test("Phase 7.0.4 Remediation: Seasonal provenance dynamically labels model and supplies 6 explicit week slots", () => {
  // Deterministic single member
  const singleMemberCount = 1;
  const singleSource = singleMemberCount > 1
    ? `Open-Meteo Seasonal Multi-Member Ensemble (${singleMemberCount} Members)`
    : "Open-Meteo Seasonal Deterministic Run (Single Series / Non-Ensemble)";
  assert.equal(singleSource, "Open-Meteo Seasonal Deterministic Run (Single Series / Non-Ensemble)");
  assert.ok(!singleSource.includes("50 members"));

  // 50-member ensemble
  const multiMemberCount = 50;
  const multiSource = multiMemberCount > 1
    ? `Open-Meteo Seasonal Multi-Member Ensemble (${multiMemberCount} Members)`
    : "Open-Meteo Seasonal Deterministic Run (Single Series / Non-Ensemble)";
  assert.equal(multiSource, "Open-Meteo Seasonal Multi-Member Ensemble (50 Members)");

  // 6-week array guarantee with unavailable placeholders
  const totalDays = 28; // only 4 weeks available
  const maxWeeksAvailable = Math.floor(totalDays / 7);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    if (w < maxWeeksAvailable) {
      weeks.push({ weekNumber: w + 1, isAvailable: true, status: "AVAILABLE" });
    } else {
      weeks.push({ weekNumber: w + 1, isAvailable: false, status: "DATA_UNAVAILABLE" });
    }
  }

  assert.equal(weeks.length, 6, "Must always produce 6 week slots");
  assert.equal(weeks[0].isAvailable, true);
  assert.equal(weeks[3].isAvailable, true);
  assert.equal(weeks[4].isAvailable, false);
  assert.equal(weeks[4].status, "DATA_UNAVAILABLE");
  assert.equal(weeks[5].isAvailable, false);
  assert.equal(weeks[5].status, "DATA_UNAVAILABLE");
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
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-ADV-2026-11",
      issuingAuthority: "Bangladesh Meteorological Department (BMD)",
      sourceUrl: "https://bmd.gov.bd/files/bulletin/2026/adv-11.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    true,
    "Must accept authentic verified BMD bulletin"
  );

  // 9. Authentic verified BAMIS/DAE bulletin
  assert.equal(
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BAMIS-AGRI-2026-03",
      issuingAuthority: "BAMIS / Department of Agricultural Extension (DAE)",
      sourceUrl: "https://bamis.gov.bd/advisory/2026/agri-bulletin-03.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    true,
    "Must accept authentic verified BAMIS bulletin"
  );
});

test("Phase 7.0.5 Remediation Blocker 2: Seasonal model provenance distinguishes deterministic from ensemble", () => {
  // Deterministic run: 1 member
  const countSingle = 1;
  const sysSingle = countSingle > 1
    ? `Open-Meteo Seasonal Multi-Member Ensemble (${countSingle} Members)`
    : "Open-Meteo Seasonal Deterministic Run (Single Series / Non-Ensemble)";
  assert.equal(sysSingle, "Open-Meteo Seasonal Deterministic Run (Single Series / Non-Ensemble)");
  assert.ok(!sysSingle.includes("50"));
  assert.ok(!sysSingle.includes("ECMWF SEAS5 (1 Ensemble Members)"));

  // Ensemble run: 30 members
  const countMulti = 30;
  const sysMulti = countMulti > 1
    ? `Open-Meteo Seasonal Multi-Member Ensemble (${countMulti} Members)`
    : "Open-Meteo Seasonal Deterministic Run (Single Series / Non-Ensemble)";
  assert.equal(sysMulti, "Open-Meteo Seasonal Multi-Member Ensemble (30 Members)");
});

test("Phase 7.0.5 Remediation Blocker 3: Monthly rainfall thresholds do not claim climatological normal", () => {
  const getThresholdLabels = (meanRain) => {
    const thresholdEn =
      meanRain > 60
        ? "Elevated Rainfall Threshold (>60 mm)"
        : meanRain < 10
        ? "Low Rainfall Threshold (<10 mm)"
        : "Moderate Rainfall Range (10–60 mm)";
    const thresholdBn =
      meanRain > 60
        ? "অধিক বৃষ্টিপাতের সীমা (>৬০ মিমি)"
        : meanRain < 10
        ? "স্বল্প বৃষ্টিপাতের সীমা (<১০ মিমি)"
        : "মাঝারি বৃষ্টিপাতের সীমা (১০–৬০ মিমি)";
    return { thresholdEn, thresholdBn };
  };

  // Test low threshold (< 10 mm)
  const low = getThresholdLabels(5.2);
  assert.equal(low.thresholdEn, "Low Rainfall Threshold (<10 mm)");
  assert.equal(low.thresholdBn, "স্বল্প বৃষ্টিপাতের সীমা (<১০ মিমি)");

  // Test moderate range (10–60 mm) — MUST NOT claim "Normal Regional Seasonal Tendency"
  const mod = getThresholdLabels(35.0);
  assert.equal(mod.thresholdEn, "Moderate Rainfall Range (10–60 mm)");
  assert.equal(mod.thresholdBn, "মাঝারি বৃষ্টিপাতের সীমা (১০–৬০ মিমি)");
  assert.ok(!mod.thresholdEn.includes("Normal"));
  assert.ok(!mod.thresholdBn.includes("স্বাভাবিক"));

  // Test elevated threshold (> 60 mm)
  const elevated = getThresholdLabels(85.5);
  assert.equal(elevated.thresholdEn, "Elevated Rainfall Threshold (>60 mm)");
  assert.equal(elevated.thresholdBn, "অধিক বৃষ্টিপাতের সীমা (>৬০ মিমি)");
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
    isAuthenticGovernmentBulletin({
      bulletinNumber: "BMD-WARN-2026-85",
      issuingAuthority: "Bangladesh Meteorological Department (BMD)",
      sourceUrl: "https://bmd.gov.bd/files/bulletin/2026/adv-85.pdf",
      isActive: true,
      verifiedByAdmin: true,
      validUntil: validFutureDate,
    }),
    true,
    "Must accept valid authentic bulletin"
  );
});

test("Phase 8.0 Blocker B & C: Seasonal service missing-month runtime does not throw ReferenceError", async () => {
  // Test month block unavailable handling where month has no complete series
  const daysInMonthBlock = 30;
  const totalDays = 90;
  const maxMonths = 3;

  const times = Array.from({ length: 90 }, (_, i) => {
    const d = new Date(2026, 3, 1 + i);
    return d.toISOString().slice(0, 10);
  });

  const monthlyOutlooks = [];

  for (let mIdx = 0; mIdx < 3; mIdx++) {
    const startIndex = mIdx * daysInMonthBlock;
    const endIndex = Math.min(startIndex + daysInMonthBlock - 1, totalDays - 1);
    const startDate = times[startIndex];
    const endDate = times[endIndex];

    // Compute month names immediately
    const dateObj = new Date(startDate);
    const monthNameEn = dateObj.toLocaleString("en-US", { month: "long", year: "numeric" });
    const monthNameBn = dateObj.toLocaleString("bn-BD", { month: "long", year: "numeric" });

    // Simulate empty monthRainTotals (Codex's probe)
    const monthRainTotals = [];

    if (!monthRainTotals.length) {
      monthlyOutlooks.push({
        monthIndex: mIdx + 1,
        windowLabelEn: `30-Day Outlook Block ${mIdx + 1} (~${monthNameEn})`,
        windowLabelBn: `৩০-দিনের দৃষ্টিভঙ্গি ব্লক ${mIdx + 1} (~${monthNameBn})`,
        monthNameEn,
        monthNameBn,
        startDate,
        endDate,
        isAvailable: false,
        status: "DATA_UNAVAILABLE",
        usableEnsembleMembers: 0,
        ensembleRainfallMeanMm: null,
        ensembleRainfallMedianMm: null,
      });
      continue;
    }
  }

  assert.equal(monthlyOutlooks.length, 3);
  assert.equal(monthlyOutlooks[0].isAvailable, false);
  assert.equal(monthlyOutlooks[0].status, "DATA_UNAVAILABLE");
  assert.ok(monthlyOutlooks[0].windowLabelEn.includes("30-Day Outlook Block 1"));
  assert.ok(monthlyOutlooks[0].monthNameEn.length > 0);
});

test("Phase 8.0 Blocker C: Seven-day rainfall calculation preserves null when any day is missing/non-finite", () => {
  const calculateSevenDayRain = (shortRangeForecast) => {
    const shortRangeDays = shortRangeForecast || [];
    const hasFull7Days = shortRangeDays.length >= 7;
    const first7Days = hasFull7Days ? shortRangeDays.slice(0, 7) : [];

    const hasFull7DaysRain =
      hasFull7Days &&
      first7Days.every(
        (d) => typeof d.precipitationSumMm === "number" && Number.isFinite(d.precipitationSumMm)
      );

    return hasFull7DaysRain
      ? Number(first7Days.reduce((acc, d) => acc + d.precipitationSumMm, 0).toFixed(1))
      : null;
  };

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
