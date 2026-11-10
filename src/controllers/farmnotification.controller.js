import mongoose from "mongoose";
import { FarmNotificationService } from "../services/farmnotification.service.js";
import { errorResponse, successResponse } from "../utils/response.js";

/**
 * GET /api/v1/notifications
 */
export async function getNotifications(req, res, next) {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 401, "Authentication required", "UNAUTHORIZED");
    }

    const data = await FarmNotificationService.getNotifications(userId, req.query);
    return successResponse(res, 200, data, {
      message: `Retrieved ${data.notifications.length} notifications`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/notifications/unread-count
 */
export async function getUnreadCount(req, res, next) {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 401, "Authentication required", "UNAUTHORIZED");
    }

    const data = await FarmNotificationService.getUnreadCount(userId);
    return successResponse(res, 200, data);
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/v1/notifications/:id/read
 */
export async function markAsRead(req, res, next) {
  try {
    const userId = req.user?._id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid notification ID format", "INVALID_ID");
    }

    const result = await FarmNotificationService.markAsRead(userId, id);
    if (!result.success) {
      return errorResponse(res, 404, result.error, "NOT_FOUND");
    }

    return successResponse(res, 200, result.notification, {
      message: "Notification marked as read",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/v1/notifications/read-all
 */
export async function markAllAsRead(req, res, next) {
  try {
    const userId = req.user?._id;
    const farmId = req.body?.farmId || req.query?.farmId || null;

    if (farmId && !mongoose.Types.ObjectId.isValid(farmId)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }

    const result = await FarmNotificationService.markAllAsRead(userId, farmId);
    if (!result.success) {
      return errorResponse(res, result.error === "Authentication required" ? 401 : 404, result.error, "NOT_FOUND");
    }
    return successResponse(res, 200, result, {
      message: `Marked ${result.modifiedCount} notification(s) as read`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/v1/notifications/:id
 */
export async function deleteNotification(req, res, next) {
  try {
    const userId = req.user?._id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid notification ID format", "INVALID_ID");
    }

    const result = await FarmNotificationService.deleteNotification(userId, id);
    if (!result.success) {
      return errorResponse(res, 404, result.error, "NOT_FOUND");
    }

    return successResponse(res, 200, null, {
      message: "Notification dismissed",
    });
  } catch (error) {
    next(error);
  }
}
