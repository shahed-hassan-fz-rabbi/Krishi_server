import mongoose from "mongoose";

export function isAuthenticatedOwnerId(authenticatedUserId) {
  return Boolean(
    authenticatedUserId && mongoose.Types.ObjectId.isValid(authenticatedUserId)
  );
}

/**
 * Build an owner-scoped farm filter from authenticated identity and a resource ID.
 * Returns null for missing/invalid identity or resource identifiers so callers
 * cannot accidentally issue a query with an omitted userId predicate.
 */
export function ownedFarmFilter(farmId, authenticatedUserId) {
  if (
    !farmId ||
    !isAuthenticatedOwnerId(authenticatedUserId) ||
    !mongoose.Types.ObjectId.isValid(farmId) ||
    !mongoose.Types.ObjectId.isValid(authenticatedUserId)
  ) {
    return null;
  }

  return {
    _id: new mongoose.Types.ObjectId(farmId),
    userId: new mongoose.Types.ObjectId(authenticatedUserId),
  };
}

/** Build an activity filter scoped to its farm and authenticated owner. */
export function ownedActivityFilter(farmId, activityId, authenticatedUserId) {
  const farmFilter = ownedFarmFilter(farmId, authenticatedUserId);
  if (!farmFilter || !activityId || !mongoose.Types.ObjectId.isValid(activityId)) {
    return null;
  }

  return {
    _id: new mongoose.Types.ObjectId(activityId),
    farmId: farmFilter._id,
    userId: farmFilter.userId,
  };
}

/** Explicitly reject ownership/resource identifiers in writable payloads. */
export function ownershipPayloadErrors(body = {}, allowedResourceIds = []) {
  return Object.keys(body)
    .filter((field) => /^(?:_?id|farmid|owner(?:id|userid)?|user(?:id)?|createdby(?:id)?)$/i.test(field))
    .filter((field) => !allowedResourceIds.includes(field))
    .map((field) => ({
      field,
      message: "Ownership and resource identifiers are controlled by the authenticated request.",
    }));
}
