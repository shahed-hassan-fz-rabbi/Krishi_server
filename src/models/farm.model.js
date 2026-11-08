import mongoose from "mongoose";

const farmSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "userId is required for farm ownership"],
      index: true,
    },
    farmName: {
      type: String,
      required: [true, "Farm name is required"],
      trim: true,
      minlength: [2, "Farm name must be at least 2 characters"],
      maxlength: [100, "Farm name cannot exceed 100 characters"],
    },
    location: {
      district: {
        type: String,
        required: [true, "District name is required"],
        trim: true,
      },
      districtCode: {
        type: String,
        required: [true, "District code is required"],
        enum: {
          values: ["cumilla", "chattogram"],
          message: "District '{VALUE}' is not currently supported. Supported: cumilla, chattogram",
        },
        lowercase: true,
        trim: true,
      },
      upazila: {
        type: String,
        required: [true, "Upazila is required"],
        trim: true,
      },
      village: {
        type: String,
        default: "",
        trim: true,
      },
    },
    land: {
      area: {
        type: Number,
        required: [true, "Land area is required"],
        min: [0.01, "Land area must be greater than 0"],
      },
      unit: {
        type: String,
        required: [true, "Land measurement unit is required"],
        enum: {
          values: ["decimal", "acre", "hectare", "bigha", "katha"],
          message: "Invalid land measurement unit",
        },
        default: "decimal",
      },
      landType: {
        type: String,
        enum: ["high", "medium_high", "medium_low", "low", "unspecified"],
        default: "unspecified",
      },
    },
    soil: {
      type: {
        type: String,
        enum: ["clay", "loam", "sandy", "silt", "other", "unknown"],
        default: "unknown",
      },
      drainage: {
        type: String,
        enum: ["good", "moderate", "poor", "waterlogged", "unknown"],
        default: "unknown",
      },
    },
    water: {
      irrigationAvailability: {
        type: String,
        required: [true, "Irrigation availability is required"],
        enum: {
          values: ["available", "limited", "unavailable"],
          message: "Irrigation availability must be available, limited, or unavailable",
        },
        default: "available",
      },
      waterSource: {
        type: String,
        default: "",
        trim: true,
      },
    },
    crop: {
      cropCode: {
        type: String,
        required: [true, "Crop code is required"],
        enum: {
          values: ["monsoon_aman", "boro_rice", "aus_rice", "mustard"],
          message: "Crop '{VALUE}' is not verified in the official crop calendar",
        },
      },
      cropName: {
        type: String,
        required: [true, "Crop name is required"],
        trim: true,
      },
      season: {
        type: String,
        default: "",
      },
      variety: {
        type: String,
        default: "",
        trim: true,
      },
      cultivationMethod: {
        type: String,
        default: "",
        trim: true,
      },
      plantingDate: {
        type: String,
        required: [true, "Planting/sowing date is required (YYYY-MM-DD)"],
        match: [/^\d{4}-\d{2}-\d{2}$/, "Planting date must follow ISO YYYY-MM-DD format"],
      },
      currentStage: {
        type: String,
        default: "field_preparation",
        trim: true,
      },
    },
    notes: {
      type: String,
      default: "",
      maxlength: [1000, "Notes cannot exceed 1000 characters"],
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "harvested", "planning", "archived"],
      default: "active",
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for fast queries by user and creation date
farmSchema.index({ userId: 1, createdAt: -1 });
farmSchema.index({ "location.districtCode": 1 });

export const Farm = mongoose.models.Farm || mongoose.model("Farm", farmSchema);
