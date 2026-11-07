/**
 * Data Sources Controller.
 * Exposes dataset provenance, parameters, verified coverage, and time standard disclosure.
 */
import { NasaDataset } from "../models/nasadataset.model.js";
import { NasaObservation } from "../models/nasaobservation.model.js";
import { successResponse } from "../utils/response.js";

/**
 * GET /api/v1/data-sources
 * Returns active datasets, live observations count, dynamic coverage, and provenance.
 */
export async function getDataSources(req, res, next) {
  try {
    const datasets = await NasaDataset.find({}).lean();
    const enriched = [];

    for (const ds of datasets) {
      const observationCount = await NasaObservation.countDocuments({ datasetKey: ds.datasetKey });
      enriched.push({
        datasetKey: ds.datasetKey,
        product: ds.product,
        provider: ds.provider,
        endpoint: ds.endpoint,
        community: ds.community,
        parameters: ds.parameters || {},
        fillValue: ds.fillValue,
        timeStandard: ds.timeStandard,
        timeStandardDisclosure: ds.timeStandardDisclosure,
        spatialResolutionNote: ds.spatialResolutionNote,
        coverage: ds.coverage || {
          firstObservedDate: null,
          lastObservedDate: null,
          lastVerifiedAt: null,
        },
        sourceUrls: ds.sourceUrls || [],
        observationCount,
      });
    }

    return successResponse(res, 200, enriched, {
      totalDatasets: enriched.length,
      provenanceStandard: "NASA POWER Agroclimatology (LST)",
    });
  } catch (error) {
    next(error);
  }
}
