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
import { successResponse } from "../utils/response.js";
import { snapshotService } from "../services/snapshot.service.js";

/**
 * GET /api/v1/data-sources
 * Returns active datasets, live observations count, dynamic coverage, and provenance.
 */
export async function getDataSources(req, res, next) {
  try {
    const registry = await NasaDataset.findOne({ datasetKey: "nasa:power:daily:point" }).lean();
    const definitions = [
      { datasetKey: "nasa:power:daily:point", product: registry?.product || "NASA POWER Daily Agroclimatology Point", provider: registry?.provider || "NASA POWER / Langley Research Center", spatialResolution: registry?.spatialResolutionNote || "0.5° × 0.625° source grid; point interpolation", timeStandard: "LST", timeDisclosure: registry?.timeStandardDisclosure || "NASA POWER Local Solar Time; not a forecast.", qualityPolicy: "Only records quality=ok contain valid values; missing/sentinel/absent states stay distinct.", parameters: registry?.parameters ? (registry.parameters instanceof Map ? Object.fromEntries(registry.parameters) : registry.parameters) : { PRECTOTCORR: { unit: "mm/day", longName: "Precipitation Corrected" }, T2M: { unit: "°C", longName: "Temperature at 2 meters" }, RH2M: { unit: "%", longName: "Relative humidity at 2 meters" } }, sourceUrls: registry?.sourceUrls || ["https://power.larc.nasa.gov/"], Model: NasaObservation, datePath: "dateLabel", createdPath: "createdAt" },
      { datasetKey: GPM.datasetKey, product: GPM.product, provider: GPM.provider, spatialResolution: GPM.spatialResolution, timeStandard: "UTC source intervals; BST (UTC+06:00) daily aggregation", timeDisclosure: "A daily total is available only with 48 valid, unique half-hour intervals.", qualityPolicy: "Retains source quality/fill metadata; missing intervals prevent publishing a daily total.", parameters: { precipitationRateMmHr: { unit: "mm/hr", longName: "Half-hour precipitation rate" }, precipitationMm: { unit: "mm", longName: "Half-hour precipitation amount" } }, sourceUrls: [GPM.documentationUrl], Model: GpmObservation, datePath: "dateLabel", createdPath: "createdAt", query: { runType: GPM.runType, productVersion: GPM.granuleVersion } },
      { datasetKey: SMAP.datasetKey, product: SMAP.productName, provider: SMAP.provider, spatialResolution: SMAP.spatialResolution, timeStandard: "UTC acquisition timestamps; UTC observation date", timeDisclosure: SMAP.disclosure, qualityPolicy: "Flags 0 and 8 are recommended; other retrieval flags are classified and must not be presented as trusted values.", parameters: { soilMoisture: { unit: "m³/m³", longName: "Surface volumetric soil moisture" } }, sourceUrls: SMAP.documentationUrls, Model: SmapObservation, datePath: "dateLabel", createdPath: "createdAt" },
      { datasetKey: MODIS.datasetKey, product: MODIS.productName, provider: MODIS.provider, spatialResolution: MODIS.spatialResolution, timeStandard: "UTC observation date", timeDisclosure: MODIS.disclosure, qualityPolicy: "Pixel reliability 0=good, 1=marginal; snow/ice, cloud and fill classes are not treated as good observations.", parameters: { NDVI: { unit: "NDVI", longName: "Normalized Difference Vegetation Index" }, EVI: { unit: "EVI", longName: "Enhanced Vegetation Index" }, pixelReliability: { unit: "rank", longName: "Pixel reliability class" } }, sourceUrls: MODIS.documentationUrls, Model: ModisObservation, datePath: "dateLabel", createdPath: "createdAt" },
    ];
    const databaseConnected = snapshotService.isDbConnected();
    const enriched = await Promise.all(definitions.map(async (ds) => {
      if (!databaseConnected) return { ...dsPublic(ds), availability: "database_unavailable", observationCount: null, districtCoverage: {}, firstObservationDate: null, lastObservationDate: null, lastIngestedAt: null };
      const filter = ds.query || {};
      const [observationCount, dates, byDistrict, lastIngested] = await Promise.all([
        ds.Model.countDocuments(filter),
        ds.Model.aggregate([{ $match: filter }, { $group: { _id: null, first: { $min: "$" + ds.datePath }, last: { $max: "$" + ds.datePath } } }]),
        ds.Model.aggregate([{ $match: filter }, { $group: { _id: "$districtCode", count: { $sum: 1 } } }]),
        ds.Model.findOne(filter).sort({ [ds.createdPath]: -1 }).select(ds.createdPath).lean(),
      ]);
      return { ...dsPublic(ds), availability: observationCount ? "available" : "not_ingested", observationCount, districtCoverage: Object.fromEntries(byDistrict.map((d) => [d._id, d.count])), firstObservationDate: dates[0]?.first || null, lastObservationDate: dates[0]?.last || null, lastIngestedAt: lastIngested?.createdAt || null };
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
