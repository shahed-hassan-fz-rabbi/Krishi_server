/** v1 API router — mounts every feature module under /api/v1. */

import { Router } from "express";

import healthRoutes from "./health.routes.js";

const router = Router();

router.use("/", healthRoutes);

export default router;
