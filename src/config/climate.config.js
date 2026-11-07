/**
 * Phase 3 climate configuration — single source of truth for NASA POWER
 * ingestion boundaries, district coordinates, and parameter metadata.
 *
 * Binding rules encoded here:
 * - Both districts use the EXACT project-configured coordinates. Never substitute centroids.
 * - Parameters and units were verified against live POWER API responses (v2.10.3):
 *     PRECTOTCORR mm/day · T2M / T2M_MAX / T2M_MIN °C · RH2M % · ALLSKY_SFC_SW_DWN MJ/m^2/day
 * - Missing-value convention verified live: header.fill_value = -999 for daily point.
 *   Sentinel values are NEVER converted to 0 — they become quality flags.
 * - Time standard is Local Solar Time (LST). LST is NOT Bangladesh Standard Time (UTC+6);
 *   the API itself echoes `time_standard: "LST"` in every response header and every
 *   stored record / API response repeats this disclosure.
 * - No API key is required for POWER; no tokens are configured in this file.
 */

export const POWER = {
  datasetKey: "nasa:power:daily:point",
  productName: "NASA POWER Source Native Resolution Daily Data (Point)",
  endpoint: "https://power.larc.nasa.gov/api/temporal/daily/point",
  community: "AG",
  format: "JSON",
  timeStandard: "LST",
  timeStandardDisclosure:
    "NASA POWER Local Solar Time (LST). LST is the local solar-day boundary — " +
    "it is NOT Bangladesh Standard Time (BST, UTC+6) and for Bangladesh longitude " +
    "differs from civil UTC+6 midnight by a small offset. All dates in this dataset " +
    "follow the API's LST convention consistently.",
  fillValue: -999,
  requestTimeoutMs: 120000,
  maxRetriesPerChunk: 4,
  retryBaseDelayMs: 5000,
  // POWER warns that rapid repeated same-location requests can be throttled:
  // sequential chunked fetching with delays is mandatory (see ingest job).
  interChunkDelayMs: 2000,
};

/** Target historical window (subject to verified actual availability — never silently extended). */
export const TARGET_RANGE = {
  start: "2001-01-01",
  end: "2025-12-31",
};

/**
 * Supported districts with the exact configured coordinates from the project
 * specification. These are the ONLY ingestable points. `chattogram` is the
 * default dashboard location.
 */
export const DISTRICTS = [
  {
    code: "chattogram",
    nameEn: "Chattogram",
    nameBn: "চট্টগ্রাম",
    latitude: 22.3384,
    longitude: 91.8317,
    isDefault: true,
    enabled: true,
  },
  {
    code: "cumilla",
    nameEn: "Cumilla",
    nameBn: "কুমিল্লা",
    latitude: 23.46186,
    longitude: 91.18503,
    isDefault: false,
    enabled: true,
  },
];

/** The six approved Phase 3 parameters with live-verified units and long names. */
export const PARAMETER_CATALOG = {
  PRECTOTCORR: { unit: "mm/day", longName: "Precipitation Corrected", group: "precipitation" },
  T2M: { unit: "C", longName: "Temperature at 2 Meters", group: "temperature" },
  T2M_MAX: { unit: "C", longName: "Temperature at 2 Meters Maximum", group: "temperature" },
  T2M_MIN: { unit: "C", longName: "Temperature at 2 Meters Minimum", group: "temperature" },
  RH2M: { unit: "%", longName: "Relative Humidity at 2 Meters", group: "humidity" },
  ALLSKY_SFC_SW_DWN: {
    unit: "MJ/m^2/day",
    longName: "All Sky Surface Shortwave Downward Irradiance",
    group: "solar",
  },
};

export const PARAMETER_NAMES = Object.keys(PARAMETER_CATALOG);

/** Quality flags for observations (exhaustive; missing is never stored as 0). */
export const QUALITY_FLAG = {
  ok: "ok",
  missingSentinel: "missing_sentinel", // value === fill_value (-999); raw sentinel kept
  absent: "absent", // date key entirely absent from the returned series
};
