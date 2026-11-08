import mongoose from "mongoose";

export const NOTIFICATION_TYPES = [
  "ACTIVITY_UPCOMING",
  "ACTIVITY_DUE_TODAY",
  "ACTIVITY_OVERDUE",
  "LIFECYCLE_STAGE_UPCOMING",
  "FARM_DATA_UNAVAILABLE",
];

export const NOTIFICATION_SOURCE_TYPES = [
  "OFFICIAL_GUIDANCE",
  "PROJECT_GENERATED",
  "FARMER_CREATED",
  "SYSTEM",
];

const farmNotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "userId is required for notification ownership"],
      index: true,
    },
    farmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Farm",
      required: [true, "farmId is required"],
      index: true,
    },
    activityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FarmActivity",
      default: null,
      index: true,
    },
    type: {
      type: String,
      required: [true, "Notification type is required"],
      enum: {
        values: NOTIFICATION_TYPES,
        message: "Invalid notification type: {VALUE}",
      },
      index: true,
    },
    title: {
      type: String,
      required: [true, "Notification title is required"],
      trim: true,
      maxlength: [200, "Title cannot exceed 200 characters"],
    },
    message: {
      type: String,
      required: [true, "Notification message is required"],
      trim: true,
      maxlength: [1000, "Message cannot exceed 1000 characters"],
    },
    sourceType: {
      type: String,
      enum: {
        values: NOTIFICATION_SOURCE_TYPES,
        message: "Invalid source type: {VALUE}",
      },
      default: "PROJECT_GENERATED",
    },
    scheduledFor: {
      type: String,
      default: null,
      match: [/^\d{4}-\d{2}-\d{2}$/, "scheduledFor must follow ISO YYYY-MM-DD format if provided"],
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
    deduplicationKey: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes
farmNotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
farmNotificationSchema.index({ userId: 1, farmId: 1, createdAt: -1 });

export const FarmNotification =
  mongoose.models.FarmNotification || mongoose.model("FarmNotification", farmNotificationSchema);
