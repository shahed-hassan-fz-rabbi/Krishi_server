/**
 * Krishi Mama — Agricultural Weather Intelligence Routes.
 * Mounted at /api/v1/weather.
 */

import { Router } from "express";
import { authenticate, optionalAuthenticate, requireRole } from "../../middleware/auth.middleware.js";
import {
  getForecast,
  getOutlook,
  getAlerts,
  getCropPlanning,
  createAdminWarningDraft,
  verifyAdminWarning,
  revokeAdminWarning,
  listAdminWarnings,
} from "../../controllers/weather.controller.js";

const router = Router();

// 1. Short-range (1-7d) & Extended (8-16d) weather forecast
router.get("/forecast", optionalAuthenticate, getForecast);

// 2. Sub-seasonal (Weeks 1-6) & Seasonal (Months 1-3) climate outlook
router.get("/outlook", optionalAuthenticate, getOutlook);

// 3. Deterministic Agricultural Risk Alerts (BMD thresholds + official bulletins)
router.get("/alerts", optionalAuthenticate, getAlerts);

// 4. Integrated Crop Planning & Operational Advisories
router.get("/crop-planning", optionalAuthenticate, getCropPlanning);

// 5. Authenticated Admin Official Warning Verification Workflow
router.post("/admin/warnings", authenticate, requireRole("admin"), createAdminWarningDraft);
router.patch("/admin/warnings/:id/verify", authenticate, requireRole("admin"), verifyAdminWarning);
router.patch("/admin/warnings/:id/revoke", authenticate, requireRole("admin"), revokeAdminWarning);
router.get("/admin/warnings", authenticate, requireRole("admin"), listAdminWarnings);

export default router;
