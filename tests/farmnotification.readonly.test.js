import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Farm } from "../src/models/farm.model.js";
import { FarmActivity } from "../src/models/farmactivity.model.js";
import { FarmNotification } from "../src/models/farmnotification.model.js";
import { FarmNotificationService } from "../src/services/farmnotification.service.js";

test("farm activity notifications are scoped to active tasks and their current dates", async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const farmId = new mongoose.Types.ObjectId();
  const activityId = new mongoose.Types.ObjectId();
  let capturedFilter;

  t.mock.method(Farm, "find", () => ({
    select() { return this; },
    lean: async () => [{ _id: farmId }],
  }));
  t.mock.method(FarmActivity, "find", () => ({
    select() { return this; },
    lean: async () => [{ _id: activityId, scheduledDate: "2026-11-12" }],
  }));
  t.mock.method(FarmNotificationService, "syncUserNotifications", async () => ({ syncedCount: 0 }));
  t.mock.method(FarmNotification, "find", (filter) => {
    capturedFilter = filter;
    return {
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      populate() { return this; },
      lean: async () => [],
    };
  });
  t.mock.method(FarmNotification, "countDocuments", async () => 0);

  await FarmNotificationService.getNotifications(userId);
  const activityTypes = ["ACTIVITY_UPCOMING", "ACTIVITY_DUE_TODAY", "ACTIVITY_OVERDUE"];
  const currentTaskClause = capturedFilter.$and.find((item) => item.$or)?.$or;
  assert.ok(currentTaskClause.some((item) => item.type?.$nin?.join(",") === activityTypes.join(",")));
  assert.ok(currentTaskClause.some((item) => item.activityId?.equals(activityId) && item.scheduledFor === "2026-11-12"));
});
