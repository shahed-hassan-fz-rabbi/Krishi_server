/**
 * Assistant Routes — /api/v1/assistant
 * Handles conversational assistant interactions and authenticated chat history.
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  chatWithAssistant,
  listConversations,
  getConversation,
  renameConversation,
  deleteConversation,
} from "../../controllers/assistant.controller.js";
import { authenticate, optionalAuthenticate } from "../../middleware/auth.middleware.js";
import { env } from "../../config/env.config.js";

const router = Router();

const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 40, // 40 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.nodeEnv === "test",
  message: {
    success: false,
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many assistant chat requests. Please slow down.",
    },
  },
});

// Conversations Management (Authenticated)
router.get("/conversations", authenticate, listConversations);
router.get("/conversations/:id", authenticate, getConversation);
router.patch("/conversations/:id", authenticate, renameConversation);
router.delete("/conversations/:id", authenticate, deleteConversation);

// Conversational Chat (Optional Authenticate - supports both persistent user & guest)
router.post("/chat", chatRateLimiter, optionalAuthenticate, chatWithAssistant);

export default router;
