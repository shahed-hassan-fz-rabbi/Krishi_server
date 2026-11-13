import { SMAP } from "../../config/smap.config.js";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isRecommendedSmapObservation(observation, districtCode) {
  if (!observation || observation.districtCode !== districtCode ||
      observation.datasetKey !== SMAP.datasetKey ||
      ![0, 8].includes(observation.retrievalQualityFlag) ||
      observation.isRecommendedQuality !== true ||
      observation.qualityClassification !== "recommended" ||
      typeof observation.dateLabel !== "string" || !ISO_DAY.test(observation.dateLabel)) return false;

  const date = new Date(`${observation.dateLabel}T00:00:00.000Z`);
  const value = observation.soilMoisture;
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === observation.dateLabel &&
    Number.isFinite(value) && value !== SMAP.fillValue && value >= SMAP.minValid && value <= SMAP.maxValid;
}

export function latestRecommendedSmapSnapshot(snapshot, districtCode) {
  return (Array.isArray(snapshot?.observations) ? snapshot.observations : [])
    .filter((observation) => isRecommendedSmapObservation(observation, districtCode))
    .sort((a, b) => b.dateLabel.localeCompare(a.dateLabel))[0] || null;
}

export async function findLatestRecommendedSmapObservation(Model, districtCode) {
  const candidates = await Model.find({
    districtCode,
    datasetKey: SMAP.datasetKey,
    retrievalQualityFlag: { $in: [0, 8] },
    isRecommendedQuality: true,
    qualityClassification: "recommended",
    dateLabel: { $type: "string", $regex: ISO_DAY },
    soilMoisture: { $type: "number", $gte: SMAP.minValid, $lte: SMAP.maxValid, $ne: SMAP.fillValue },
  }).sort({ dateLabel: -1 }).lean();
  return candidates.find((observation) => isRecommendedSmapObservation(observation, districtCode)) || null;
}
