/**
 * NASA AppEEARS API Client for MODIS MOD13Q1.061.
 *
 * Implements:
 * - Official Earthdata Basic Authentication login flow (POST /api/v1/login).
 * - Caches temporary 48-hour AppEEARS session token in memory.
 * - Never logs or exposes credentials.
 * - Strict verification against official product layer specifications.
 */

import dotenv from "dotenv";
dotenv.config();

import { MODIS } from "../../config/modis.config.js";

let cachedAppeearsToken = null;
let tokenExpiresAt = null;

/**
 * Checks whether Earthdata credentials required for AppEEARS are available locally.
 */
export function isAppeearsConfigured() {
  const username = process.env.EARTHDATA_USERNAME;
  const password = process.env.EARTHDATA_PASSWORD;
  return Boolean(username && username.trim() && password && password.trim());
}

/**
 * Logs in to NASA AppEEARS using Earthdata Basic Authentication.
 * NASA AppEEARS requires its own session token minted via POST /api/v1/login.
 */
export async function loginAppeears() {
  if (cachedAppeearsToken && tokenExpiresAt && Date.now() < tokenExpiresAt - 60000) {
    return cachedAppeearsToken;
  }

  const username = process.env.EARTHDATA_USERNAME;
  const password = process.env.EARTHDATA_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "APPEEARS_CREDENTIALS_MISSING: Earthdata username and password must be configured in server/.env (EARTHDATA_USERNAME, EARTHDATA_PASSWORD)."
    );
  }

  const credentials = Buffer.from(`${username.trim()}:${password.trim()}`).toString("base64");
  const loginUrl = `${MODIS.appeearsBaseUrl}/login`;

  const response = await fetch(loginUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      "User-Agent": "KrishiMama/1.0 (NASA Space Apps Challenge 2026)",
    },
  });

  if (!response.ok) {
    throw new Error(
      `APPEEARS_LOGIN_FAILED: HTTP ${response.status} from AppEEARS login endpoint.`
    );
  }

  const data = await response.json();
  if (!data.token) {
    throw new Error("APPEEARS_LOGIN_INVALID_RESPONSE: No token returned in response body.");
  }

  cachedAppeearsToken = data.token;
  tokenExpiresAt = data.expiration ? new Date(data.expiration).getTime() : Date.now() + 48 * 3600 * 1000;

  return cachedAppeearsToken;
}

/**
 * Queries official AppEEARS product/layer catalogue for MOD13Q1.061.
 * Does not require authentication.
 */
export async function getModisCatalogue() {
  const url = `${MODIS.appeearsBaseUrl}/product/MOD13Q1.061`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "KrishiMama/1.0 (NASA Space Apps Challenge 2026)",
    },
  });

  if (!response.ok) {
    throw new Error(`APPEEARS_CATALOGUE_FAILED: HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Submits a point-sampling task to AppEEARS for Cumilla and Chattogram coordinates.
 */
export async function submitAppeearsPointTask({
  taskName = "krishi_mama_modis_point_v1",
  startDate = "01-01-2024",
  endDate = "01-31-2024",
  coordinates = [
    { id: "cumilla", latitude: 23.46186, longitude: 91.18503, category: "district_ref" },
    { id: "chattogram", latitude: 22.3384, longitude: 91.8317, category: "district_ref" },
  ],
}) {
  const token = await loginAppeears();

  const payload = {
    task_type: "point",
    task_name: taskName,
    params: {
      dates: [
        {
          startDate,
          endDate,
        },
      ],
      layers: [
        { product: "MOD13Q1.061", layer: "_250m_16_days_NDVI" },
        { product: "MOD13Q1.061", layer: "_250m_16_days_EVI" },
        { product: "MOD13Q1.061", layer: "_250m_16_days_pixel_reliability" },
        { product: "MOD13Q1.061", layer: "_250m_16_days_composite_day_of_the_year" },
      ],
      coordinates,
    },
  };

  const response = await fetch(`${MODIS.appeearsBaseUrl}/task`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "KrishiMama/1.0 (NASA Space Apps Challenge 2026)",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`APPEEARS_TASK_SUBMISSION_FAILED: HTTP ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * Checks the status of an AppEEARS task.
 */
export async function getAppeearsTaskStatus(taskId) {
  const token = await loginAppeears();
  const response = await fetch(`${MODIS.appeearsBaseUrl}/task/${taskId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "KrishiMama/1.0 (NASA Space Apps Challenge 2026)",
    },
  });

  if (!response.ok) {
    throw new Error(`APPEEARS_STATUS_CHECK_FAILED: HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Retrieves the bundle file list for a completed task.
 */
export async function getAppeearsBundle(taskId) {
  const token = await loginAppeears();
  const response = await fetch(`${MODIS.appeearsBaseUrl}/bundle/${taskId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "KrishiMama/1.0 (NASA Space Apps Challenge 2026)",
    },
  });

  if (!response.ok) {
    throw new Error(`APPEEARS_BUNDLE_FETCH_FAILED: HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Downloads a specific file from a task bundle.
 */
export async function downloadAppeearsFile(taskId, fileId) {
  const token = await loginAppeears();
  const response = await fetch(`${MODIS.appeearsBaseUrl}/bundle/${taskId}/${fileId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "KrishiMama/1.0 (NASA Space Apps Challenge 2026)",
    },
  });

  if (!response.ok) {
    throw new Error(`APPEEARS_FILE_DOWNLOAD_FAILED: HTTP ${response.status} for fileId ${fileId}`);
  }

  return response.arrayBuffer();
}

/**
 * Validates raw MODIS observation values and decodes pixel reliability.
 */
export function validateModisObservation({ rawNdvi, rawEvi, pixelReliability, compositeDoy }) {
  const ndviCfg = MODIS.layers.ndvi;
  const eviCfg = MODIS.layers.evi;

  const isNdviFill = rawNdvi === null || rawNdvi === undefined || rawNdvi === ndviCfg.fillValue;
  const isEviFill = rawEvi === null || rawEvi === undefined || rawEvi === eviCfg.fillValue;

  // Handle both pre-scaled floating point values (from AppEEARS CSV e.g. 0.3434)
  // and raw unscaled integers (from native HDF5/OPeNDAP e.g. 3434).
  let scaledNdvi = null;
  if (!isNdviFill) {
    scaledNdvi =
      Math.abs(rawNdvi) > 1.0
        ? Number((rawNdvi * ndviCfg.scaleFactor).toFixed(4))
        : Number(Number(rawNdvi).toFixed(4));
  }

  let scaledEvi = null;
  if (!isEviFill) {
    scaledEvi =
      Math.abs(rawEvi) > 1.0
        ? Number((rawEvi * eviCfg.scaleFactor).toFixed(4))
        : Number(Number(rawEvi).toFixed(4));
  }

  const isNdviValid =
    scaledNdvi !== null && scaledNdvi >= ndviCfg.validMin && scaledNdvi <= ndviCfg.validMax;
  const isEviValid =
    scaledEvi !== null && scaledEvi >= eviCfg.validMin && scaledEvi <= eviCfg.validMax;

  let qualityClassification = "marginal_data";
  let isReliableQuality = false;

  if (pixelReliability === 0) {
    qualityClassification = "good_data";
    isReliableQuality = true;
  } else if (pixelReliability === 1) {
    qualityClassification = "marginal_data";
    isReliableQuality = false;
  } else if (pixelReliability === 2) {
    qualityClassification = "snow_ice";
    isReliableQuality = false;
  } else if (pixelReliability === 3) {
    qualityClassification = "cloudy";
    isReliableQuality = false;
  } else {
    qualityClassification = "fill";
    isReliableQuality = false;
  }

  return {
    valid: isNdviValid || isEviValid,
    ndvi: isNdviValid ? scaledNdvi : null,
    evi: isEviValid ? scaledEvi : null,
    pixelReliability,
    isReliableQuality,
    qualityClassification,
    compositeDoy: compositeDoy && compositeDoy > 0 ? compositeDoy : null,
  };
}

/**
 * Computes the 16-day composite coverage interval for a given MOD13Q1 composite start date.
 * MODIS 16-day composites start on `dateLabel` (Day 1) and extend through Day 16.
 */
export function computeModisCompositeWindow(dateLabel, compositeDays = 16) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateLabel || "")) {
    return null;
  }
  const startDate = new Date(`${dateLabel}T00:00:00.000Z`);
  if (Number.isNaN(startDate.getTime()) || startDate.toISOString().slice(0, 10) !== dateLabel) {
    return null;
  }
  const endDate = new Date(startDate.getTime() + (compositeDays - 1) * 86400000);
  const endDateLabel = endDate.toISOString().slice(0, 10);
  return {
    startDate,
    endDate,
    startDateLabel: dateLabel,
    endDateLabel,
    compositeDays,
  };
}

/**
 * Checks whether a MODIS 16-day composite coverage interval intersects the requested date range.
 * Interval overlap: compositeStart <= rangeEnd AND compositeEnd >= rangeStart.
 */
export function doesModisCompositeOverlap(dateLabel, range, compositeDays = 16) {
  const window = computeModisCompositeWindow(dateLabel, compositeDays);
  if (!window || !range?.start || !range?.end) return false;
  return window.startDateLabel <= range.end && window.endDateLabel >= range.start;
}

