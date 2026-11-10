/**
 * Farm Activity Validator.
 * Enforces field validations and allowable enums for farm activities.
 */

import {
  VALID_ACTIVITY_TYPES,
  VALID_ACTIVITY_STATUSES,
} from "../models/farmactivity.model.js";
import { ownershipPayloadErrors } from "../security/farm-ownership.js";

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates custom activity creation input.
 */
export function validateCreateActivityInput(body = {}) {
  const errors = ownershipPayloadErrors(body);

  // Title
  const title = (body.title || "").trim();
  if (!title) {
    errors.push({ field: "title", message: "Activity title is required." });
  } else if (title.length < 2) {
    errors.push({ field: "title", message: "Activity title must be at least 2 characters long." });
  } else if (title.length > 200) {
    errors.push({ field: "title", message: "Activity title cannot exceed 200 characters." });
  }

  // Scheduled Date
  const scheduledDate = (body.scheduledDate || "").trim();
  if (!scheduledDate) {
    errors.push({ field: "scheduledDate", message: "Scheduled date is required." });
  } else if (!ISO_DATE_REGEX.test(scheduledDate)) {
    errors.push({ field: "scheduledDate", message: "Scheduled date must follow YYYY-MM-DD format." });
  } else {
    const d = new Date(scheduledDate);
    if (isNaN(d.getTime())) {
      errors.push({ field: "scheduledDate", message: "Scheduled date is an invalid calendar date." });
    }
  }

  // Activity Type
  if (body.activityType) {
    const type = String(body.activityType).trim().toLowerCase();
    if (!VALID_ACTIVITY_TYPES.includes(type)) {
      errors.push({
        field: "activityType",
        message: `Invalid activity type '${body.activityType}'. Allowed: ${VALID_ACTIVITY_TYPES.join(", ")}.`,
      });
    }
  }

  // Description
  if (body.description && String(body.description).length > 1000) {
    errors.push({ field: "description", message: "Description cannot exceed 1000 characters." });
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validates activity update input.
 */
export function validateUpdateActivityInput(body = {}) {
  const errors = ownershipPayloadErrors(body);

  if (body.status !== undefined) {
    const status = String(body.status).trim().toUpperCase();
    if (!VALID_ACTIVITY_STATUSES.includes(status)) {
      errors.push({
        field: "status",
        message: `Invalid status '${body.status}'. Allowed: ${VALID_ACTIVITY_STATUSES.join(", ")}.`,
      });
    }
  }

  if (body.scheduledDate !== undefined) {
    const scheduledDate = String(body.scheduledDate).trim();
    if (!ISO_DATE_REGEX.test(scheduledDate)) {
      errors.push({ field: "scheduledDate", message: "Scheduled date must follow YYYY-MM-DD format." });
    } else {
      const d = new Date(scheduledDate);
      if (isNaN(d.getTime())) {
        errors.push({ field: "scheduledDate", message: "Scheduled date is an invalid calendar date." });
      }
    }
  }

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (title.length < 2) {
      errors.push({ field: "title", message: "Activity title must be at least 2 characters long." });
    } else if (title.length > 200) {
      errors.push({ field: "title", message: "Activity title cannot exceed 200 characters." });
    }
  }

  if (body.activityType !== undefined) {
    const type = String(body.activityType).trim().toLowerCase();
    if (!VALID_ACTIVITY_TYPES.includes(type)) {
      errors.push({
        field: "activityType",
        message: `Invalid activity type '${body.activityType}'. Allowed: ${VALID_ACTIVITY_TYPES.join(", ")}.`,
      });
    }
  }

  if (body.completionNote !== undefined && String(body.completionNote).length > 1000) {
    errors.push({ field: "completionNote", message: "Completion note cannot exceed 1000 characters." });
  }

  if (body.description !== undefined && String(body.description).length > 1000) {
    errors.push({ field: "description", message: "Description cannot exceed 1000 characters." });
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
