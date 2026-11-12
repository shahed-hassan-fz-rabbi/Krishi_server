/**
 * NASA SMAP (SPL3SMP_E V006) Client.
 * Queries NASA CMR for granule discovery and Harmony / NSIDC for spatial subsets.
 */

import { SMAP } from "../../config/smap.config.js";
import { fetchWithRetry } from "./fetch-with-retry.js";

const DISTRICT_CMR_BOUNDS = {
  cumilla: { west: 90.7, south: 23.0, east: 91.7, north: 23.9 },
  chattogram: { west: 91.3, south: 21.8, east: 92.4, north: 22.9 },
};

export function deduplicateSmapGranules(granules = []) {
  const seen = new Set();
  return granules.filter((granule) => {
    const key = granule?.granuleId || granule?.dataUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Searches NASA CMR for SPL3SMP_E granules matching a date range and bounding box.
 */
export async function searchSmapGranules({ startDate, endDate, limit = 50, districtCode = "chattogram", fetchImpl = globalThis.fetch }) {
  const bounds = DISTRICT_CMR_BOUNDS[districtCode];
  if (!bounds) throw new Error(`SMAP CMR discovery does not support district '${districtCode}'`);
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    throw new Error("SMAP CMR discovery requires a valid ordered YYYY-MM-DD date range");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("SMAP CMR discovery limit must be between 1 and 50");
  }
  const temporal = `${startDate}T00:00:00Z,${endDate}T23:59:59Z`;
  const boundingBox = `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`;
  const url = new URL(SMAP.cmrSearchUrl);
  url.search = new URLSearchParams({
    collection_concept_id: SMAP.collectionConceptId,
    bounding_box: boundingBox,
    temporal,
    page_size: String(limit),
    sort_key: "-start_date",
  }).toString();

  const response = await fetchWithRetry(url.toString(), {
    headers: {
      "User-Agent": "KrishiMama/1.0 (NASA Space Apps Challenge 2026)",
    },
  }, { fetchImpl });

  if (!response.ok) {
    throw new Error(`CMR_SEARCH_FAILED: HTTP ${response.status} from ${url}`);
  }

  const json = await response.json();
  const entries = json?.feed?.entry || [];

  const granules = entries.map((entry) => {
    const title = typeof entry.title === "string" ? entry.title : "";
    // Extract date from granule title e.g., SMAP_L3_SM_P_E_20240101_R19240_001.h5
    const dateMatch = title.match(/_(\d{4})(\d{2})(\d{2})_/);
    const dateLabel = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;

    const dataLink = entry.links?.find((link) => {
      if (typeof link?.href !== "string") return false;
      try {
        const parsedUrl = new URL(link.href);
        return parsedUrl.protocol === "https:" &&
          (parsedUrl.pathname.toLowerCase().endsWith(".h5") || link.rel?.endsWith("#data"));
      } catch {
        return false;
      }
    })?.href;

    return {
      granuleId: entry.id,
      title,
      dateLabel,
      dataUrl: dataLink || null,
      updated: entry.updated,
    };
  }).filter((granule) => {
    if (!granule.dateLabel || !granule.dataUrl || granule.dateLabel < startDate || granule.dateLabel > endDate) return false;
    return validDate(granule.dateLabel);
  });

  return deduplicateSmapGranules(granules);
}

/**
 * Validates a volumetric soil moisture observation against scientific bounds
 * and decodes the 16-bit retrieval_qual_flag per NSIDC SPL3SMP_E V006.
 */
export function validateSoilMoistureValue(val, qualFlag = 0) {
  if (val === null || val === undefined || isNaN(val)) {
    return { valid: false, value: null, reason: "missing" };
  }
  if (val <= SMAP.fillValue || val < SMAP.minValid || val > SMAP.maxValid) {
    return { valid: false, value: null, reason: "out_of_bounds_or_fill" };
  }
  // Official NSIDC SPL3SMP_E V006 bitmask:
  // Bit 0 (LSB, mask 1): 0 = Recommended, 1 = Not recommended
  // Bit 1 (mask 2): 0 = Attempted, 1 = Not attempted
  // Bit 2 (mask 4): 0 = Successful, 1 = Not successful
  // Bit 3 (mask 8): 0 = Freeze/thaw success, 1 = Freeze/thaw unsuccessful
  const bit0NotRecommended = (qualFlag & 1) !== 0;
  const bit2NotSuccessful = (qualFlag & 4) !== 0;
  const isRecommended = !bit0NotRecommended && !bit2NotSuccessful;
  const qualityClassification = isRecommended ? "recommended" : "not_recommended";

  return {
    valid: true,
    value: Number(val.toFixed(4)),
    isRecommended,
    qualityClassification,
    qaBits: {
      bit0NotRecommended,
      bit1NotAttempted: (qualFlag & 2) !== 0,
      bit2NotSuccessful,
      bit3FreezeThawUnsuccessful: (qualFlag & 8) !== 0,
      rawFlag: qualFlag,
    },
  };
}
