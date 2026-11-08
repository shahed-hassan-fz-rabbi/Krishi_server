/**
 * MODIS Vegetation Routes.
 * Mounted at /api/v1/vegetation.
 */

import { Router } from "express";
import {
  getLatestVegetation,
  getVegetationHistory,
  getVegetationStatus,
} from "../../controllers/modis.controller.js";

const router = Router();

router.get("/status", getVegetationStatus);
router.get("/latest", getLatestVegetation);
router.get("/history", getVegetationHistory);

export default router;
