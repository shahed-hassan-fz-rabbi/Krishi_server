import { Router } from "express";
import {
  getLatestSoilMoisture,
  getSoilMoistureHistory,
  getSoilMoistureStatus,
} from "../../controllers/smap.controller.js";

const router = Router();

router.get("/status", getSoilMoistureStatus);
router.get("/latest", getLatestSoilMoisture);
router.get("/history", getSoilMoistureHistory);

export default router;
