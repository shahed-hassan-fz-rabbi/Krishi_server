import { Router } from "express";
import { getGpmDaily, getGpmHistory, getLatestGpm } from "../../controllers/gpm.controller.js";

const router = Router();
router.get("/latest", getLatestGpm);
router.get("/daily", getGpmDaily);
router.get("/history", getGpmHistory);
export default router;
