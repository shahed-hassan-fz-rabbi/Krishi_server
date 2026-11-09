import { GPM } from "../../config/gpm.config.js";

const BD_OFFSET_MS = 6 * 60 * 60 * 1000;
const HALF_HOUR_MS = GPM.temporalResolutionMinutes * 60 * 1000;

export function validateGpmObservation(observation) {
  const start = new Date(observation.intervalStartUtc);
  const end = new Date(observation.intervalEndUtc);
  const rate = observation.precipitationRateMmHr;
  const valid = Number.isFinite(rate) && rate >= 0;
  const expectedLocalDay = new Date(start.getTime() + BD_OFFSET_MS).toISOString().slice(0, 10);

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return { valid: false, reason: "invalid_timestamp" };
  }
  if (end.getTime() - start.getTime() !== HALF_HOUR_MS) {
    return { valid: false, reason: "invalid_interval_duration" };
  }
  if (observation.dateLabel !== expectedLocalDay) {
    return { valid: false, reason: "invalid_bangladesh_local_day" };
  }
  if (valid && Math.abs(observation.precipitationMm - rate * 0.5) > 1e-8) {
    return { valid: false, reason: "invalid_rate_to_interval_amount_conversion" };
  }
  if (!valid && observation.precipitationMm !== null) {
    return { valid: false, reason: "fill_value_must_not_become_amount" };
  }
  if (observation.precipitationQualityIndex !== null &&
      (observation.precipitationQualityIndex < 0 || observation.precipitationQualityIndex > 1)) {
    return { valid: false, reason: "quality_index_out_of_range" };
  }
  if (observation.probabilityLiquidPrecipitationPercent !== null &&
      (observation.probabilityLiquidPrecipitationPercent < 0 || observation.probabilityLiquidPrecipitationPercent > 100)) {
    return { valid: false, reason: "liquid_probability_out_of_range" };
  }
  return { valid: true, expectedLocalDay, sourceQuality: valid ? "valid" : "missing_fill" };
}

/** Publish a daily total only with all 48 unique, valid half-hour intervals. */
export function aggregateBangladeshLocalDays(observations) {
  const groups = new Map();
  for (const item of observations) {
    const start = new Date(item.intervalStartUtc);
    const localDay = new Date(start.getTime() + BD_OFFSET_MS).toISOString().slice(0, 10);
    const key = `${item.districtCode}:${localDay}`;
    if (!groups.has(key)) groups.set(key, { districtCode: item.districtCode, dateLabel: localDay, byStart: new Map() });
    groups.get(key).byStart.set(start.getTime(), item);
  }
  return [...groups.values()].map(({ districtCode, dateLabel, byStart }) => {
    const items = [...byStart.values()];
    const valid = items.filter(x => Number.isFinite(x.precipitationMm) && x.sourceQuality === "valid");
    const expectedStartUtc = Date.parse(`${dateLabel}T00:00:00+06:00`);
    const sortedStarts = [...byStart.keys()].sort((a, b) => a - b);
    const complete = items.length === 48 && valid.length === 48 &&
      sortedStarts.every((start, index) => start === expectedStartUtc + index * HALF_HOUR_MS);
    return {
      districtCode,
      dateLabel,
      expectedIntervals: 48,
      observedIntervals: items.length,
      validIntervals: valid.length,
      totalPrecipitationMm: complete ? Number(valid.reduce((sum, x) => sum + x.precipitationMm, 0).toFixed(4)) : null,
      completeness: complete ? "complete" : "incomplete",
    };
  });
}

/** Summarize one requested local day; missing/partial coverage has no total. */
export function summarizeGpmLocalDay(districtCode, dateLabel, observations = []) {
  const summary = aggregateBangladeshLocalDays(observations).find(
    (day) => day.districtCode === districtCode && day.dateLabel === dateLabel
  );
  return summary || {
    districtCode,
    dateLabel,
    expectedIntervals: 48,
    observedIntervals: 0,
    validIntervals: 0,
    totalPrecipitationMm: null,
    completeness: "incomplete",
  };
}
