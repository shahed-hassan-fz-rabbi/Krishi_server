import { Router } from "express";
import rateLimit from "express-rate-limit";

import {
  register,
  login,
  getMe,
  logout,
  updateProfile,
} from "../../controllers/auth.controller.js";
import { authenticate } from "../../middleware/auth.middleware.js";
import { env } from "../../config/env.config.js";

const router = Router();

// Sensible rate limiting for authentication attempts (skipped in test mode)
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.nodeEnv === "test",
  message: {
    success: false,
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many authentication requests, please try again later",
    },
  },
});

router.post("/register", authRateLimiter, register);
router.post("/login", authRateLimiter, login);
router.get("/me", authenticate, getMe);
router.post("/logout", logout);
router.patch("/profile", authenticate, updateProfile);

export default router;
