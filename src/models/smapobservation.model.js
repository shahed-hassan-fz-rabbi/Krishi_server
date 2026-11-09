/**
 * NASA SMAP Enhanced L3 Daily 9 km Soil Moisture (SPL3SMP_E V006).
 *
 * Scientific & Integrity Disclosures:
 * - Represents volumetric soil moisture in the top ~5 cm of soil column (m^3/m^3).
 * - Satellite-derived regional estimate at 9 km spatial resolution.
 * - This is NOT a field sensor measurement and NOT root-zone soil moisture.
 * - Quality flag: 0 = High quality/recommended; 1 = Marginal; >1 = Not recommended.
 * - Fill value: -9999.0 is never stored as a valid number or 0.
 * - Unique index on (districtCode, dateLabel, orbit) enforces idempotence.
 */

import mongoose from "mongoose";

const smapObservationSchema = new mongoose.Schema(
  {
    districtCode: { type: String, required: true, lowercase: true, index: true },
    dateLabel: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    date: { type: Date, required: true },
    acquisitionTimeUtc: { type: Date, default: null },
    orbit: { type: String, required: true, enum: ["AM", "PM"], default: "AM" },

    // Volumetric soil moisture (m^3/m^3)
    soilMoisture: { type: Number, default: null },
    soilMoistureDca: { type: Number, default: null }, // Dual Channel Algorithm
    unit: { type: String, required: true, default: "m^3/m^3" },

    // Quality assessment
    retrievalQualityFlag: { type: Number, required: true },
    retrievalQualityDcaFlag: { type: Number, default: null },
    isRecommendedQuality: { type: Boolean, required: true, default: false },
    qualityClassification: {
      type: String,
      required: true,
      enum: ["recommended", "not_recommended"],
      default: "not_recommended",
      index: true,
    },
    surfaceFlag: { type: Number, default: null },
    qaBits: {
      bit0NotRecommended: { type: Boolean, default: false },
      bit1NotAttempted: { type: Boolean, default: false },
      bit2NotSuccessful: { type: Boolean, default: false },
      bit3FreezeThawUnsuccessful: { type: Boolean, default: false },
      rawFlag: { type: Number, default: 0 },
    },

    // Geophysical & ancillary ground state variables
    surfaceTemperatureK: { type: Number, default: null }, // Skin / radiative effective surface temperature (K)
    freezeThawFraction: { type: Number, default: null }, // Quantitative FT fraction (-9999.0 = fill / uncomputed)
    bulkDensity: { type: Number, default: null }, // Soil bulk density (g/cm^3)
    clayFraction: { type: Number, default: null }, // Volumetric clay content
    staticWaterFraction: { type: Number, default: null }, // Sub-pixel static water body coverage
    radarWaterFraction: { type: Number, default: null }, // Sub-pixel radar water body coverage
    soilPorosity: { type: Number, default: null }, // Maximum physical porosity (1 - bulkDensity / 2.65)

    // Spatial representative point & verification
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    targetReferenceLat: { type: Number, default: null },
    targetReferenceLon: { type: Number, default: null },
    geodesicDistanceKm: { type: Number, default: null },
    adminPolygonPcode: { type: String, default: null }, // e.g., 'BD2019' (Comilla), 'BD2015' (Chittagong)

    // Scientific metadata & provenance
    datasetKey: { type: String, required: true, default: "nasa:smap:spl3smp_e:v006" },
    granuleId: { type: String, default: null },
    sourceUrl: { type: String, default: null },
    sourceFileSha256: { type: String, default: null },
    sourceMetadata: { type: mongoose.Schema.Types.Mixed, default: null },
    ingestionRunId: { type: String, required: true, index: true },
    provenanceDatasetId: { type: String, ref: "NasaDataset", default: "nasa:smap:spl3smp_e:v006" },
  },
  { collection: "smapobservations", timestamps: true }
);

smapObservationSchema.index(
  { districtCode: 1, dateLabel: 1, orbit: 1 },
  { unique: true, name: "uniq_smap_district_date_orbit" }
);
smapObservationSchema.index({ districtCode: 1, dateLabel: 1 });
smapObservationSchema.index({ datasetKey: 1 });

export const SmapObservation = mongoose.model("SmapObservation", smapObservationSchema);
