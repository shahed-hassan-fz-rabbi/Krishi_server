/** v1 API router — mounts every feature module under /api/v1. */

import { Router } from "express";

import healthRoutes from "./health.routes.js";
import districtsRoutes from "./districts.routes.js";
import climateRoutes from "./climate.routes.js";
import dataSourcesRoutes from "./datasources.routes.js";
import authRoutes from "./auth.routes.js";
import smapRoutes from "./smap.routes.js";
import modisRoutes from "./modis.routes.js";
import gisRoutes from "./gis.routes.js";
import cropCalendarRoutes from "./cropcalendar.routes.js";
import assistantRoutes from "./assistant.routes.js";
import farmRoutes from "./farm.routes.js";
import cropLifecycleRoutes from "./croplifecycle.routes.js";
import cropPlanningRoutes from "./cropplanning.routes.js";
import notificationRoutes from "./notification.routes.js";
import gpmRoutes from "./gpm.routes.js";
import divisionsRoutes from "./divisions.routes.js";
import weatherRoutes from "./weather.routes.js";

const router = Router();

router.use("/", healthRoutes);
router.use("/auth", authRoutes);
router.use("/districts", districtsRoutes);
router.use("/climate", climateRoutes);
router.use("/data-sources", dataSourcesRoutes);
router.use("/soil-moisture", smapRoutes);
router.use("/vegetation", modisRoutes);
router.use("/precipitation", gpmRoutes);
router.use("/gis", gisRoutes);
router.use("/crop-calendar", cropCalendarRoutes);
router.use("/assistant", assistantRoutes);
router.use("/farms", farmRoutes);
router.use("/crop-lifecycle", cropLifecycleRoutes);
router.use("/crop-planning", cropPlanningRoutes);
router.use("/notifications", notificationRoutes);
router.use("/divisions", divisionsRoutes);
router.use("/weather", weatherRoutes);

export default router;
