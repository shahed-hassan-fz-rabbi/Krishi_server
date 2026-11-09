/** Resumable, insert-only GPM expansion for exactly one Bangladesh local day. */
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

function getDateArg() {
  const value = process.argv.find(arg => arg.startsWith("--date="))?.slice("--date=".length);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error("Pass exactly one Bangladesh local date as --date=YYYY-MM-DD");
  }
  return value;
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

async function main() {
  const localDate = getDateArg();
  const tokenHeader = getEarthdataAuthHeader();
  const granules = await searchGranules(localDate);
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
  const runId = `gpm-${localDate}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  let requests = 0;
  let newRecords = 0;
  let skippedGranules = 0;
  try {
    await GpmObservation.init();
    for (const granule of granules) {
      const granuleId = granule.producer_granule_id;
      const existingCount = await GpmObservation.countDocuments({ granuleId, districtCode: { $in: Object.keys(GPM.districtGridTargets) } });
      if (existingCount === 2) {
        skippedGranules += 1;
        continue;
      }

      if (requests > 0) await delay(1500);
      const sourceUrl = buildGpmOpendapUrl(granule);
      const response = await fetch(sourceUrl, {
        headers: { Authorization: tokenHeader, Accept: "text/plain" },
        signal: AbortSignal.timeout(30000),
      });
      requests += 1;
      if (response.status === 401) throw new Error("NASA GES DISC authentication failed (HTTP 401)");
      if (response.status === 403) throw new Error("NASA GES DISC authorization failed (HTTP 403)");
      if (response.status === 429) throw new Error("NASA GES DISC rate limit reached (HTTP 429); stop and resume later");
      if (!response.ok) throw new Error(`NASA OPeNDAP returned HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text) > 20000) throw new Error(`Unexpectedly large OPeNDAP response for ${granuleId}`);

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
      if (requests % 8 === 0) {
        console.log(JSON.stringify({ localDate, requests, newRecords, skippedGranules, checkpointGranule: granuleId }));
      }
    }

    const records = await GpmObservation.find({ dateLabel: localDate, districtCode: { $in: Object.keys(GPM.districtGridTargets) } }).lean();
    const daily = aggregateBangladeshLocalDays(records);
    console.log(JSON.stringify({
      runId,
      localDate,
      expectedGranules: 48,
      requestCount: requests,
      skippedExistingGranules: skippedGranules,
      upsertedObservations: newRecords,
      recordsByDistrict: Object.fromEntries(Object.keys(GPM.districtGridTargets).map(code => [code, records.filter(x => x.districtCode === code).length])),
      dailyAggregation: daily,
    }));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error(`GPM daily expansion stopped: ${error.message}`);
  process.exitCode = 1;
});
