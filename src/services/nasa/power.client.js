/**
 * NASA POWER daily point HTTP client (Phase 3).
 *
 * Behavior:
 * - Builds the request via the pure validator (buildPowerUrl) and validates the
 *   envelope with validatePowerResponse before anything is stored.
 * - Sequential + timeout + bounded retry/backoff for 429/5xx/network.
 * - Cache-first discipline lives in the ingest job: stored spans must never be
 *   re-requested from NASA (the API warns against repeated same-location calls).
 * - No API key is needed for POWER; no secrets are involved here.
 */
import https from "node:https";
import dns from "node:dns/promises";
import dnsSync from "node:dns";
import { POWER } from "../../config/climate.config.js";
import { buildPowerUrl, validatePowerResponse } from "../../validators/power.validator.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let customResolver = null;

function getCustomLookup() {
  if (!customResolver) {
    customResolver = new dns.Resolver();
    customResolver.setServers(["8.8.8.8", "1.1.1.1"]);
  }
  return (hostname, opts, cb) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "object" ? opts : {};

    dnsSync.lookup(hostname, options, (err, addr, family) => {
      if (!err && addr) {
        return callback(null, addr, family);
      }
      customResolver
        .resolve4(hostname)
        .catch(async () => {
          const cname = await customResolver.resolveCname(hostname).catch(() => null);
          if (cname && cname[0]) return customResolver.resolve4(cname[0]);
          throw new Error(`Could not resolve ${hostname}`);
        })
        .then((ips) => {
          if (options.all) {
            callback(null, ips.map((ip) => ({ address: ip, family: 4 })));
          } else {
            callback(null, ips[0], 4);
          }
        })
        .catch((fallbackErr) => callback(fallbackErr));
    });
  };
}

const httpsAgent = new https.Agent({ lookup: getCustomLookup(), keepAlive: true });

function httpGetJson(urlString, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.get(
      url,
      {
        agent: httpsAgent,
        headers: { Accept: "application/json" },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            resolve({
              status: res.statusCode,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              json,
            });
          } catch (parseErr) {
            resolve({
              status: res.statusCode,
              ok: false,
              json: null,
              error: `Invalid JSON returned: ${parseErr.message}`,
            });
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Fetches one validated chunk of POWER daily point data.
 * @returns {Promise<{ ok: true, attempts: number, data: object } | { ok: false, httpStatus: number|null, attempts: number, error: string }>}
 */
export async function fetchPowerChunk({ latitude, longitude, parameters, startIso, endIso }) {
  const { errors, url } = buildPowerUrl({ latitude, longitude, parameters, startIso, endIso });
  if (errors.length > 0) {
    return { ok: false, httpStatus: null, attempts: 0, error: `request validation failed: ${errors.join("; ")}` };
  }

  let lastError = "";
  let attempts = 0;
  for (let attempt = 1; attempt <= POWER.maxRetriesPerChunk; attempt += 1) {
    attempts = attempt;
    try {
      const response = await httpGetJson(url, POWER.requestTimeoutMs);

      if (response.status === 429 || response.status >= 500) {
        lastError = `HTTP ${response.status} (server-side/temporary)`;
        await sleep(POWER.retryBaseDelayMs * attempt);
        continue;
      }
      if (!response.ok) {
        return {
          ok: false,
          httpStatus: response.status,
          attempts,
          error: response.error || `POWER returned HTTP ${response.status} for ${startIso}..${endIso}`,
        };
      }
      const raw = response.json;
      const { errors: validationErrors, data } = validatePowerResponse(raw, {
        latitude,
        longitude,
        parameters,
        startIso,
        endIso,
      });
      if (validationErrors.length > 0) {
        return {
          ok: false,
          httpStatus: response.status,
          attempts,
          error: `response validation failed: ${validationErrors.join("; ")}`,
        };
      }
      return { ok: true, attempts, data };
    } catch (error) {
      lastError = error.message;
      await sleep(POWER.retryBaseDelayMs * attempt);
    }
  }
  return {
    ok: false,
    httpStatus: null,
    attempts,
    error: `exhausted ${POWER.maxRetriesPerChunk} retries — last error: ${lastError}`,
  };
}

/** Returns the echoed coordinates (POWER rounds to 3 dp) for provenance recording. */
export function getGeometryEcho(validated) {
  return validated?.geometryEchoed ?? null;
}
