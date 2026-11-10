/** Resumable, insert-only GPM expansion for Bangladesh local civil day(s). */
import dotenv from "dotenv";
dotenv.config();

import crypto from "node:crypto";
import mongoose from "mongoose";
import { GPM } from "../config/gpm.config.js";
import { GpmObservation } from "../models/gpmobservation.model.js";
import { aggregateBangladeshLocalDays } from "../services/nasa/gpm.validation.js";
import { buildGpmOpendapUrl, parseGpmOpendapAscii } from "../services/nasa/gpm.opendap.js";
import { getEarthdataAuthHeader } from "../services/nasa/earthdata.auth.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function getDateList() {
  const singleDate = process.argv.find(arg => arg.startsWith("--date="))?.slice("--date=".length);
  const start = process.argv.find(arg => arg.startsWith("--start="))?.slice("--start=".length);
  const end = process.argv.find(arg => arg.startsWith("--end="))?.slice("--end=".length);

  if (singleDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(singleDate) || Number.isNaN(Date.parse(`${singleDate}T00:00:00Z`))) {
      throw new Error("Pass exactly one Bangladesh local date as --date=YYYY-MM-DD");
    }
    return [singleDate];
  }

  if (start && end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
      throw new Error("Pass valid range as --start=YYYY-MM-DD --end=YYYY-MM-DD (start <= end)");
    }
    const dates = [];
    let cur = new Date(`${start}T00:00:00Z`);
    const stop = new Date(`${end}T00:00:00Z`);
    while (cur <= stop) {
      dates.push(cur.toISOString().slice(0, 10));
      cur = new Date(cur.getTime() + 86400000);
    }
    return dates;
  }

  throw new Error("Pass either --date=YYYY-MM-DD or --start=YYYY-MM-DD --end=YYYY-MM-DD");
}

async function searchGranules(localDate) {
  const startLocalMidnightUtc = new Date(`${localDate}T00:00:00+06:00`);
  const startUtc = new Date(startLocalMidnightUtc.getTime());
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000 - 1000);
  const url = new URL(GPM.cmrSearchUrl);
  url.search = new URLSearchParams({
    short_name: GPM.shortName,
    version: GPM.version,
    provider: GPM.cmrProvider,
    temporal: `${startUtc.toISOString()},${endUtc.toISOString()}`,
    page_size: "100",
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`NASA CMR returned HTTP ${response.status}`);
  const body = await response.json();
  const entries = (body.feed?.entry || [])
    .filter(entry => entry.producer_granule_id?.endsWith(".V07B.HDF5"))
    .sort((a, b) => a.time_start.localeCompare(b.time_start));
  const expectedStarts = Array.from({ length: 48 }, (_, i) => new Date(startUtc.getTime() + i * 1800000).toISOString());
  const actualStarts = entries.map(entry => new Date(entry.time_start).toISOString());
  if (entries.length !== 48 || new Set(actualStarts).size !== 48 ||
      expectedStarts.some(start => !actualStarts.includes(start)) ||
      entries.some(entry => !entry.links?.some(link => link.href?.includes(".HDF5") && link.rel?.includes("data#")))) {
    throw new Error(`CMR coverage gate failed for ${localDate}: expected 48 unique Final V07 granules`);
  }
  return entries;
}

async function fetchWithRetry(sourceUrl, tokenHeader, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    try {
      const response = await fetch(sourceUrl, {
        headers: { Authorization: tokenHeader, Accept: "text/plain" },
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 401) throw new Error("NASA GES DISC authentication failed (HTTP 401)");
      if (response.status === 403) throw new Error("NASA GES DISC authorization failed (HTTP 403)");
      if (response.status === 429 || response.status === 503) {
        attempt += 1;
        if (attempt > maxRetries) {
          throw new Error(`NASA GES DISC rate limit / service error (HTTP ${response.status}) exceeded ${maxRetries} retries`);
        }
        const backoffMs = Math.pow(2, attempt) * 2000;
        console.warn(`[GPM] HTTP ${response.status}; backing off for ${backoffMs}ms (retry ${attempt}/${maxRetries})...`);
        await delay(backoffMs);
        continue;
      }
      if (!response.ok) throw new Error(`NASA OPeNDAP returned HTTP ${response.status}`);
      return response;
    } catch (err) {
      if (err.name === "TimeoutError" || err.message?.includes("timeout") || err.message?.includes("ECONNRESET")) {
        attempt += 1;
        if (attempt > maxRetries) throw err;
        const backoffMs = Math.pow(2, attempt) * 2000;
        console.warn(`[GPM] Network timeout (${err.message}); backing off for ${backoffMs}ms (retry ${attempt}/${maxRetries})...`);
        await delay(backoffMs);
        continue;
      }
      throw err;
    }
  }
}

async function processLocalDate(localDate, tokenHeader, runId) {
  const districtCodes = Object.keys(GPM.districtGridTargets);
  const existingCount = await GpmObservation.countDocuments({
    dateLabel: localDate,
    districtCode: { $in: districtCodes },
  });

  // If already fully populated with 48 intervals for both districts (96 records)
  if (existingCount === 48 * districtCodes.length) {
    const records = await GpmObservation.find({
      dateLabel: localDate,
      districtCode: { $in: districtCodes },
    }).lean();
    const daily = aggregateBangladeshLocalDays(records);
    return {
      localDate,
      status: "already_complete",
      expectedGranules: 48,
      skippedExistingGranules: 48,
      upsertedObservations: 0,
      dailyAggregation: daily,
    };
  }

  const granules = await searchGranules(localDate);
  let requests = 0;
  let newRecords = 0;
  let skippedGranules = 0;

  for (const granule of granules) {
    const granuleId = granule.producer_granule_id;
    const count = await GpmObservation.countDocuments({
      granuleId,
      districtCode: { $in: districtCodes },
    });
    if (count === districtCodes.length) {
      skippedGranules += 1;
      continue;
    }

    if (requests > 0) await delay(1500);
    const sourceUrl = buildGpmOpendapUrl(granule);
    const response = await fetchWithRetry(sourceUrl, tokenHeader);
    requests += 1;

    const text = await response.text();
    if (Buffer.byteLength(text) > 20000) {
      throw new Error(`Unexpectedly large OPeNDAP response for ${granuleId}`);
    }

    const parsed = parseGpmOpendapAscii(text, {
      granuleId,
      cmrUpdated: granule.updated,
      sourceUrl: sourceUrl.split("?")[0],
    });

    if (parsed.observations.some(item => item.dateLabel !== localDate)) {
      throw new Error(`Granule ${granuleId} falls outside expected Bangladesh local day ${localDate}`);
    }

    const operations = parsed.observations.map(item => {
      const document = {
        ...item,
        intervalStartUtc: new Date(item.intervalStartUtc),
        intervalEndUtc: new Date(item.intervalEndUtc),
        unit: GPM.precipitationUnit,
        datasetKey: GPM.datasetKey,
        product: GPM.product,
        runType: GPM.runType,
        productVersion: GPM.granuleVersion,
        granuleId,
        ingestionRunId: runId,
        provenance: {
          provider: GPM.provider,
          collectionConceptId: GPM.collectionConceptId,
          doi: GPM.doi,
          algorithmVersion: "3IMERGH_7.0",
          cmrUpdated: parsed.cmrUpdated,
          sourceUrl: parsed.sourceUrl,
          responseSha256: parsed.responseSha256,
          timeStandard: "UTC",
        },
      };
      return {
        updateOne: {
          filter: { districtCode: item.districtCode, granuleId },
          update: { $setOnInsert: document },
          upsert: true,
        },
      };
    });

    const result = await GpmObservation.bulkWrite(operations, { ordered: true });
    newRecords += result.upsertedCount;
  }

  const records = await GpmObservation.find({
    dateLabel: localDate,
    districtCode: { $in: districtCodes },
  }).lean();
  const daily = aggregateBangladeshLocalDays(records);

  return {
    localDate,
    status: "processed",
    expectedGranules: 48,
    requestCount: requests,
    skippedExistingGranules: skippedGranules,
    upsertedObservations: newRecords,
    recordsByDistrict: Object.fromEntries(districtCodes.map(code => [code, records.filter(x => x.districtCode === code).length])),
    dailyAggregation: daily,
  };
}

async function main() {
  const dates = getDateList();
  const tokenHeader = getEarthdataAuthHeader();
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });

  const runId = `gpm-${dates[0]}-${dates[dates.length - 1]}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const baselineCount = await GpmObservation.countDocuments();
  console.log(`GPM expansion initiated: runId=${runId}, dateCount=${dates.length}, baselineCount=${baselineCount}`);

  try {
    await GpmObservation.init();
    const results = [];
    for (const localDate of dates) {
      console.log(`[GPM] Processing Bangladesh local civil day: ${localDate}...`);
      const summary = await processLocalDate(localDate, tokenHeader, runId);
      results.push(summary);
      console.log(JSON.stringify(summary));
    }
    const finalCount = await GpmObservation.countDocuments();
    console.log(JSON.stringify({
      runId,
      processedDates: dates.length,
      baselineCount,
      finalCount,
      netNewRecords: finalCount - baselineCount,
      baselinePreserved: finalCount >= baselineCount,
    }));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error(`GPM expansion stopped: ${error.message}`);
  process.exitCode = 1;
});
