/** Conservative historical-month checks, not daily weather or field suitability predictions. */
function weeksInRange(range) {
  if (!Array.isArray(range) || range.length !== 2 || !range.every((v) => Number.isInteger(v) && v >= 1 && v <= 52)) return [];
  const weeks = [];
  for (let week = range[0]; ; week = week === 52 ? 1 : week + 1) {
    weeks.push(week);
    if (week === range[1]) return weeks;
  }
}
export function calendarMonths(range) {
  const months = new Set();
  for (const week of weeksInRange(range)) {
    // Standard-week envelopes approximate the calendar; include both ends of a week.
    for (const offset of [0, 6]) months.add(new Date(Date.UTC(2001, 0, 1 + (week - 1) * 7 + offset)).getUTCMonth() + 1);
  }
  return [...months];
}
function observedMean(row, type) {
  const value = row?.stats?.mean;
  if (!Number.isFinite(value) || !(row?.years_used > 0) || !(row?.stats?.count > 0)) return null;
  if (type === "temperature" && (value < -50 || value > 60)) return null;
  if (type === "rainfall" && value < 0) return null;
  return value;
}
export function describeAreaClimate(snapshot) {
  const temperature = [];
  const rainfall = [];
  for (let month = 1; month <= 12; month++) {
    const t = observedMean(snapshot?.data?.temperature?.monthly_historical?.[month], "temperature");
    const r = observedMean(snapshot?.data?.rainfall?.monthly_historical?.[month], "rainfall");
    if (t !== null) temperature.push({ month, value: t });
    if (r !== null) rainfall.push({ month, value: r });
  }
  const top = (rows) => rows.reduce((best, row) => !best || row.value > best.value ? row : best, null);
  return { temperature, rainfall, warmest: top(temperature), wettest: top(rainfall),
    period: snapshot?.snapshotMetadata?.sourceObservationDateRange || null,
    generatedAt: snapshot?.snapshotMetadata?.generatedAt || null,
    provenance: snapshot ? "SNAPSHOT" : "UNAVAILABLE" };
}
export function checkCropClimate(localCalendar, snapshot) {
  const checks = [];
  let missingTemperatureChecks = 0;
  for (const stage of localCalendar.stages || []) {
    const range = stage.optimalTempRange;
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1]) continue;
    for (const month of calendarMonths(stage.standardWeeks)) {
      const value = observedMean(snapshot?.data?.temperature?.monthly_historical?.[month], "temperature");
      if (value === null) { missingTemperatureChecks++; continue; }
      checks.push({ month, stageId: stage.stageId, stageNameEn: stage.stageNameEn, stageNameBn: stage.stageNameBn,
        meanTemperatureC: value, preferredMinC: range[0], preferredMaxC: range[1],
        outsidePreferredRange: value < range[0] || value > range[1] });
    }
  }
  const rainfall = calendarMonths(localCalendar.standardWeeksRange).map((month) => ({ month,
    meanMm: observedMean(snapshot?.data?.rainfall?.monthly_historical?.[month], "rainfall") }));
  return { checks, outsideTemperatureChecks: checks.filter((row) => row.outsidePreferredRange).length,
    missingTemperatureChecks, rainfall };
}
