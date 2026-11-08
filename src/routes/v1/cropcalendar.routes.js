/**
 * Official Crop Calendar Routes.
 * Mounted at /api/v1/crop-calendar.
 */

import { Router } from "express";
import {
  getCropCalendarAlignment,
  getCropCalendars,
  getCropList,
} from "../../controllers/cropcalendar.controller.js";

const router = Router();

router.get("/crops", getCropList);
router.get("/alignment", getCropCalendarAlignment);
router.get("/", getCropCalendars);

export default router;
