/** Securely downloads one fixed CMR-listed GPM IMERG V07 pilot granule. */
import dotenv from "dotenv";
dotenv.config();

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GPM } from "../config/gpm.config.js";
import { getEarthdataAuthHeader } from "../services/nasa/earthdata.auth.js";

const GRANULE_ID = "3B-HHR.MS.MRG.3IMERG.20240101-S000000-E002959.0000.V07B.HDF5";
const DESTINATION = path.resolve("data/gpm/raw", GRANULE_ID);
const HDF5_SIGNATURE = Buffer.from("894844460d0a1a0a", "hex");

function isHdf5(buffer) {
  return buffer.length >= HDF5_SIGNATURE.length && buffer.subarray(0, 8).equals(HDF5_SIGNATURE);
}

async function main() {
  const authHeader = getEarthdataAuthHeader();
  const cmrUrl = new URL("https://cmr.earthdata.nasa.gov/search/granules.json");
  cmrUrl.search = new URLSearchParams({
    short_name: GPM.shortName,
    version: GPM.version,
    provider: "GES_DISC",
    temporal: "2024-01-01T00:00:00Z,2024-01-02T00:00:00Z",
    page_size: "10",
  });
  const cmrResponse = await fetch(cmrUrl);
  if (!cmrResponse.ok) throw new Error(`NASA CMR returned HTTP ${cmrResponse.status}`);
  const cmr = await cmrResponse.json();
  const granule = cmr.feed?.entry?.find(item => item.producer_granule_id === GRANULE_ID);
  const dataLink = granule?.links?.find(link => link.href?.includes(GRANULE_ID) && link.rel?.includes("data#"));
  if (!dataLink) throw new Error("The expected GPM pilot granule was not listed by NASA CMR");

  try {
    const existing = await fs.readFile(DESTINATION);
    if (!isHdf5(existing)) throw new Error("Existing pilot file failed its HDF5 signature check");
    console.log(JSON.stringify({ granuleId: GRANULE_ID, alreadyPresent: true, bytes: existing.length }));
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // NASA EDL authenticates at GES DISC and responds with a short-lived signed URL.
  // Do not forward the bearer token to the separate object-storage host.
  const authResponse = await fetch(dataLink.href, {
    headers: { Authorization: authHeader, Accept: "application/octet-stream" },
    redirect: "manual",
  });
  if (authResponse.status !== 303) {
    await authResponse.body?.cancel();
    throw new Error(`Expected GES DISC HTTP 303 signed redirect; received HTTP ${authResponse.status}`);
  }
  const signedLocation = authResponse.headers.get("location");
  await authResponse.body?.cancel();
  if (!signedLocation) throw new Error("GES DISC did not provide a signed data-host location");
  const signedUrl = new URL(signedLocation, dataLink.href);
  if (!signedUrl.hostname.endsWith("cloudfront.net")) {
    throw new Error("NASA returned an unexpected signed data host");
  }

  const fileResponse = await fetch(signedUrl, {
    headers: { Accept: "application/octet-stream" },
    redirect: "manual",
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

  await fs.mkdir(path.dirname(DESTINATION), { recursive: true });
  await fs.writeFile(DESTINATION, bytes, { flag: "wx" });
  console.log(JSON.stringify({
    granuleId: GRANULE_ID,
    authenticationRedirectStatus: authResponse.status,
    finalDataHost: signedUrl.hostname,
    finalDataStatus: fileResponse.status,
    bytes: bytes.length,
    hdf5SignatureValid: true,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    destination: "data/gpm/raw/<granule>.HDF5",
  }));
}

main().catch(error => {
  // Error messages are deliberately restricted to statuses and static diagnostics.
  console.error(`GPM pilot download failed: ${error.message}`);
  process.exitCode = 1;
});
