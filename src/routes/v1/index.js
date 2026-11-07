/** v1 API router — mounts every feature module under /api/v1. */

import { Router } from "express";

import healthRoutes from "./health.routes.js";
import districtsRoutes from "./districts.routes.js";
import climateRoutes from "./climate.routes.js";
import dataSourcesRoutes from "./datasources.routes.js";
import authRoutes from "./auth.routes.js";

const router = Router();

router.use("/", healthRoutes);
router.use("/auth", authRoutes);
router.use("/districts", districtsRoutes);
router.use("/climate", climateRoutes);
router.use("/data-sources", dataSourcesRoutes);

export default router;
