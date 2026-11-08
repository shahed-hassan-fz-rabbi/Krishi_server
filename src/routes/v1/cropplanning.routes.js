/**
 * Crop Planning Routes.
 * Mounted at /api/v1/crop-planning.
 */

import { Router } from "express";
import { getCropRecommendations } from "../../controllers/cropplanning.controller.js";

const router = Router();

// Evaluate and explain suitable crops
router.post("/recommendations", getCropRecommendations);

export default router;
