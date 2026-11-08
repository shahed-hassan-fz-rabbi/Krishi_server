/**
 * Crop Lifecycle Routes.
 * Mounted at /api/v1/crop-lifecycle.
 */

import { Router } from "express";
import {
  getTemplates,
  getTemplateByCrop,
} from "../../controllers/croplifecycle.controller.js";

const router = Router();

router.get("/templates", getTemplates);
router.get("/templates/:cropCode", getTemplateByCrop);

export default router;
