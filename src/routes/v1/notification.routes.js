/**
 * Notification Routes.
 * Mounted at /api/v1/notifications.
 * Requires authentication for all endpoints.
 */

import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware.js";
import {
  deleteNotification,
  getNotifications,
  getUnreadCount,
  markAllAsRead,
  markAsRead,
} from "../../controllers/farmnotification.controller.js";

const router = Router();

router.use(authenticate);

router.get("/", getNotifications);
router.get("/unread-count", getUnreadCount);
router.patch("/read-all", markAllAsRead);
router.patch("/:id/read", markAsRead);
router.delete("/:id", deleteNotification);

export default router;
