import { Router } from "express";
import { getDataSources } from "../../controllers/datasources.controller.js";

const router = Router();

router.get("/", getDataSources);

export default router;
