/**
 * Crop Planning Routes.
 * Mounted at /api/v1/crop-planning.
 */

import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware.js";
import { getCropRecommendations } from "../../controllers/cropplanning.controller.js";

const router = Router();

// Planning submissions may contain farmer-specific field details.
router.use(authenticate);

// Evaluate and explain suitable crops for the authenticated request.
router.post("/recommendations", getCropRecommendations);

export default router;
