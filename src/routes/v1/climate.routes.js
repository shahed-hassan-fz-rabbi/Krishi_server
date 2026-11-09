import { Router } from "express";
import {
  getClimateSummary,
  getRainfall,
  getTemperature,
  getHandoffPlan,
  getLatestClimateObservations,
} from "../../controllers/climate.controller.js";

const router = Router();

router.get("/summary", getClimateSummary);
router.get("/latest", getLatestClimateObservations);
router.get("/rainfall", getRainfall);
router.get("/temperature", getTemperature);
router.get("/handoff", getHandoffPlan);

export default router;
