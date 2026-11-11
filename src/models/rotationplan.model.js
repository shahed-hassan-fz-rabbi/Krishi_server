import mongoose from "mongoose";

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  farmId: { type: mongoose.Schema.Types.ObjectId, ref: "Farm", default: null },
  selectedStrategyId: { type: String, required: true },
  comparison: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true });
schema.index({ userId: 1, createdAt: -1 });
export const RotationPlan = mongoose.models.RotationPlan || mongoose.model("RotationPlan", schema);
