/**
 * Krishi Mama AI Assistant Controller.
 * Handles POST /api/v1/assistant/chat and conversation lifecycle management.
 * Enforces authenticated user data isolation and supports ephemeral guest mode.
 */

import mongoose from "mongoose";
import { assistantChatService } from "../services/ai/chat.service.js";
import { Conversation } from "../models/conversation.model.js";
import { Farm } from "../models/farm.model.js";
import { errorResponse, successResponse } from "../utils/response.js";

/**
 * Generate a clean, natural conversation title from the first message.
 */
function generateTitle(text) {
  if (!text) return "কৃষি আলোচনা";
  const clean = text.replace(/[\r\n]+/g, " ").trim();
  if (clean.length <= 42) return clean;
  return `${clean.slice(0, 42).trim()}...`;
}

/**
 * POST /api/v1/assistant/chat
 * Accepts:
 * {
 *   "message": "কুমিল্লায় আমন ধান কাটার পর সরিষা কখন বপন করা ভালো?",
 *   "district": "cumilla",
 *   "crop": "mustard",
 *   "conversationId": "optional-id"
 * }
 */
export async function chatWithAssistant(req, res, next) {
  try {
    const { message, district, crop, farmId, conversationId } = req.body || {};

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return errorResponse(
        res,
        400,
        "Request body must include a non-empty 'message' string.",
        "MISSING_MESSAGE"
      );
    }

    if (message.trim().length > 1000) {
      return errorResponse(
        res,
        400,
        "Message exceeds the 1000 characters limit.",
        "MESSAGE_TOO_LONG"
      );
    }

    const trimmedMessage = message.trim();
    const currentUser = req.user || null;

    // 1. Authenticated User flow with MongoDB persistence
    if (currentUser) {
      let activeConversation = null;
      let customHistory = [];
      let verifiedFarm = null;

      if (farmId && mongoose.Types.ObjectId.isValid(farmId)) {
        verifiedFarm = await Farm.findOne({
          _id: farmId,
          userId: currentUser._id,
        }).lean();
      }

      // If conversationId is provided, verify it belongs to this user
      if (conversationId) {
        if (mongoose.Types.ObjectId.isValid(conversationId)) {
          activeConversation = await Conversation.findOne({
            _id: conversationId,
            userId: currentUser._id,
          });

          // If ID was supplied but does not belong to this user -> refuse IDOR tampering
          if (!activeConversation) {
            return errorResponse(
              res,
              404,
              "Conversation not found or access denied.",
              "CONVERSATION_NOT_FOUND"
            );
          }

          // If conversation had farmId and request didn't supply one, inherit it
          if (!verifiedFarm && activeConversation.farmId) {
            verifiedFarm = await Farm.findOne({
              _id: activeConversation.farmId,
              userId: currentUser._id,
            }).lean();
          }

          // Build history for Gemini from saved messages
          customHistory = activeConversation.messages.slice(-6).map((m) => ({
            role: m.role === "user" ? "user" : "model",
            parts: [{ text: m.content }],
          }));
        }
      }

      const effectiveDistrict = district || verifiedFarm?.location?.districtCode || "cumilla";
      const effectiveCrop = crop || verifiedFarm?.crop?.cropCode || null;

      // Execute AI chat resolution
      const result = await assistantChatService.handleChat({
        message: trimmedMessage,
        district: effectiveDistrict,
        crop: effectiveCrop,
        farmId: verifiedFarm ? verifiedFarm._id.toString() : null,
        userId: currentUser._id.toString(),
        conversationId: activeConversation?._id?.toString() || null,
        customHistory,
      });

      const userTurn = {
        role: "user",
        content: trimmedMessage,
        timestamp: new Date(),
      };

      const assistantTurn = {
        role: "assistant",
        content: result.answer,
        sources: result.sources || [],
        dataDate: result.dataDate || null,
        dataQuality: result.dataQuality || null,
        provenance: result.provenance || [],
        limitations: result.limitations || [],
        timestamp: new Date(),
      };

      if (activeConversation) {
        // Append turns to existing conversation
        activeConversation.messages.push(userTurn);
        activeConversation.messages.push(assistantTurn);
        if (effectiveDistrict) activeConversation.district = effectiveDistrict;
        if (effectiveCrop) activeConversation.crop = effectiveCrop;
        if (verifiedFarm) activeConversation.farmId = verifiedFarm._id;
        await activeConversation.save();
      } else {
        // Create new conversation document
        const title = generateTitle(trimmedMessage);
        activeConversation = await Conversation.create({
          userId: currentUser._id,
          title,
          district: effectiveDistrict,
          crop: effectiveCrop || "all",
          farmId: verifiedFarm ? verifiedFarm._id : null,
          messages: [userTurn, assistantTurn],
        });
      }

      return successResponse(
        res,
        200,
        {
          ...result,
          conversationId: activeConversation._id.toString(),
          title: activeConversation.title,
          farmId: activeConversation.farmId?.toString() || null,
          isGuest: false,
        },
        { timestamp: new Date().toISOString() }
      );
    }

    // 2. Guest User flow (ephemeral session, no permanent DB write)
    const result = await assistantChatService.handleChat({
      message: trimmedMessage,
      district,
      crop,
      conversationId,
    });

    return successResponse(
      res,
      200,
      {
        ...result,
        isGuest: true,
        guestNotice: "অতিথি মোডে চ্যাট হিস্ট্রি সাময়িক। স্থায়ী সংরক্ষণের জন্য লগইন বা রেজিস্ট্রেশন করুন।",
      },
      { timestamp: new Date().toISOString() }
    );
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/assistant/conversations
 * List authenticated user's conversations (most recent first).
 */
export async function listConversations(req, res, next) {
  try {
    const userId = req.user._id;
    const conversations = await Conversation.find({ userId })
      .sort({ updatedAt: -1 })
      .limit(50)
      .select("_id title district crop updatedAt createdAt messages");

    const formatted = conversations.map((c) => {
      const lastMsg = c.messages[c.messages.length - 1];
      return {
        _id: c._id,
        title: c.title,
        district: c.district,
        crop: c.crop,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
        messageCount: c.messages.length,
        lastMessage: lastMsg ? lastMsg.content.slice(0, 80) : "",
      };
    });

    return successResponse(res, 200, {
      conversations: formatted,
      total: formatted.length,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/assistant/conversations/:id
 * Retrieve a specific conversation with all its messages.
 * Enforces ownership: returns 404 if not found or belongs to another user.
 */
export async function getConversation(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    }

    const conversation = await Conversation.findOne({
      _id: id,
      userId: req.user._id,
    });

    if (!conversation) {
      return errorResponse(res, 404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    }

    return successResponse(res, 200, { conversation });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/v1/assistant/conversations/:id
 * Rename a conversation title.
 * Enforces ownership: returns 404 if not found or belongs to another user.
 */
export async function renameConversation(req, res, next) {
  try {
    const { id } = req.params;
    const { title } = req.body || {};

    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return errorResponse(res, 400, "Title cannot be empty.", "INVALID_TITLE");
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    }

    const conversation = await Conversation.findOneAndUpdate(
      { _id: id, userId: req.user._id },
      { $set: { title: title.trim().slice(0, 120) } },
      { new: true }
    );

    if (!conversation) {
      return errorResponse(res, 404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    }

    return successResponse(res, 200, { conversation });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/assistant/conversations/:id
 * Delete a conversation.
 * Enforces ownership: returns 404 if not found or belongs to another user.
 */
export async function deleteConversation(req, res, next) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    }

    const result = await Conversation.findOneAndDelete({
      _id: id,
      userId: req.user._id,
    });

    if (!result) {
      return errorResponse(res, 404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    }

    return successResponse(res, 200, {
      deletedId: id,
      message: "Conversation deleted successfully.",
    });
  } catch (err) {
    next(err);
  }
}
