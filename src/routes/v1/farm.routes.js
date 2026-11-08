/**
 * Farm Routes.
 * Mounted at /api/v1/farms.
 * Enforces authenticated identity on every endpoint.
 */

import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware.js";
import {
  createFarm,
  deleteFarm,
  getFarmById,
  getFarmEnvironment,
  getFarmLifecycle,
  listFarms,
  refreshFarmLifecycle,
  updateFarm,
} from "../../controllers/farm.controller.js";
import {
  createFarmActivity,
  deleteFarmActivity,
  generateFarmActivities,
  getActivitiesNotificationReadiness,
  getActivitiesOverview,
  getSingleFarmActivity,
  listFarmActivities,
  updateFarmActivity,
} from "../../controllers/farmactivity.controller.js";

const router = Router();

// All farm routes require authentication
router.use(authenticate);

// Global user farm activity overview & notification routes (must precede /:id)
router.get("/activities/overview", getActivitiesOverview);
router.get("/activities/notifications-readiness", getActivitiesNotificationReadiness);

router.get("/", listFarms);
router.post("/", createFarm);
router.get("/:id", getFarmById);
router.patch("/:id", updateFarm);
router.delete("/:id", deleteFarm);
router.get("/:id/lifecycle", getFarmLifecycle);
router.post("/:id/lifecycle/refresh", refreshFarmLifecycle);
router.get("/:id/environment", getFarmEnvironment);

// Farm-specific activity routes
router.get("/:id/activities", listFarmActivities);
router.post("/:id/activities", createFarmActivity);
router.get("/:id/activities/:activityId", getSingleFarmActivity);
router.patch("/:id/activities/:activityId", updateFarmActivity);
router.delete("/:id/activities/:activityId", deleteFarmActivity);
router.post("/:id/activities/generate", generateFarmActivities);

export default router;
