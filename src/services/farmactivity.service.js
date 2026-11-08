/**
 * Farm Activity Service.
 * Manages agricultural activities, task generation from official crop lifecycle templates,
 * task state transitions, and farm activity tracking.
 *
 * Scientific & Architectural Principles:
 * - Tasks generated from official templates strictly reference BAMIS/DAE source documents.
 * - No fabricated chemical fertilizer dosages or speculative pesticide brands.
 * - No automatic status changes based solely on elapsed dates (farmer retains control).
 * - Multi-tenant isolation: all operations require authenticated user ownership.
 */

import mongoose from "mongoose";
import { Farm } from "../models/farm.model.js";
import {
  FarmActivity,
  VALID_ACTIVITY_TYPES,
  VALID_ACTIVITY_STATUSES,
} from "../models/farmactivity.model.js";
import { generateFarmLifecycleTimeline } from "./croplifecycle.service.js";

/**
 * Pure date addition helper using UTC midnight.
 */
function addDaysUtc(isoDateStr, daysToAdd) {
  const [y, m, d] = isoDateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  return date.toISOString().split("T")[0];
}

/**
 * Automatically generates grounded activities from official crop lifecycle templates.
 * Skips already-generated tasks and preserves custom farmer tasks.
 *
 * @param {string|mongoose.Types.ObjectId} farmId
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<Object>}
 */
export async function generateActivitiesForFarm(farmId, userId) {
  const farm = await Farm.findOne({ _id: farmId, userId });
  if (!farm) {
    return {
      success: false,
      statusCode: 404,
      error: "Farm not found or access denied",
      code: "FARM_NOT_FOUND",
    };
  }

  const plantingDate = farm.crop?.plantingDate ? String(farm.crop.plantingDate).trim() : null;
  if (!plantingDate || !/^\d{4}-\d{2}-\d{2}$/.test(plantingDate)) {
    return {
      success: false,
      statusCode: 400,
      error: "Farm does not have a valid planting date (YYYY-MM-DD) required for activity scheduling",
      code: "MISSING_PLANTING_DATE",
    };
  }

  const timelineResult = generateFarmLifecycleTimeline(farm);
  if (!timelineResult.success || !timelineResult.data) {
    return {
      success: false,
      statusCode: 400,
      error: timelineResult.error || "Failed to generate lifecycle timeline for crop",
      code: "LIFECYCLE_TIMELINE_FAILED",
    };
  }

  const timeline = timelineResult.data;
  const stages = timeline.stages || [];
  const sourceMeta = {
    documentTitle: timeline.provenance?.sourceDocumentTitle || "Official Crop Calendar",
    publisher: timeline.provenance?.sourcePublisher || "BAMIS / DAE",
    url: timeline.provenance?.sourceDocumentUrl || "https://www.bamis.gov.bd",
  };

  const candidateActivities = [];

  for (const stg of stages) {
    const stageCode = stg.stageCode;
    const stageNameEn = stg.stageNameEn;
    const stageNameBn = stg.stageNameBn;
    const startDate = stg.estimatedStartDate;
    const endDate = stg.estimatedEndDate;
    const durationDays = stg.durationDays || 20;

    if (!startDate) continue;

    // 1. Primary agronomic practice task
    let primaryType = "general_management";
    let primaryTitle = `${stageNameEn} - Primary Field Activity`;
    let primaryDesc = `Conduct standard field operations for ${stageNameEn} according to regional DAE crop calendar.`;

    if (stageCode.includes("seedbed") || stageCode.includes("sowing")) {
      primaryType = "sowing";
      primaryTitle = `Seedbed Preparation & Sowing (${stageNameEn})`;
      primaryDesc = `Prepare nursery seedbed or sow seeds according to official ${timeline.crop.cropNameEn} guidelines.`;
    } else if (stageCode.includes("transplanting")) {
      primaryType = "transplanting";
      primaryTitle = `Field Transplanting (${stageNameEn})`;
      primaryDesc = `Transplant seedlings to main puddled field within the recommended seasonal window.`;
    } else if (stageCode.includes("tillering") || stageCode.includes("branching")) {
      primaryType = "general_management";
      primaryTitle = `Tillering & Vegetative Growth Inspection (${stageNameEn})`;
      primaryDesc = `Inspect vegetative tillers and ensure suitable soil water saturation.`;
    } else if (stageCode.includes("flowering") || stageCode.includes("panicle") || stageCode.includes("podding")) {
      primaryType = "pest_scouting";
      primaryTitle = `Flowering & Panicle Health Scouting (${stageNameEn})`;
      primaryDesc = `Monitor crop health during flowering. Guard against floret damage and excessive moisture stress.`;
    } else if (stageCode.includes("harvest") || stageCode.includes("maturation") || stageCode.includes("ripening")) {
      primaryType = "harvesting";
      primaryTitle = `Crop Maturity Assessment & Harvesting (${stageNameEn})`;
      primaryDesc = `Inspect grain maturity and complete harvesting in dry weather conditions.`;
    }

    candidateActivities.push({
      farmId: farm._id,
      userId: farm.userId,
      title: primaryTitle,
      description: primaryDesc,
      activityType: primaryType,
      relatedStageCode: stageCode,
      scheduledDate: startDate,
      status: "PENDING",
      sourceType: "OFFICIAL_GUIDANCE",
      sourceReferences: {
        ...sourceMeta,
        stageNameEn,
        stageNameBn,
      },
      isCustom: false,
      generatedKey: `${farm._id}_${stageCode}_primary`,
    });

    // 2. Stage Water Requirement & Monitoring Check
    if (stg.waterRequirementMm && stg.waterRequirementMm > 0) {
      const midOffset = Math.max(1, Math.floor(durationDays / 2));
      const waterCheckDate = addDaysUtc(startDate, midOffset);

      candidateActivities.push({
        farmId: farm._id,
        userId: farm.userId,
        title: `Water Requirement & Moisture Check (${stageNameEn})`,
        description: `Official BAMIS stage water requirement is ${stg.waterRequirementMm} mm. Monitor field moisture and provide supplemental irrigation if soil drying occurs.`,
        activityType: "irrigation_monitoring",
        relatedStageCode: stageCode,
        scheduledDate: waterCheckDate,
        status: "PENDING",
        sourceType: "OFFICIAL_GUIDANCE",
        sourceReferences: {
          ...sourceMeta,
          stageNameEn,
          stageNameBn,
        },
        isCustom: false,
        generatedKey: `${farm._id}_${stageCode}_water_check`,
      });
    }

    // 3. Agro-climatic Hazard & Weather Stress Vigilance
    if (stg.weatherHazards && String(stg.weatherHazards).trim().length > 0) {
      candidateActivities.push({
        farmId: farm._id,
        userId: farm.userId,
        title: `Weather Hazard & Stress Vigilance (${stageNameEn})`,
        description: `Official BAMIS agro-climatic hazard advisory: ${stg.weatherHazards}`,
        activityType: "pest_scouting",
        relatedStageCode: stageCode,
        scheduledDate: startDate,
        status: "PENDING",
        sourceType: "OFFICIAL_GUIDANCE",
        sourceReferences: {
          ...sourceMeta,
          stageNameEn,
          stageNameBn,
        },
        isCustom: false,
        generatedKey: `${farm._id}_${stageCode}_hazard_vigilance`,
      });
    }
  }

  // Deduplicate against existing activities using generatedKey
  const generatedKeys = candidateActivities.map((c) => c.generatedKey);
  const existingRecords = await FarmActivity.find({
    farmId: farm._id,
    generatedKey: { $in: generatedKeys },
  }).select("generatedKey");

  const existingKeySet = new Set(existingRecords.map((r) => r.generatedKey));
  const newActivities = candidateActivities.filter((c) => !existingKeySet.has(c.generatedKey));

  let inserted = [];
  if (newActivities.length > 0) {
    inserted = await FarmActivity.insertMany(newActivities);
  }

  return {
    success: true,
    data: {
      generatedCount: inserted.length,
      existingCount: existingKeySet.size,
      totalTemplateTasks: candidateActivities.length,
      newActivities,
    },
  };
}

/**
 * Retrieves activities for a farm with optional filters.
 *
 * @param {string|mongoose.Types.ObjectId} farmId
 * @param {string|mongoose.Types.ObjectId} userId
 * @param {Object} filters - { status, stageCode, activityType, limit }
 */
export async function getFarmActivities(farmId, userId, filters = {}) {
  const farm = await Farm.findOne({ _id: farmId, userId });
  if (!farm) {
    return {
      success: false,
      statusCode: 404,
      error: "Farm not found or access denied",
      code: "FARM_NOT_FOUND",
    };
  }

  const query = { farmId: farm._id, userId };

  if (filters.status) {
    const statuses = Array.isArray(filters.status)
      ? filters.status
      : [String(filters.status).toUpperCase()];
    query.status = { $in: statuses };
  }

  if (filters.stageCode) {
    query.relatedStageCode = String(filters.stageCode).trim();
  }

  if (filters.activityType) {
    query.activityType = String(filters.activityType).trim().toLowerCase();
  }

  const activities = await FarmActivity.find(query)
    .sort({ scheduledDate: 1, createdAt: 1 })
    .lean();

  // Summary aggregation
  const allCounts = await FarmActivity.aggregate([
    { $match: { farmId: farm._id, userId: new mongoose.Types.ObjectId(userId) } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const counts = {
    PENDING: 0,
    IN_PROGRESS: 0,
    COMPLETED: 0,
    SKIPPED: 0,
    TOTAL: 0,
  };

  for (const item of allCounts) {
    if (counts[item._id] !== undefined) {
      counts[item._id] = item.count;
      counts.TOTAL += item.count;
    }
  }

  return {
    success: true,
    data: {
      farmId: farm._id,
      farmName: farm.farmName,
      counts,
      activities,
    },
  };
}

/**
 * Retrieves a single activity by ID with ownership verification.
 */
export async function getActivityById(farmId, activityId, userId) {
  const farm = await Farm.findOne({ _id: farmId, userId });
  if (!farm) {
    return {
      success: false,
      statusCode: 404,
      error: "Farm not found or access denied",
      code: "FARM_NOT_FOUND",
    };
  }

  const activity = await FarmActivity.findOne({
    _id: activityId,
    farmId: farm._id,
    userId,
  }).lean();

  if (!activity) {
    return {
      success: false,
      statusCode: 404,
      error: "Activity not found or access denied",
      code: "ACTIVITY_NOT_FOUND",
    };
  }

  return {
    success: true,
    data: activity,
  };
}

/**
 * Creates a custom farmer-defined activity.
 */
export async function createCustomActivity(farmId, userId, inputData) {
  const farm = await Farm.findOne({ _id: farmId, userId });
  if (!farm) {
    return {
      success: false,
      statusCode: 404,
      error: "Farm not found or access denied",
      code: "FARM_NOT_FOUND",
    };
  }

  const newActivity = new FarmActivity({
    farmId: farm._id,
    userId,
    title: inputData.title.trim(),
    description: (inputData.description || "").trim(),
    activityType: (inputData.activityType || "general_management").toLowerCase(),
    relatedStageCode: (inputData.relatedStageCode || "").trim(),
    scheduledDate: inputData.scheduledDate.trim(),
    status: "PENDING",
    sourceType: "FARMER_CREATED",
    sourceReferences: {
      documentTitle: "Farmer Self-Reported Activity",
      publisher: "Farm Owner",
      url: "",
      stageNameEn: inputData.relatedStageCode || "",
      stageNameBn: "",
    },
    isCustom: true,
    generatedKey: null,
  });

  const saved = await newActivity.save();

  return {
    success: true,
    statusCode: 201,
    data: saved,
  };
}

/**
 * Updates an activity (status, note, rescheduled date, etc.).
 * Strictly enforces ownership and protects official guidance fields.
 */
export async function updateActivity(farmId, activityId, userId, updateData) {
  const farm = await Farm.findOne({ _id: farmId, userId });
  if (!farm) {
    return {
      success: false,
      statusCode: 404,
      error: "Farm not found or access denied",
      code: "FARM_NOT_FOUND",
    };
  }

  const activity = await FarmActivity.findOne({
    _id: activityId,
    farmId: farm._id,
    userId,
  });

  if (!activity) {
    return {
      success: false,
      statusCode: 404,
      error: "Activity not found or access denied",
      code: "ACTIVITY_NOT_FOUND",
    };
  }

  // Handle status update
  if (updateData.status !== undefined) {
    const newStatus = String(updateData.status).trim().toUpperCase();
    if (VALID_ACTIVITY_STATUSES.includes(newStatus)) {
      activity.status = newStatus;
      if (newStatus === "COMPLETED") {
        activity.completedAt = updateData.completedAt ? new Date(updateData.completedAt) : new Date();
      } else {
        activity.completedAt = null;
      }
    }
  }

  // Rescheduled date
  if (updateData.scheduledDate !== undefined) {
    activity.scheduledDate = String(updateData.scheduledDate).trim();
  }

  // Completion note
  if (updateData.completionNote !== undefined) {
    activity.completionNote = String(updateData.completionNote).trim();
  }

  // If custom, also allow editing title, description, activityType
  if (activity.isCustom) {
    if (updateData.title !== undefined) activity.title = String(updateData.title).trim();
    if (updateData.description !== undefined) activity.description = String(updateData.description).trim();
    if (updateData.activityType !== undefined) {
      const type = String(updateData.activityType).trim().toLowerCase();
      if (VALID_ACTIVITY_TYPES.includes(type)) activity.activityType = type;
    }
  }

  // Safety safeguard: never allow changing sourceType, generatedKey, or sourceReferences
  const saved = await activity.save();

  return {
    success: true,
    statusCode: 200,
    data: saved,
  };
}

/**
 * Deletes a farmer-created activity.
 * Rejects deletion of official guidance tasks (they may be marked SKIPPED instead).
 */
export async function deleteActivity(farmId, activityId, userId) {
  const farm = await Farm.findOne({ _id: farmId, userId });
  if (!farm) {
    return {
      success: false,
      statusCode: 404,
      error: "Farm not found or access denied",
      code: "FARM_NOT_FOUND",
    };
  }

  const activity = await FarmActivity.findOne({
    _id: activityId,
    farmId: farm._id,
    userId,
  });

  if (!activity) {
    return {
      success: false,
      statusCode: 404,
      error: "Activity not found or access denied",
      code: "ACTIVITY_NOT_FOUND",
    };
  }

  if (!activity.isCustom && activity.sourceType !== "FARMER_CREATED") {
    return {
      success: false,
      statusCode: 403,
      error: "Official guidance tasks cannot be deleted. You can mark them as SKIPPED instead.",
      code: "OFFICIAL_TASK_DELETE_FORBIDDEN",
    };
  }

  await FarmActivity.deleteOne({ _id: activity._id });

  return {
    success: true,
    statusCode: 200,
    data: { deletedId: activityId },
  };
}

/**
 * Aggregates user activity overview across all farms for the My Farm dashboard.
 */
export async function getUserActivityOverview(userId) {
  const farms = await Farm.find({ userId }).select("_id farmName location crop status").lean();
  if (!farms || farms.length === 0) {
    return {
      success: true,
      data: {
        hasFarms: false,
        todayActivities: [],
        upcomingActivities: [],
        overdueActivities: [],
        completedRecent: [],
        counts: {
          pending: 0,
          inProgress: 0,
          completed: 0,
          skipped: 0,
          todayTotal: 0,
          upcomingTotal: 0,
        },
        farmsWithUpcoming: 0,
      },
    };
  }

  const farmMap = new Map();
  for (const f of farms) {
    farmMap.set(String(f._id), f);
  }

  const farmIds = farms.map((f) => f._id);
  const todayStr = new Date().toISOString().split("T")[0];

  const activities = await FarmActivity.find({
    userId,
    farmId: { $in: farmIds },
  })
    .sort({ scheduledDate: 1, createdAt: 1 })
    .lean();

  const todayActivities = [];
  const upcomingActivities = [];
  const overdueActivities = [];
  const completedRecent = [];

  let pendingCount = 0;
  let inProgressCount = 0;
  let completedCount = 0;
  let skippedCount = 0;
  const farmsWithUpcomingSet = new Set();

  for (const act of activities) {
    const farmInfo = farmMap.get(String(act.farmId));
    const enrichedAct = {
      ...act,
      farmName: farmInfo?.farmName || "Farm",
      cropName: farmInfo?.crop?.cropName || "",
      district: farmInfo?.location?.district || "",
    };

    if (act.status === "PENDING") pendingCount++;
    else if (act.status === "IN_PROGRESS") inProgressCount++;
    else if (act.status === "COMPLETED") completedCount++;
    else if (act.status === "SKIPPED") skippedCount++;

    if (act.status === "COMPLETED") {
      if (completedRecent.length < 10) completedRecent.push(enrichedAct);
    } else if (act.status === "SKIPPED") {
      // omitted from active task lists
    } else {
      // PENDING or IN_PROGRESS
      if (act.scheduledDate === todayStr) {
        todayActivities.push(enrichedAct);
        farmsWithUpcomingSet.add(String(act.farmId));
      } else if (act.scheduledDate > todayStr) {
        if (upcomingActivities.length < 15) {
          upcomingActivities.push(enrichedAct);
        }
        farmsWithUpcomingSet.add(String(act.farmId));
      } else {
        // Scheduled date < todayStr
        overdueActivities.push(enrichedAct);
      }
    }
  }

  return {
    success: true,
    data: {
      hasFarms: true,
      todayStr,
      todayActivities,
      upcomingActivities,
      overdueActivities,
      completedRecent,
      counts: {
        pending: pendingCount,
        inProgress: inProgressCount,
        completed: completedCount,
        skipped: skippedCount,
        todayTotal: todayActivities.length,
        upcomingTotal: upcomingActivities.length,
      },
      farmsWithUpcoming: farmsWithUpcomingSet.size,
    },
  };
}

/**
 * Prepares notification readiness alerts for upcoming activities.
 * (Service boundary for future notification system; no SMS or email dispatched).
 */
export async function getNotificationReadiness(userId) {
  const todayStr = new Date().toISOString().split("T")[0];
  const next48h = addDaysUtc(todayStr, 2);

  const activities = await FarmActivity.find({
    userId,
    status: { $in: ["PENDING", "IN_PROGRESS"] },
    scheduledDate: { $gte: todayStr, $lte: next48h },
  })
    .populate("farmId", "farmName location crop")
    .sort({ scheduledDate: 1 })
    .lean();

  return {
    success: true,
    data: {
      asOfDate: todayStr,
      targetWindowEnd: next48h,
      alertCount: activities.length,
      alerts: activities.map((a) => ({
        activityId: a._id,
        farmId: a.farmId?._id,
        farmName: a.farmId?.farmName,
        title: a.title,
        scheduledDate: a.scheduledDate,
        status: a.status,
        activityType: a.activityType,
        sourceType: a.sourceType,
      })),
    },
  };
}
