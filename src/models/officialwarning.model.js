import mongoose from "mongoose";

export const WARNING_HAZARD_TYPES = [
  "CYCLONE",
  "DEPRESSION",
  "HEAVY_RAIN",
  "FLOOD",
  "HEAT_WAVE",
  "COLD_WAVE",
  "THUNDERSTORM_LIGHTNING",
  "STORM_SURGE",
  "DROUGHT",
  "GENERAL_AGRICULTURAL_ADVISORY",
];

export const WARNING_SEVERITY_LEVELS = [
  "ADVISORY",
  "WARNING",
  "DANGER",
  "GREAT_DANGER",
];

const officialWarningSchema = new mongoose.Schema(
  {
    bulletinNumber: {
      type: String,
      required: [true, "Bulletin number is required"],
      trim: true,
      unique: true,
      index: true,
    },
    issuingAuthority: {
      type: String,
      required: true,
      default: "Bangladesh Meteorological Department (BMD)",
      trim: true,
    },
    hazardType: {
      type: String,
      required: true,
      enum: WARNING_HAZARD_TYPES,
      index: true,
    },
    signalNumber: {
      type: String,
      default: null,
      trim: true,
    },
    severity: {
      type: String,
      required: true,
      enum: WARNING_SEVERITY_LEVELS,
      default: "WARNING",
      index: true,
    },
    titleEn: {
      type: String,
      required: true,
      trim: true,
    },
    titleBn: {
      type: String,
      required: true,
      trim: true,
    },
    descriptionEn: {
      type: String,
      required: true,
      trim: true,
    },
    descriptionBn: {
      type: String,
      required: true,
      trim: true,
    },
    affectedDivisions: {
      type: [String],
      default: [],
      index: true,
    },
    affectedDistricts: {
      type: [String],
      default: [],
      index: true,
    },
    actionAdviceEn: {
      type: String,
      default: "",
    },
    actionAdviceBn: {
      type: String,
      default: "",
    },
    issuedAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    validUntil: {
      type: Date,
      required: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: false,
      index: true,
    },
    verifiedByAdmin: {
      type: Boolean,
      default: false,
      index: true,
    },
    verifiedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    verificationNotes: {
      type: String,
      default: "",
    },
    sourceUrl: {
      type: String,
      required: [true, "Official bulletin source URL is required"],
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for querying active warnings by division and validity
officialWarningSchema.index({ isActive: 1, validUntil: 1, affectedDivisions: 1 });

const OfficialWarning = mongoose.model("OfficialWarning", officialWarningSchema);

export default OfficialWarning;
