import test from "node:test";
import assert from "node:assert/strict";
import { Farm } from "../src/models/farm.model.js";
import { FarmActivity } from "../src/models/farmactivity.model.js";
import { FarmNotification } from "../src/models/farmnotification.model.js";
import { getFarmActivities, getNotificationReadiness, updateActivity, deleteActivity } from "../src/services/farmactivity.service.js";
import { FarmNotificationService } from "../src/services/farmnotification.service.js";
import { getFarmById, getFarmLifecycle, updateFarm, deleteFarm } from "../src/controllers/farm.controller.js";
import { authenticate } from "../src/middleware/auth.middleware.js";
import { ownedFarmFilter, ownedActivityFilter } from "../src/security/farm-ownership.js";
import { validateCreateFarmInput, validateUpdateFarmInput } from "../src/validators/farm.validator.js";
import { validateCreateActivityInput, validateUpdateActivityInput } from "../src/validators/farmactivity.validator.js";
import { toolExecutors } from "../src/services/ai/tools.executor.js";

const ownerId = "64b000000000000000000001";
const otherUserId = "64b000000000000000000002";
const farmId = "64b000000000000000000010";
const activityId = "64b000000000000000000020";

test("owner access is scoped by the authenticated user and succeeds", async (t) => {
  let queriedFarmFilter;
  t.mock.method(Farm, "findOne", async (filter) => {
    queriedFarmFilter = filter;
    return filter.userId.toString() === ownerId ? { _id: farmId, farmName: "Owner farm" } : null;
  });
  t.mock.method(FarmActivity, "find", () => ({ sort: () => ({ lean: async () => [] }) }));
  t.mock.method(FarmActivity, "aggregate", async () => []);

  const result = await getFarmActivities(farmId, ownerId);
  assert.equal(result.success, true);
  assert.equal(queriedFarmFilter._id.toString(), farmId);
  assert.equal(queriedFarmFilter.userId.toString(), ownerId);
});

test("a different authenticated user cannot read another owner's farm activities", async (t) => {
  let activityRead = false;
  t.mock.method(Farm, "findOne", async (filter) =>
    filter.userId.toString() === ownerId ? { _id: farmId } : null
  );
  t.mock.method(FarmActivity, "find", () => {
    activityRead = true;
    return { sort: () => ({ lean: async () => [] }) };
  });

  const result = await getFarmActivities(farmId, otherUserId);
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.code, "FARM_NOT_FOUND");
  assert.equal(activityRead, false);
});

test("cross-user activity update is denied before loading or saving the activity", async (t) => {
  let activityRead = false;
  t.mock.method(Farm, "findOne", async () => null);
  t.mock.method(FarmActivity, "findOne", async () => {
    activityRead = true;
    return null;
  });

  const result = await updateActivity(farmId, activityId, otherUserId, { status: "COMPLETED" });
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 404);
  assert.equal(activityRead, false);
});

test("cross-user activity deletion is denied before deleting anything", async (t) => {
  let activityRead = false;
  let deleteCalled = false;
  t.mock.method(Farm, "findOne", async () => null);
  t.mock.method(FarmActivity, "findOne", async () => {
    activityRead = true;
    return null;
  });
  t.mock.method(FarmActivity, "deleteOne", async () => {
    deleteCalled = true;
    return { deletedCount: 1 };
  });

  const result = await deleteActivity(farmId, activityId, otherUserId);
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 404);
  assert.equal(activityRead, false);
  assert.equal(deleteCalled, false);
});

test("cross-user farm update is denied and cannot save the foreign farm", async (t) => {
  let query;
  t.mock.method(Farm, "findOne", (filter) => {
    query = filter;
    return null;
  });
  const res = responseRecorder();

  await updateFarm({ user: { _id: otherUserId }, params: { id: farmId }, body: { farmName: "Changed" } }, res, assert.fail);
  assert.equal(res.statusCode, 404);
  assert.equal(query.userId.toString(), otherUserId);
});

test("farm detail and lifecycle reads query by both resource ID and authenticated owner", async (t) => {
  const queries = [];
  t.mock.method(Farm, "findOne", (filter) => {
    queries.push(filter);
    return { lean: async () => null };
  });
  const detailRes = responseRecorder();
  const lifecycleRes = responseRecorder();

  await getFarmById({ user: { _id: otherUserId }, params: { id: farmId } }, detailRes, assert.fail);
  await getFarmLifecycle({ user: { _id: otherUserId }, params: { id: farmId }, query: {} }, lifecycleRes, assert.fail);

  assert.equal(detailRes.statusCode, 404);
  assert.equal(lifecycleRes.statusCode, 404);
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.equal(query._id.toString(), farmId);
    assert.equal(query.userId.toString(), otherUserId);
  }
});

test("cross-user farm delete is denied before farm or activity deletion", async (t) => {
  let query;
  let farmDeleteCalled = false;
  let activityDeleteCalled = false;
  t.mock.method(Farm, "findOne", (filter) => {
    query = filter;
    return null;
  });
  t.mock.method(Farm, "deleteOne", async () => { farmDeleteCalled = true; });
  t.mock.method(FarmActivity, "deleteMany", async () => { activityDeleteCalled = true; });
  const res = responseRecorder();

  await deleteFarm({ user: { _id: otherUserId }, params: { id: farmId } }, res, assert.fail);
  assert.equal(res.statusCode, 404);
  assert.equal(query.userId.toString(), otherUserId);
  assert.equal(farmDeleteCalled, false);
  assert.equal(activityDeleteCalled, false);
});

test("farm-filtered notification mutation requires ownership of that farm", async (t) => {
  let updateCalled = false;
  t.mock.method(Farm, "exists", async (filter) => {
    assert.equal(filter._id.toString(), farmId);
    assert.equal(filter.userId.toString(), otherUserId);
    return null;
  });
  t.mock.method(FarmNotification, "updateMany", async () => {
    updateCalled = true;
    return { modifiedCount: 1 };
  });

  const result = await FarmNotificationService.markAllAsRead(otherUserId, farmId);
  assert.equal(result.success, false);
  assert.equal(result.modifiedCount, 0);
  assert.equal(updateCalled, false);
});

test("notification read updates include authenticated user and only owned farm IDs", async (t) => {
  let updateFilter;
  t.mock.method(Farm, "find", () => ({
    select: () => ({ lean: async () => [{ _id: { toString: () => farmId, equals: (other) => other.toString() === farmId } }] }),
  }));
  t.mock.method(FarmNotification, "findOneAndUpdate", async (filter) => {
    updateFilter = filter;
    return { _id: "notice", userId: ownerId };
  });

  await FarmNotificationService.markAsRead(ownerId, "64b000000000000000000030");
  assert.equal(updateFilter.userId, ownerId);
  assert.deepEqual(updateFilter.farmId.$in.map(String), [farmId]);
});

test("assistant farm tools reject guest-supplied farm IDs without querying the farm", async (t) => {
  let farmQueryCalled = false;
  t.mock.method(Farm, "findOne", async () => {
    farmQueryCalled = true;
    return { _id: farmId, userId: ownerId };
  });

  const result = await toolExecutors.getMyFarmDetails({ farmId, userId: null });
  assert.match(result.error, /FARM_ACCESS_DENIED/);
  assert.equal(farmQueryCalled, false);
});

test("assistant weather tools reject a model-supplied farm ID for guests before provider calls", async (t) => {
  let farmQueryCalled = false;
  t.mock.method(Farm, "findOne", async () => {
    farmQueryCalled = true;
    return null;
  });

  const forecastResult = await toolExecutors.getLocationWeatherForecast({ farmId, userId: null });
  const alertResult = await toolExecutors.getActiveWeatherAlerts({ farmId, userId: null });
  assert.match(forecastResult.error, /FARM_ACCESS_DENIED/);
  assert.match(alertResult.error, /FARM_ACCESS_DENIED/);
  assert.equal(farmQueryCalled, false);
});

test("assistant farm tools deny another user's farm using an owner-scoped DB query", async (t) => {
  let query;
  t.mock.method(Farm, "findOne", (filter) => {
    query = filter;
    return { lean: async () => null };
  });

  const result = await toolExecutors.getMyFarmDetails({ farmId, userId: otherUserId });
  assert.match(result.error, /FARM_NOT_FOUND/);
  assert.equal(query._id.toString(), farmId);
  assert.equal(query.userId.toString(), otherUserId);
});

test("assistant activity lookup filters activity rows by both farm and authenticated owner", async (t) => {
  let farmFilter;
  let activityFilter;
  const farm = {
    _id: { toString: () => farmId },
    userId: { toString: () => ownerId },
    farmName: "Owner farm",
  };
  t.mock.method(Farm, "findOne", (filter) => {
    farmFilter = filter;
    return { lean: async () => farm };
  });
  t.mock.method(FarmActivity, "find", (filter) => {
    activityFilter = filter;
    return {
      sort: () => ({ limit: () => ({ lean: async () => [] }) }),
    };
  });

  const result = await toolExecutors.getMyFarmActivities({ farmId, userId: ownerId });
  assert.equal(result.farmName, "Owner farm");
  assert.equal(farmFilter.userId.toString(), ownerId);
  assert.equal(activityFilter.userId.toString(), ownerId);
  assert.equal(activityFilter.farmId.toString(), farmId);
});

test("activity notification readiness populates only farms owned by the authenticated user", async (t) => {
  let activityFilter;
  t.mock.method(Farm, "find", () => ({
    select: () => ({ lean: async () => [{ _id: { toString: () => farmId } }] }),
  }));
  t.mock.method(FarmActivity, "find", (filter) => {
    activityFilter = filter;
    return {
      populate: () => ({ sort: () => ({ lean: async () => [] }) }),
    };
  });

  await getNotificationReadiness(ownerId);
  assert.equal(activityFilter.userId, ownerId);
  assert.deepEqual(activityFilter.farmId.$in.map(String), [farmId]);
});

test("missing authenticated identity produces no owner-scoped query", async (t) => {
  let farmQueryCalled = false;
  t.mock.method(Farm, "findOne", async () => {
    farmQueryCalled = true;
    return null;
  });

  assert.equal(ownedFarmFilter(farmId, null), null);
  assert.equal(ownedActivityFilter(farmId, activityId, undefined), null);
  const result = await getFarmActivities(farmId, undefined);
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 401);
  assert.equal(farmQueryCalled, false);
});

test("unauthenticated HTTP requests are rejected by the farm auth middleware", async () => {
  let statusCode;
  let responseBody;
  let nextCalled = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  await authenticate({ cookies: {}, headers: {} }, res, () => { nextCalled = true; });
  assert.equal(statusCode, 401);
  assert.equal(responseBody.error.code, "UNAUTHORIZED");
  assert.equal(nextCalled, false);
});

test("client-supplied owner and resource IDs are rejected and cannot change owner filters", () => {
  assert.equal(validateCreateFarmInput({ userId: otherUserId }).isValid, false);
  assert.equal(validateUpdateFarmInput({ userId: otherUserId }).isValid, false);
  assert.equal(validateCreateActivityInput({
    title: "Task",
    scheduledDate: "2026-11-10",
    farmId,
    userId: otherUserId,
  }).isValid, false);
  assert.equal(validateUpdateActivityInput({ userId: otherUserId, farmId }).isValid, false);

  const filter = ownedFarmFilter(farmId, ownerId);
  assert.equal(filter.userId.toString(), ownerId);
  assert.notEqual(filter.userId.toString(), otherUserId);
  assert.equal(ownedFarmFilter(farmId, otherUserId).userId.toString(), otherUserId);
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
