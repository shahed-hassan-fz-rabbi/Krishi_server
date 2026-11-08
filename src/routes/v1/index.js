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

const router = Router();

router.use("/", healthRoutes);
router.use("/auth", authRoutes);
router.use("/districts", districtsRoutes);
router.use("/climate", climateRoutes);
router.use("/data-sources", dataSourcesRoutes);
router.use("/soil-moisture", smapRoutes);
router.use("/vegetation", modisRoutes);
router.use("/gis", gisRoutes);
router.use("/crop-calendar", cropCalendarRoutes);

export default router;
