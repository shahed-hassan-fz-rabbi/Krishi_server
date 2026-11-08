import mongoose from "mongoose";

const messageSubSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
    },
    sources: {
      type: [String],
      default: [],
    },
    dataDate: {
      type: String,
      default: null,
    },
    dataQuality: {
      type: String,
      default: null,
    },
    provenance: {
      type: [String],
      default: [],
    },
    limitations: {
      type: [String],
      default: [],
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const conversationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "userId is required for persistent conversation storage"],
      index: true,
    },
    title: {
      type: String,
      required: [true, "Conversation title is required"],
      trim: true,
      maxlength: [120, "Title cannot exceed 120 characters"],
      default: "নতুন কৃষি আলোচনা",
    },
    district: {
      type: String,
      default: "cumilla",
      trim: true,
    },
    crop: {
      type: String,
      default: "all",
      trim: true,
    },
    farmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Farm",
      default: null,
      index: true,
    },
    messages: {
      type: [messageSubSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      transform: (_doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

conversationSchema.index({ userId: 1, updatedAt: -1 });

export const Conversation = mongoose.model("Conversation", conversationSchema);
