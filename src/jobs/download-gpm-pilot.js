/**
 * Securely downloads a bounded set of CMR-listed GPM IMERG Final V07B granules.
 *
 * Default behavior is unchanged: with no arguments, exactly the original pilot
 * granule is downloaded. An optional `--granules=<id>,<id>,...` argument selects
 * a small representative set (hard limit 8 granules per run).
 *
 * Safety boundaries (unchanged):
 * - No MongoDB connection or writes anywhere in this job.
 * - Existing raw files are never overwritten: presence is verified by HDF5
 *   signature and new files are written with exclusive-create (`wx`).
 * - Earthdata credentials are used only for the GES DISC 303 redirect; the
 *   bearer token is never forwarded to the signed object-storage host.
 * - Error messages are restricted to statuses and static diagnostics.
 */
import dotenv from "dotenv";
dotenv.config();

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GPM } from "../config/gpm.config.js";
import { getEarthdataAuthHeader } from "../services/nasa/earthdata.auth.js";

const HDF5_SIGNATURE = Buffer.from("894844460d0a1a0a", "hex");
// Bounded request timeouts and limits (Phase 5 reliability).
const TIMEOUT_MS = { cmr: 15000, auth: 30000, data: 120000 };
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 2000;
const MAX_GRANULES_PER_RUN = 8;
const GRANULE_ID_RE = /^3B-HHR\.MS\.MRG\.3IMERG\.(\d{8})-S\d{6}-E\d{6}\.\d{4}\.V07B\.HDF5$/;

function isHdf5(buffer) {
  return buffer.length >= HDF5_SIGNATURE.length && buffer.subarray(0, 8).equals(HDF5_SIGNATURE);
}

function parseRequestedGranuleIds() {
  const raw = process.argv.find((arg) => arg.startsWith("--granules="))?.slice(11) ?? "";
  const ids = raw.split(",").map((id) => id.trim()).filter(Boolean).slice(0, MAX_GRANULES_PER_RUN);
  if (raw && ids.length === 0) throw new Error("No valid granule IDs were provided after --granules=");
  return ids.length > 0 ? ids : ["3B-HHR.MS.MRG.3IMERG.20240101-S000000-E002959.0000.V07B.HDF5"];
}

function granuleUtcDate(id) {
  return `${id.match(GRANULE_ID_RE)[1].slice(0, 4)}-${id.match(GRANULE_ID_RE)[1].slice(4, 6)}-${id.match(GRANULE_ID_RE)[1].slice(6, 8)}`;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One bounded granule download attempt through the GES DISC 303 signed-URL flow. */
async function downloadOnce(dataUrl, authHeader) {
  const authResponse = await fetch(dataUrl, {
    headers: { Authorization: authHeader, Accept: "application/octet-stream" },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS.auth),
  });
  if (authResponse.status !== 303) {
    await authResponse.body?.cancel();
    throw new Error(`Expected GES DISC HTTP 303 signed redirect; received HTTP ${authResponse.status}`);
  }
  const signedLocation = authResponse.headers.get("location");
  await authResponse.body?.cancel();
  if (!signedLocation) throw new Error("GES DISC did not provide a signed data-host location");
  const signedUrl = new URL(signedLocation, dataUrl);
  if (!signedUrl.hostname.endsWith("cloudfront.net")) {
    throw new Error("NASA returned an unexpected signed data host");
  }

  const fileResponse = await fetch(signedUrl, {
    headers: { Accept: "application/octet-stream" },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS.data),
  });
  if (fileResponse.status !== 200) {
    await fileResponse.body?.cancel();
    throw new Error(`Signed NASA data host returned HTTP ${fileResponse.status}`);
  }
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  const advertisedLength = Number(fileResponse.headers.get("content-length"));
  if ((advertisedLength && advertisedLength !== bytes.length) || !isHdf5(bytes)) {
    throw new Error("Downloaded payload failed Content-Length or HDF5 signature validation");
  }
  return { bytes, finalDataHost: signedUrl.hostname, finalDataStatus: fileResponse.status };
}

async function downloadGranule(dataUrl, authHeader) {
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await downloadOnce(dataUrl, authHeader);
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) await sleep(DOWNLOAD_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

async function main() {
  const granuleIds = parseRequestedGranuleIds();
  for (const id of granuleIds) {
    if (!GRANULE_ID_RE.test(id)) throw new Error(`Granule ID is not the expected GPM IMERG Final V07B product: ${id}`);
  }
  const authHeader = getEarthdataAuthHeader();

  const dates = granuleIds.map((id) => granuleUtcDate(id)).sort();
  const temporal = `${dates[0]}T00:00:00Z,${dates[dates.length - 1]}T23:59:59Z`;
  const cmrUrl = new URL("https://cmr.earthdata.nasa.gov/search/granules.json");
  cmrUrl.search = new URLSearchParams({
    short_name: GPM.shortName,
    version: GPM.version,
    provider: "GES_DISC",
    temporal,
    page_size: "50",
  });
  const cmrResponse = await fetch(cmrUrl, { signal: AbortSignal.timeout(TIMEOUT_MS.cmr) });
  if (!cmrResponse.ok) throw new Error(`NASA CMR returned HTTP ${cmrResponse.status}`);
  const cmr = await cmrResponse.json();

  const results = [];
  for (const granuleId of granuleIds) {
    const destination = path.resolve("data/gpm/raw", granuleId);
    const entry = cmr.feed?.entry?.find((item) => item.producer_granule_id === granuleId);
    const dataLink = entry?.links?.find((link) => link.href?.includes(granuleId) && link.rel?.includes("data#"));
    if (!dataLink) {
      results.push({ granuleId, status: "not_listed_by_cmr" });
      continue;
    }

    try {
      const existing = await fs.readFile(destination);
      if (!isHdf5(existing)) throw new Error("Existing file failed its HDF5 signature check");
      results.push({ granuleId, status: "already_present", bytes: existing.length });
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") {
        results.push({ granuleId, status: "existing_file_invalid", error: error.message });
        continue;
      }
    }

    try {
      const { bytes, finalDataHost, finalDataStatus } = await downloadGranule(dataLink.href, authHeader);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: "wx" });
      results.push({
        granuleId,
        status: "downloaded",
        authenticationRedirectStatus: 303,
        finalDataHost,
        finalDataStatus,
        bytes: bytes.length,
        hdf5SignatureValid: true,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      results.push({ granuleId, status: "download_failed", attempts: DOWNLOAD_ATTEMPTS, error: error.message });
    }
  }

  console.log(JSON.stringify({
    temporal,
    requested: granuleIds.length,
    results,
    destination: "data/gpm/raw/<granule>.HDF5",
  }, null, 2));
}

main().catch((error) => {
  // Error messages are deliberately restricted to statuses and static diagnostics.
  console.error(`GPM granule download failed: ${error.message}`);
  process.exitCode = 1;
});
