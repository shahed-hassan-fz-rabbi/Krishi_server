/**
 * NASA SMAP (SPL3SMP_E V006) Client.
 * Queries NASA CMR for granule discovery and Harmony / NSIDC for spatial subsets.
 */

import { SMAP } from "../../config/smap.config.js";
import { DISTRICTS } from "../../config/climate.config.js";
import { getEarthdataBasicAuthHeader, isEarthdataConfigured } from "./earthdata.auth.js";

const DISTRICT_COORDS = {
  cumilla: { lat: 23.46186, lon: 91.18503 },
  chattogram: { lat: 22.3384, lon: 91.8317 },
};

/**
 * Searches NASA CMR for SPL3SMP_E granules matching a date range and bounding box.
 */
export async function searchSmapGranules({ startDate, endDate, limit = 50 }) {
  const temporal = `${startDate}T00:00:00Z,${endDate}T23:59:59Z`;
  // Bangladesh bounding box: 88.01, 20.59 to 92.68, 26.64
  const boundingBox = "91.0,22.0,92.5,24.0"; // Focused on Cumilla & Chattogram region

  const url = `${SMAP.cmrSearchUrl}?collection_concept_id=${SMAP.collectionConceptId}&bounding_box=${boundingBox}&temporal=${temporal}&page_size=${limit}&sort_key=-start_date`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "KrishiMama/1.0 (NASA Space Apps Challenge 2026)",
    },
  });

  if (!response.ok) {
    throw new Error(`CMR_SEARCH_FAILED: HTTP ${response.status} from ${url}`);
  }

  const json = await response.json();
  const entries = json?.feed?.entry || [];

  return entries.map((entry) => {
    const title = entry.title;
    // Extract date from granule title e.g., SMAP_L3_SM_P_E_20240101_R19240_001.h5
    const dateMatch = title.match(/_(\d{4})(\d{2})(\d{2})_/);
    const dateLabel = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;

    const dataLink = entry.links?.find(
      (l) => l.href && (l.href.endsWith(".h5") || l.rel?.endsWith("#data"))
    )?.href;

    return {
      granuleId: entry.id,
      title,
      dateLabel,
      dataUrl: dataLink || null,
      updated: entry.updated,
    };
  });
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
