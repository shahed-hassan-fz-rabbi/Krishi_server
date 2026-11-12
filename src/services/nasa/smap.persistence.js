import { SmapObservation } from "../../models/smapobservation.model.js";

const SUPPORTED_DISTRICTS = new Set(["cumilla", "chattogram"]);
const DISTRICT_BOUNDS = {
  cumilla: { minLat: 23.0, maxLat: 23.9, minLon: 90.7, maxLon: 91.7 },
  chattogram: { minLat: 21.8, maxLat: 22.9, minLon: 91.3, maxLon: 92.4 },
};

function assertValidatedObservation(doc) {
  const bounds = DISTRICT_BOUNDS[doc?.districtCode];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(doc?.dateLabel || "") ? new Date(`${doc.dateLabel}T00:00:00.000Z`) : null;
  if (!SUPPORTED_DISTRICTS.has(doc?.districtCode) || !date || Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== doc.dateLabel || !["AM", "PM"].includes(doc?.orbit)) {
    throw new Error("Refusing to persist SMAP observation with invalid district, date, or orbit");
  }
  if (![0, 8].includes(doc.retrievalQualityFlag) || doc.isRecommendedQuality !== true || doc.qualityClassification !== "recommended") {
    throw new Error("Refusing to persist SMAP observation that fails the recommended-quality gate");
  }
  if (!Number.isFinite(doc.soilMoisture) || doc.soilMoisture < 0 || doc.soilMoisture > 1 ||
      !Number.isFinite(doc.latitude) || !Number.isFinite(doc.longitude) ||
      doc.latitude < bounds.minLat || doc.latitude > bounds.maxLat ||
      doc.longitude < bounds.minLon || doc.longitude > bounds.maxLon) {
    throw new Error("Refusing to persist SMAP observation with missing or invalid measurement/geolocation");
  }
}

/** Idempotently persist only validated observations through the existing unique key. */
export async function persistValidatedSmapObservations(observations, { model = SmapObservation } = {}) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new Error("At least one validated SMAP observation is required");
  }
  observations.forEach(assertValidatedObservation);
  await model.init();
  const baselineCount = await model.countDocuments();
  let inserted = 0;
  const unique = new Map(observations.map((doc) => [`${doc.districtCode}:${doc.dateLabel}:${doc.orbit}`, doc]));
  for (const doc of unique.values()) {
    const result = await model.updateOne(
      { districtCode: doc.districtCode, dateLabel: doc.dateLabel, orbit: doc.orbit },
      { $setOnInsert: doc },
      { upsert: true },
    );
    inserted += result.upsertedCount || 0;
  }
  const finalCount = await model.countDocuments();
  return { baselineCount, finalCount, inserted, baselinePreserved: finalCount >= baselineCount };
}
