/**
 * Farm Activity Controller.
 * Handles activity endpoints, custom task creation, status updates,
 * automatic template-based task generation, and user overview.
 */

import mongoose from "mongoose";
import {
  createCustomActivity,
  deleteActivity as deleteActivityService,
  generateActivitiesForFarm,
  getActivityById,
  getFarmActivities,
  getNotificationReadiness,
  getUserActivityOverview,
  updateActivity as updateActivityService,
} from "../services/farmactivity.service.js";
import {
  validateCreateActivityInput,
  validateUpdateActivityInput,
} from "../validators/farmactivity.validator.js";
import { errorResponse, successResponse } from "../utils/response.js";
import { FarmNotificationService } from "../services/farmnotification.service.js";

async function syncFarmNotifications(userId) {
  try {
    await FarmNotificationService.syncUserNotifications(userId);
  } catch {
    console.warn("[farm-activity] Notification synchronization failed.");
  }
}

/**
 * GET /api/v1/farms/:id/activities
 */
export async function listFarmActivities(req, res, next) {
  try {
    const userId = req.user?._id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }

    const result = await getFarmActivities(id, userId, req.query);
    if (!result.success) {
      return errorResponse(res, result.statusCode || 400, result.error, result.code);
    }

    return successResponse(res, 200, result.data, {
      message: `Retrieved ${result.data.activities.length} activities`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/farms/:id/activities/:activityId
 */
export async function getSingleFarmActivity(req, res, next) {
  try {
    const userId = req.user?._id;
    const { id, activityId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }
    if (!mongoose.Types.ObjectId.isValid(activityId)) {
      return errorResponse(res, 400, "Invalid activity ID format", "INVALID_ID");
    }

    const result = await getActivityById(id, activityId, userId);
    if (!result.success) {
      return errorResponse(res, result.statusCode || 400, result.error, result.code);
    }

    return successResponse(res, 200, result.data);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/farms/:id/activities
 * Creates a custom task for the farm.
 */
export async function createFarmActivity(req, res, next) {
  try {
    const userId = req.user?._id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }

    const validation = validateCreateActivityInput(req.body);
    if (!validation.isValid) {
      return errorResponse(res, 400, "Validation failed", "VALIDATION_ERROR", validation.errors);
    }

    const result = await createCustomActivity(id, userId, req.body);
    if (!result.success) {
      return errorResponse(res, result.statusCode || 400, result.error, result.code);
    }

    await syncFarmNotifications(userId);

    return successResponse(res, 201, result.data, {
      message: "Custom farm activity created successfully",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/v1/farms/:id/activities/:activityId
 */
export async function updateFarmActivity(req, res, next) {
  try {
    const userId = req.user?._id;
    const { id, activityId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }
    if (!mongoose.Types.ObjectId.isValid(activityId)) {
      return errorResponse(res, 400, "Invalid activity ID format", "INVALID_ID");
    }

    const validation = validateUpdateActivityInput(req.body);
    if (!validation.isValid) {
      return errorResponse(res, 400, "Validation failed", "VALIDATION_ERROR", validation.errors);
    }

    const result = await updateActivityService(id, activityId, userId, req.body);
    if (!result.success) {
      return errorResponse(res, result.statusCode || 400, result.error, result.code);
    }

    await syncFarmNotifications(userId);

    return successResponse(res, 200, result.data, {
      message: "Farm activity updated successfully",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/v1/farms/:id/activities/:activityId
 */
export async function deleteFarmActivity(req, res, next) {
  try {
    const userId = req.user?._id;
    const { id, activityId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }
    if (!mongoose.Types.ObjectId.isValid(activityId)) {
      return errorResponse(res, 400, "Invalid activity ID format", "INVALID_ID");
    }

    const result = await deleteActivityService(id, activityId, userId);
    if (!result.success) {
      return errorResponse(res, result.statusCode || 400, result.error, result.code);
    }

    await syncFarmNotifications(userId);

    return successResponse(res, 200, result.data, {
      message: "Farm activity deleted successfully",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/farms/:id/activities/generate
 * Generates missing official template activities for the farm.
 */
export async function generateFarmActivities(req, res, next) {
  try {
    const userId = req.user?._id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 400, "Invalid farm ID format", "INVALID_ID");
    }

    const result = await generateActivitiesForFarm(id, userId);
    if (!result.success) {
      return errorResponse(res, result.statusCode || 400, result.error, result.code);
    }

    await syncFarmNotifications(userId);

    return successResponse(res, 200, result.data, {
      message: `Generated ${result.data.generatedCount} new activities (${result.data.existingCount} already present)`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/farms/activities/overview
 * Dashboard activity overview across all user's farms.
 */
export async function getActivitiesOverview(req, res, next) {
  try {
    const userId = req.user?._id;
    const result = await getUserActivityOverview(userId);
    if (!result.success) {
      return errorResponse(res, result.statusCode || 401, result.error, result.code);
    }
    return successResponse(res, 200, result.data);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/farms/activities/notifications-readiness
 * Clean service boundary for future notification engine.
 */
export async function getActivitiesNotificationReadiness(req, res, next) {
  try {
    const userId = req.user?._id;
    const result = await getNotificationReadiness(userId);
    if (!result.success) {
      return errorResponse(res, result.statusCode || 401, result.error, result.code);
    }
    return successResponse(res, 200, result.data);
  } catch (error) {
    next(error);
  }
}
