/**
 * NASA Earthdata & AppEEARS Authentication Service.
 *
 * Security & Integrity Rules:
 * - Credentials can be provided via:
 *     1. EARTHDATA_TOKEN (Personal Access / Bearer token in server/.env)
 *     2. EARTHDATA_USERNAME & EARTHDATA_PASSWORD (in server/.env)
 *     3. ~/.netrc or ~/_netrc (Standard Earthdata credentials file)
 * - Never log passwords, tokens, or authorization headers.
 * - Caches active session tokens in memory until expiration.
 * - Distinguishes unconfigured vs unauthorized vs successful states.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cachedAppeearsToken = null;
let tokenExpiresAt = null;

const APPEEARS_LOGIN_URL = "https://appeears.earthdatacloud.nasa.gov/api/v1/login";
const HARMONY_BASE_URL = "https://harmony.earthdata.nasa.gov";

/**
 * Searches for credentials in ~/.netrc or ~/_netrc.
 */
function readNetrcCredentials() {
  const home = os.homedir();
  const candidates = [path.join(home, ".netrc"), path.join(home, "_netrc")];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split(/\r?\n/);
        let inUrs = false;
        let login = null;
        let password = null;

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("machine")) {
            inUrs = trimmed.includes("urs.earthdata.nasa.gov");
          } else if (inUrs) {
            const parts = trimmed.split(/\s+/);
            for (let i = 0; i < parts.length; i++) {
              if (parts[i] === "login" && parts[i + 1]) login = parts[i + 1];
              if (parts[i] === "password" && parts[i + 1]) password = parts[i + 1];
            }
          }
        }

        if (login && password) {
          return { username: login, password, source: "netrc" };
        }
      } catch {
        // Ignore read errors
      }
    }
  }
  return null;
}

/**
 * Resolves available credentials from environment or netrc.
 */
export function getEarthdataCredentials() {
  const envToken = (process.env.EARTHDATA_TOKEN || "").trim();
  if (envToken) {
    return { token: envToken, username: "token_user", source: "env_token" };
  }

  const envUser = (process.env.EARTHDATA_USERNAME || "").trim();
  const envPass = (process.env.EARTHDATA_PASSWORD || "").trim();
  if (envUser && envPass) {
    return { username: envUser, password: envPass, source: "env_credentials" };
  }

  const netrc = readNetrcCredentials();
  if (netrc) {
    return netrc;
  }

  return null;
}

/**
 * Checks if Earthdata credentials are configured.
 */
export function isEarthdataConfigured() {
  return Boolean(getEarthdataCredentials());
}

/**
 * Returns the configured username or null.
 */
export function getEarthdataUsername() {
  const creds = getEarthdataCredentials();
  return creds ? creds.username : null;
}

/**
 * Generates an HTTP Authorization header suitable for Harmony or AppEEARS.
 */
export function getEarthdataAuthHeader() {
  const creds = getEarthdataCredentials();
  if (!creds) {
    throw new Error(
      "EARTHDATA_CREDENTIALS_MISSING: Earthdata credentials must be configured via EARTHDATA_TOKEN, EARTHDATA_USERNAME/PASSWORD in server/.env, or ~/.netrc."
    );
  }

  if (creds.token) {
    return `Bearer ${creds.token}`;
  }

  const base64 = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  return `Basic ${base64}`;
}

export const getEarthdataBasicAuthHeader = getEarthdataAuthHeader;

export async function verifyEarthdataAuth() {
  return verifyHarmonyAuth();
}

/**
 * Verifies authentication directly against NASA Harmony API.
 */
export async function verifyHarmonyAuth() {
  const creds = getEarthdataCredentials();
  if (!creds) {
    return {
      configured: false,
      authenticated: false,
      service: "NASA Harmony",
      message: "No credentials configured in server/.env or .netrc.",
    };
  }

  try {
    const header = getEarthdataAuthHeader();
    // Request Harmony collection endpoint with redirect: manual to detect 303 vs 200 vs 401
    const testUrl = `${HARMONY_BASE_URL}/C2938664763-NSIDC_CPRD/ogc-api-coverages/1.0.0/collections`;

    const res = await fetch(testUrl, {
      method: "GET",
      headers: {
        Authorization: header,
        "User-Agent": "KrishiMama/1.0 (NASA Space Apps Challenge 2026)",
      },
      redirect: "manual",
    });

    if (res.status === 200) {
      return {
        configured: true,
        authenticated: true,
        service: "NASA Harmony",
        username: creds.username,
        source: creds.source,
        message: "NASA Harmony authenticated successfully.",
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        configured: true,
        authenticated: false,
        service: "NASA Harmony",
        username: creds.username,
        message: `Authentication failed (HTTP ${res.status}). Verify your token or Earthdata credentials.`,
      };
    }

    if (res.status === 303 || res.status === 302) {
      // Basic auth requires following redirect to urs.earthdata.nasa.gov
      // Follow the redirect with the same credentials
      const redirectUrl = res.headers.get("location");
      if (redirectUrl && creds.username && creds.password) {
        const followRes = await fetch(redirectUrl, {
          method: "GET",
          headers: {
            Authorization: getEarthdataAuthHeader(),
            "User-Agent": "KrishiMama/1.0 (NASA Space Apps Challenge 2026)",
          },
        });
        if (followRes.ok) {
          return {
            configured: true,
            authenticated: true,
            service: "NASA Harmony",
            username: creds.username,
            source: creds.source,
            message: "NASA Harmony OAuth grant succeeded.",
          };
        }
      }
      return {
        configured: true,
        authenticated: false,
        service: "NASA Harmony",
        username: creds.username,
        message: `Redirect returned status ${res.status}. Recommended: Use EARTHDATA_TOKEN for direct Bearer auth.`,
      };
    }

    return {
      configured: true,
      authenticated: false,
      service: "NASA Harmony",
      username: creds.username,
      message: `Unexpected HTTP status ${res.status} from Harmony.`,
    };
  } catch (err) {
    return {
      configured: true,
      authenticated: false,
      service: "NASA Harmony",
      message: `Connection error: ${err.message}`,
    };
  }
}
