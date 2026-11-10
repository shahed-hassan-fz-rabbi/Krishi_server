/**
 * Data Sources Controller.
 * Exposes dataset provenance, parameters, verified coverage, and time standard disclosure.
 */
import { NasaDataset } from "../models/nasadataset.model.js";
import { NasaObservation } from "../models/nasaobservation.model.js";
import { GpmObservation } from "../models/gpmobservation.model.js";
import { SmapObservation } from "../models/smapobservation.model.js";
import { ModisObservation } from "../models/modisobservation.model.js";
import { GPM } from "../config/gpm.config.js";
import { SMAP } from "../config/smap.config.js";
import { MODIS } from "../config/modis.config.js";
import { DISTRICTS } from "../config/climate.config.js";
import { successResponse } from "../utils/response.js";
import { snapshotService } from "../services/snapshot.service.js";

export function buildDistrictCoverage({ districtCodes, storedRows, validRows, qualityRows }) {
  const storedByDistrict = Object.fromEntries(storedRows.map((row) => [row._id, row.count]));
  const qualityCountsByDistrict = {};
  for (const row of qualityRows) {
    const districtCode = row._id?.districtCode;
    if (!districtCode) continue;
    const quality = row._id.quality == null ? "unknown" : String(row._id.quality);
    qualityCountsByDistrict[districtCode] ||= {};
    qualityCountsByDistrict[districtCode][quality] = row.count;
  }
  const validCoverage = Object.fromEntries(validRows.map((d) => [d._id, {
    districtCode: d._id,
    count: d.count,
    firstObservationDate: d.first, lastObservationDate: d.last,
    qualityCounts: qualityCountsByDistrict[d._id] || {},
    availability: "available",
  }]));
  const districtAvailability = Object.fromEntries(districtCodes.map((districtCode) => {
    const storedRecordCount = storedByDistrict[districtCode] || 0;
    const valid = validCoverage[districtCode];
    const validRecordCount = valid?.count || 0;
    const availability = validRecordCount > 0
      ? "available"
      : storedRecordCount > 0 ? "no_valid_observations" : "not_ingested";
    const status = {
      districtCode,
      availability,
      storedRecordCount,
      validRecordCount,
      firstValidObservationDate: valid?.firstObservationDate || null,
      lastValidObservationDate: valid?.lastObservationDate || null,
      qualityCounts: qualityCountsByDistrict[districtCode] || {},
    };
    if (valid) validCoverage[districtCode] = { ...valid, ...status };
    return [districtCode, status];
  }));
  return { storedByDistrict, validCoverage, districtAvailability };
}

/**
 * GET /api/v1/data-sources
 * Returns active datasets, live observations count, dynamic coverage, and provenance.
 */
export async function getDataSources(req, res, next) {
  try {
    const registry = await NasaDataset.findOne({ datasetKey: "nasa:power:daily:point" }).lean();
    const definitions = [
      { datasetKey: "nasa:power:daily:point", product: registry?.product || "NASA POWER Daily Agroclimatology Point", provider: registry?.provider || "NASA POWER / Langley Research Center", spatialResolution: registry?.spatialResolutionNote || "0.5° × 0.625° source grid; point interpolation", timeStandard: "LST", timeDisclosure: registry?.timeStandardDisclosure || "NASA POWER Local Solar Time; not a forecast.", qualityPolicy: "Only records quality=ok contain valid values; missing/sentinel/absent states stay distinct.", parameters: registry?.parameters ? (registry.parameters instanceof Map ? Object.fromEntries(registry.parameters) : registry.parameters) : { PRECTOTCORR: { unit: "mm/day", longName: "Precipitation Corrected" }, T2M: { unit: "°C", longName: "Temperature at 2 meters" }, RH2M: { unit: "%", longName: "Relative humidity at 2 meters" } }, sourceUrls: registry?.sourceUrls || ["https://power.larc.nasa.gov/"], Model: NasaObservation, datePath: "dateLabel", createdPath: "createdAt", qualityPath: "quality", query: { datasetKey: "nasa:power:daily:point" }, validQuery: { quality: "ok", value: { $type: "number" } } },
      { datasetKey: GPM.datasetKey, product: GPM.product, provider: GPM.provider, spatialResolution: GPM.spatialResolution, timeStandard: "UTC source intervals; BST (UTC+06:00) daily aggregation", timeDisclosure: "A daily total is available only with 48 valid, unique half-hour intervals.", qualityPolicy: "Retains source quality/fill metadata; missing intervals prevent publishing a daily total.", parameters: { precipitationRateMmHr: { unit: "mm/hr", longName: "Half-hour precipitation rate" }, precipitationMm: { unit: "mm", longName: "Half-hour precipitation amount" } }, sourceUrls: [GPM.documentationUrl], Model: GpmObservation, datePath: "dateLabel", createdPath: "createdAt", qualityPath: "sourceQuality", query: { datasetKey: GPM.datasetKey, runType: GPM.runType, productVersion: GPM.granuleVersion }, validQuery: { sourceQuality: "valid", precipitationMm: { $type: "number", $gte: 0 } } },
      { datasetKey: SMAP.datasetKey, product: SMAP.productName, provider: SMAP.provider, spatialResolution: SMAP.spatialResolution, timeStandard: "UTC acquisition timestamps; UTC observation date", timeDisclosure: SMAP.disclosure, qualityPolicy: "Flags 0 and 8 are recommended; other retrieval flags are classified and must not be presented as trusted values.", parameters: { soilMoisture: { unit: "m³/m³", longName: "Surface volumetric soil moisture" } }, sourceUrls: SMAP.documentationUrls, Model: SmapObservation, datePath: "dateLabel", createdPath: "createdAt", qualityPath: "qualityClassification", query: { datasetKey: SMAP.datasetKey }, validQuery: { retrievalQualityFlag: { $in: [0, 8] }, isRecommendedQuality: true, qualityClassification: "recommended", soilMoisture: { $type: "number", $gte: 0, $lte: 1 } } },
      { datasetKey: MODIS.datasetKey, product: MODIS.productName, provider: MODIS.provider, spatialResolution: MODIS.spatialResolution, timeStandard: "UTC observation date", timeDisclosure: MODIS.disclosure, qualityPolicy: "Pixel reliability 0=good, 1=marginal; snow/ice, cloud and fill classes are not treated as good observations.", parameters: { NDVI: { unit: "NDVI", longName: "Normalized Difference Vegetation Index" }, EVI: { unit: "EVI", longName: "Enhanced Vegetation Index" }, pixelReliability: { unit: "rank", longName: "Pixel reliability class" } }, sourceUrls: MODIS.documentationUrls, Model: ModisObservation, datePath: "dateLabel", createdPath: "createdAt", qualityPath: "qualityClassification", query: { datasetKey: MODIS.datasetKey }, validQuery: { isReliableQuality: true, qualityClassification: "good_data", pixelReliability: 0, $or: [{ ndvi: { $type: "number", $gte: -0.2, $lte: 1 } }, { evi: { $type: "number", $gte: -0.2, $lte: 1 } }] } },
    ];
    const databaseConnected = snapshotService.isDbConnected();
    const enriched = await Promise.all(definitions.map(async (ds) => {
      if (!databaseConnected) return { ...dsPublic(ds), availability: "database_unavailable", observationCount: null, districtCoverage: {}, districtValidCoverage: {}, districtAvailability: Object.fromEntries(DISTRICTS.map(({ code }) => [code, { districtCode: code, availability: "database_unavailable", storedRecordCount: null, validRecordCount: null, qualityCounts: {} }])), firstObservationDate: null, lastObservationDate: null, lastIngestedAt: null };
      const filter = ds.query || {};
      const validFilter = ds.validQuery ? { ...filter, ...ds.validQuery } : filter;
      const [observationCount, dates, byDistrict, validByDistrict, qualityByDistrict, lastIngested] = await Promise.all([
        ds.Model.countDocuments(filter),
        ds.Model.aggregate([{ $match: filter }, { $group: { _id: null, first: { $min: "$" + ds.datePath }, last: { $max: "$" + ds.datePath } } }]),
        ds.Model.aggregate([{ $match: filter }, { $group: { _id: "$districtCode", count: { $sum: 1 } } }]),
        ds.Model.aggregate([{ $match: validFilter }, { $group: { _id: "$districtCode", count: { $sum: 1 }, first: { $min: "$" + ds.datePath }, last: { $max: "$" + ds.datePath } } }]),
        ds.Model.aggregate([{ $match: filter }, { $group: { _id: { districtCode: "$districtCode", quality: "$" + ds.qualityPath }, count: { $sum: 1 } } }]),
        ds.Model.findOne(filter).sort({ [ds.createdPath]: -1 }).select(ds.createdPath).lean(),
      ]);
      const { storedByDistrict, validCoverage, districtAvailability } = buildDistrictCoverage({
        districtCodes: DISTRICTS.map(({ code }) => code),
        storedRows: byDistrict,
        validRows: validByDistrict,
        qualityRows: qualityByDistrict,
      });
      const validObservationCount = validByDistrict.reduce((sum, d) => sum + d.count, 0);
      const availability = validObservationCount > 0
        ? "available"
        : observationCount > 0 ? "no_valid_observations" : "not_ingested";
      return { ...dsPublic(ds), availability, observationCount, validObservationCount, districtCoverage: storedByDistrict, districtValidCoverage: validCoverage, districtAvailability, firstObservationDate: dates[0]?.first || null, lastObservationDate: dates[0]?.last || null, lastIngestedAt: lastIngested?.createdAt || null };
    }));

    return successResponse(res, 200, enriched, {
      totalDatasets: enriched.length,
      provenanceStandard: "Source, observation date, and database ingestion timestamp are disclosed separately.",
      databaseConnected,
    });
  } catch (error) {
    next(error);
  }
}

function dsPublic(ds) {
  return { datasetKey: ds.datasetKey, product: ds.product, provider: ds.provider, spatialResolution: ds.spatialResolution, timeStandard: ds.timeStandard, timeStandardDisclosure: ds.timeDisclosure, qualityPolicy: ds.qualityPolicy, parameters: ds.parameters, sourceUrls: ds.sourceUrls };
}
