import { MODIS } from "../../config/modis.config.js";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateLabel(value) {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const MODIS_GOOD_OBSERVATION_OR = [
  { ndvi: { $type: "number", $gte: MODIS.layers.ndvi.validMin, $lte: MODIS.layers.ndvi.validMax } },
  { evi: { $type: "number", $gte: MODIS.layers.evi.validMin, $lte: MODIS.layers.evi.validMax } },
];

export function goodModisObservationFilter(districtCode) {
  return {
    districtCode,
    datasetKey: MODIS.datasetKey,
    pixelReliability: 0,
    isReliableQuality: true,
    qualityClassification: "good_data",
    dateLabel: { $type: "string", $regex: ISO_DAY },
    $or: MODIS_GOOD_OBSERVATION_OR,
  };
}

export function marginalModisObservationFilter(districtCode) {
  return {
    districtCode,
    datasetKey: MODIS.datasetKey,
    pixelReliability: 1,
    isReliableQuality: false,
    qualityClassification: "marginal_data",
    dateLabel: { $type: "string", $regex: ISO_DAY },
  };
}

export function isGoodModisObservation(observation, districtCode) {
  if (!observation || observation.districtCode !== districtCode || observation.datasetKey !== MODIS.datasetKey ||
      observation.pixelReliability !== 0 || observation.isReliableQuality !== true ||
      observation.qualityClassification !== "good_data" || !isValidDateLabel(observation.dateLabel)) return false;

  const valid = (value, layer) => Number.isFinite(value) && value >= layer.validMin && value <= layer.validMax;
  return valid(observation.ndvi, MODIS.layers.ndvi) || valid(observation.evi, MODIS.layers.evi);
}

export function latestGoodModisSnapshot(snapshot, districtCode) {
  return (Array.isArray(snapshot?.observations) ? snapshot.observations : [])
    .filter((observation) => isGoodModisObservation(observation, districtCode))
    .sort((a, b) => b.dateLabel.localeCompare(a.dateLabel))[0] || null;
}

export async function findLatestGoodModisObservation(Model, districtCode) {
  const observations = await Model.find(goodModisObservationFilter(districtCode))
    .sort({ dateLabel: -1 })
    .lean();
  return observations.find((observation) => isGoodModisObservation(observation, districtCode)) || null;
}

export async function findLatestMarginalModisObservation(Model, districtCode) {
  const observations = await Model.find(marginalModisObservationFilter(districtCode))
    .sort({ dateLabel: -1 })
    .lean();
  return observations.find((observation) => isValidDateLabel(observation.dateLabel)) || null;
}
