import { FarmNotification } from "../models/farmnotification.model.js";
import { Farm } from "../models/farm.model.js";
import { FarmActivity } from "../models/farmactivity.model.js";
import { generateFarmLifecycleTimeline } from "./croplifecycle.service.js";

/**
 * Calculates day difference in UTC (isoDateA - isoDateB).
 */
function diffDaysUtc(isoDateA, isoDateB) {
  const [y1, m1, d1] = isoDateA.split("-").map(Number);
  const [y2, m2, d2] = isoDateB.split("-").map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.floor((t1 - t2) / (24 * 3600 * 1000));
}

export class FarmNotificationService {
  /**
   * Synchronizes notifications for a farmer based on active farms,
   * upcoming/due/overdue activities, and lifecycle stage transitions.
   * Deterministic and idempotent via deduplication keys.
   */
  static async syncUserNotifications(userId, options = {}) {
    const todayStr = options.asOfDate || new Date().toISOString().split("T")[0];

    const farms = await Farm.find({ userId, status: { $ne: "ARCHIVED" } }).lean();
    if (!farms || farms.length === 0) {
      return { syncedCount: 0 };
    }

    const farmIds = farms.map((f) => f._id);
    const activeActivities = await FarmActivity.find({
      userId,
      farmId: { $in: farmIds },
      status: { $in: ["PENDING", "IN_PROGRESS"] },
    }).lean();

    const farmMap = new Map(farms.map((f) => [f._id.toString(), f]));
    const ops = [];

    // 1. Process Activities
    for (const activity of activeActivities) {
      const farm = farmMap.get(activity.farmId.toString());
      if (!farm) continue;

      const diff = diffDaysUtc(activity.scheduledDate, todayStr);
      let notifType = null;
      let title = "";
      let message = "";

      if (diff === 0) {
        notifType = "ACTIVITY_DUE_TODAY";
        title = `Task Due Today: ${activity.title}`;
        message = `"${activity.title}" for ${farm.name} is due today (${activity.scheduledDate}).`;
      } else if (diff > 0 && diff <= 2) {
        notifType = "ACTIVITY_UPCOMING";
        title = `Upcoming Task: ${activity.title}`;
        message = `"${activity.title}" for ${farm.name} is scheduled in ${diff} day(s) on ${activity.scheduledDate}.`;
      } else if (diff < 0) {
        notifType = "ACTIVITY_OVERDUE";
        title = `Overdue Task: ${activity.title}`;
        message = `"${activity.title}" for ${farm.name} was scheduled for ${activity.scheduledDate} and remains pending.`;
      }

      if (notifType) {
        const deduplicationKey = `${userId}_${farm._id}_${activity._id}_${notifType}_${activity.scheduledDate}`;
        ops.push({
          updateOne: {
            filter: { deduplicationKey },
            update: {
              $setOnInsert: {
                userId,
                farmId: farm._id,
                activityId: activity._id,
                type: notifType,
                title,
                message,
                sourceType: activity.sourceType || "PROJECT_GENERATED",
                scheduledFor: activity.scheduledDate,
                isRead: false,
                readAt: null,
                deduplicationKey,
                metadata: {
                  cropCode: farm.crop?.cropCode,
                  stageCode: activity.relatedStageCode,
                  activityType: activity.activityType,
                },
              },
            },
            upsert: true,
          },
        });
      }
    }

    // 2. Process Lifecycle Stage Transitions
    for (const farm of farms) {
      try {
        const timelineRes = generateFarmLifecycleTimeline(farm, { asOfDate: todayStr });
        if (timelineRes.success && timelineRes.data?.nextStage?.estimatedStartDate) {
          const nextStage = timelineRes.data.nextStage;
          const stageDiff = diffDaysUtc(nextStage.estimatedStartDate, todayStr);

          // Alert 1 to 3 days before upcoming stage
          if (stageDiff >= 0 && stageDiff <= 3) {
            const notifType = "LIFECYCLE_STAGE_UPCOMING";
            const deduplicationKey = `${userId}_${farm._id}_STAGE_${nextStage.stageCode}_${nextStage.estimatedStartDate}`;
            const title = `Approaching Stage: ${nextStage.stageNameEn}`;
            const message = `${farm.name} is estimated to enter "${nextStage.stageNameEn}" (${nextStage.stageNameBn}) in ${stageDiff === 0 ? "today" : `${stageDiff} day(s)`}.`;

            ops.push({
              updateOne: {
                filter: { deduplicationKey },
                update: {
                  $setOnInsert: {
                    userId,
                    farmId: farm._id,
                    activityId: null,
                    type: notifType,
                    title,
                    message,
                    sourceType: "PROJECT_GENERATED",
                    scheduledFor: nextStage.estimatedStartDate,
                    isRead: false,
                    readAt: null,
                    deduplicationKey,
                    metadata: {
                      cropCode: farm.crop?.cropCode,
                      stageCode: nextStage.stageCode,
                      stageNameEn: nextStage.stageNameEn,
                      stageNameBn: nextStage.stageNameBn,
                    },
                  },
                },
                upsert: true,
              },
            });
          }
        }
      } catch {
        // ignore timeline calculation error for invalid or legacy farms
      }
    }

    if (ops.length > 0) {
      await FarmNotification.bulkWrite(ops, { ordered: false });
    }

    return { syncedCount: ops.length };
  }

  /**
   * Retrieves notifications for a user with pagination and filters.
   */
  static async getNotifications(userId, query = {}) {
    // Auto-sync first so results are fresh
    await this.syncUserNotifications(userId);

    const filter = { userId };
    if (query.unreadOnly === true || query.unreadOnly === "true") {
      filter.isRead = false;
    }
    if (query.farmId) {
      filter.farmId = query.farmId;
    }

    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
    const offset = Math.max(parseInt(query.offset, 10) || 0, 0);

    const [items, total, unreadCount] = await Promise.all([
      FarmNotification.find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate("farmId", "name crop location")
        .populate("activityId", "title activityType scheduledDate status")
        .lean(),
      FarmNotification.countDocuments(filter),
      FarmNotification.countDocuments({ userId, isRead: false }),
    ]);

    return {
      notifications: items,
      pagination: {
        total,
        unreadCount,
        limit,
        offset,
        hasMore: offset + items.length < total,
      },
    };
  }

  /**
   * Returns current count of unread notifications for a user.
   */
  static async getUnreadCount(userId) {
    const unreadCount = await FarmNotification.countDocuments({ userId, isRead: false });
    return { unreadCount };
  }

  /**
   * Marks a specific notification as read.
   */
  static async markAsRead(userId, notificationId) {
    const notification = await FarmNotification.findOneAndUpdate(
      { _id: notificationId, userId },
      { $set: { isRead: true, readAt: new Date() } },
      { new: true }
    );
    if (!notification) {
      return { success: false, error: "Notification not found or access denied" };
    }
    return { success: true, notification };
  }

  /**
   * Marks all notifications (or all for a specific farm) as read for a user.
   */
  static async markAllAsRead(userId, farmId = null) {
    const filter = { userId, isRead: false };
    if (farmId) {
      filter.farmId = farmId;
    }

    const result = await FarmNotification.updateMany(filter, {
      $set: { isRead: true, readAt: new Date() },
    });

    return { success: true, modifiedCount: result.modifiedCount };
  }

  /**
   * Deletes / dismisses a single notification.
   */
  static async deleteNotification(userId, notificationId) {
    const result = await FarmNotification.deleteOne({ _id: notificationId, userId });
    if (result.deletedCount === 0) {
      return { success: false, error: "Notification not found or access denied" };
    }
    return { success: true };
  }
}
