import { Router } from "express";
import { getDivisionIntelligence, getDivisions } from "../../controllers/divisions.controller.js";

const router = Router();
router.get("/", getDivisions);
router.get("/intelligence", getDivisionIntelligence);
export default router;
