/**
 * Dataset provenance registry (nasadatasets). One authoritative record per
 * dataset; ingestion runs reference it. Units/time standard/fill value come
 * from the live-verified contract in climate.config.js — same source the
 * observations are stamped from, so rules cannot drift apart.
 */
import { NasaDataset } from "../../models/nasadataset.model.js";
import {
  PARAMETER_CATALOG,
  PARAMETER_NAMES,
  POWER,
} from "../../config/climate.config.js";

const POWER_SOURCE_URLS = [
  "https://power.larc.nasa.gov/api/temporal/daily/point",
  "https://power.larc.nasa.gov/docs/services/api/temporal/daily/",
];

/**
 * Ensures the POWER provenance record exists (idempotent). Returns the document.
 * Units are stamped from the verified catalog and refreshed live-echo values are
 * recorded into the ingestion log by the run, not into this record.
 */
export async function ensurePowerDatasetProvenance() {
  // Missing record returns null from Mongoose (no error) — only true failures throw.
  const doc = await NasaDataset.findById(POWER.datasetKey);
  if (doc) return doc;

  const parameters = {};
  for (const name of PARAMETER_NAMES) {
    parameters[name] = {
      unit: PARAMETER_CATALOG[name].unit,
      longName: PARAMETER_CATALOG[name].longName,
    };
  }

  const created = await NasaDataset.create({
    _id: POWER.datasetKey,
    datasetKey: POWER.datasetKey,
    product: POWER.productName,
    provider: "NASA POWER (Langley Research Center)",
    endpoint: POWER.endpoint,
    community: POWER.community,
    sources: [], // filled per run from the response header echo
    parameters,
    fillValue: POWER.fillValue,
    timeStandard: POWER.timeStandard,
    timeStandardDisclosure: POWER.timeStandardDisclosure,
    sourceUrls: POWER_SOURCE_URLS,
    coverage: { firstObservedDate: null, lastObservedDate: null, lastVerifiedAt: null },
  });
  return created;
}
