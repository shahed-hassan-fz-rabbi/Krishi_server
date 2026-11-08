import mongoose from "mongoose";

export const VALID_ACTIVITY_TYPES = [
  "field_preparation",
  "sowing",
  "transplanting",
  "irrigation_monitoring",
  "weeding",
  "fertilizer_application",
  "pest_scouting",
  "harvesting",
  "threshing_drying",
  "general_management",
];

export const VALID_ACTIVITY_STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETED", "SKIPPED"];

export const VALID_SOURCE_TYPES = ["OFFICIAL_GUIDANCE", "PROJECT_GENERATED", "FARMER_CREATED"];

const farmActivitySchema = new mongoose.Schema(
  {
    farmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Farm",
      required: [true, "farmId is required"],
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "userId is required for activity ownership"],
      index: true,
    },
    title: {
      type: String,
      required: [true, "Activity title is required"],
      trim: true,
      minlength: [2, "Title must be at least 2 characters"],
      maxlength: [200, "Title cannot exceed 200 characters"],
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: [1000, "Description cannot exceed 1000 characters"],
    },
    activityType: {
      type: String,
      required: [true, "Activity type is required"],
      enum: {
        values: VALID_ACTIVITY_TYPES,
        message: "Invalid activity type: {VALUE}",
      },
      default: "general_management",
    },
    relatedStageCode: {
      type: String,
      default: "",
      trim: true,
    },
    scheduledDate: {
      type: String,
      required: [true, "Scheduled date is required (YYYY-MM-DD)"],
      match: [/^\d{4}-\d{2}-\d{2}$/, "Scheduled date must follow ISO YYYY-MM-DD format"],
      index: true,
    },
    status: {
      type: String,
      enum: {
        values: VALID_ACTIVITY_STATUSES,
        message: "Invalid status: {VALUE}",
      },
      default: "PENDING",
      index: true,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    completionNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: [1000, "Completion note cannot exceed 1000 characters"],
    },
    sourceType: {
      type: String,
      enum: {
        values: VALID_SOURCE_TYPES,
        message: "Invalid source type: {VALUE}",
      },
      required: [true, "Source type is required"],
      default: "FARMER_CREATED",
    },
    sourceReferences: {
      documentTitle: { type: String, default: "" },
      publisher: { type: String, default: "" },
      url: { type: String, default: "" },
      stageNameEn: { type: String, default: "" },
      stageNameBn: { type: String, default: "" },
    },
    isCustom: {
      type: Boolean,
      default: false,
    },
    generatedKey: {
      type: String,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for fast query filtering and sorting
farmActivitySchema.index({ farmId: 1, scheduledDate: 1, status: 1 });
farmActivitySchema.index({ userId: 1, scheduledDate: 1, status: 1 });
farmActivitySchema.index({ farmId: 1, generatedKey: 1 });

export const FarmActivity =
  mongoose.models.FarmActivity || mongoose.model("FarmActivity", farmActivitySchema);
