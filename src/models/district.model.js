/**
 * District registry — the two project-configured locations with their EXACT
 * coordinates. Coordinates are seeded from src/config/climate.config.js and are
 * never substituted. Collection name is explicit.
 */
import mongoose from "mongoose";

const districtSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, lowercase: true, trim: true }, // "chattogram" | "cumilla"
    nameEn: { type: String, required: true, trim: true },
    nameBn: { type: String, required: true, trim: true },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    isDefault: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
    coordinateSource: {
      type: String,
      default: "project configuration (exact coordinates — never substituted)",
    },
  },
  { collection: "districts", timestamps: true }
);

districtSchema.index({ code: 1 }, { unique: true });

export const District = mongoose.model("District", districtSchema);
