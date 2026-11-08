import { verifyToken, SESSION_COOKIE_NAME } from "../utils/token.util.js";
import { User } from "../models/user.model.js";
import { errorResponse } from "../utils/response.js";

/**
 * Authentication middleware.
 * Verifies JWT from either httpOnly session cookie or Bearer Authorization header.
 * Attaches the authenticated user document (without password hash) to req.user.
 */
export async function authenticate(req, res, next) {
  let token = null;

  // 1. Prefer httpOnly cookie
  if (req.cookies && req.cookies[SESSION_COOKIE_NAME]) {
    token = req.cookies[SESSION_COOKIE_NAME];
  }

  // 2. Fall back to Authorization: Bearer <token>
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(" ");
    if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
      token = parts[1];
    }
  }

  if (!token) {
    return errorResponse(res, 401, "Authentication required", "UNAUTHORIZED");
  }

  try {
    const decoded = verifyToken(token);
    const user = await User.findById(decoded.sub);

    if (!user) {
      return errorResponse(res, 401, "User no longer exists", "USER_NOT_FOUND");
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return errorResponse(res, 401, "Session expired, please log in again", "TOKEN_EXPIRED");
    }
    return errorResponse(res, 401, "Invalid authentication token", "INVALID_TOKEN");
  }
}

/**
 * Optional authentication middleware.
 * Attaches req.user if a valid token is present; leaves req.user = null otherwise.
 * Never fails with 401, allowing guest exploration.
 */
export async function optionalAuthenticate(req, res, next) {
  let token = null;

  if (req.cookies && req.cookies[SESSION_COOKIE_NAME]) {
    token = req.cookies[SESSION_COOKIE_NAME];
  }

  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(" ");
    if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
      token = parts[1];
    }
  }

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = verifyToken(token);
    const user = await User.findById(decoded.sub);
    req.user = user || null;
  } catch {
    req.user = null;
  }

  next();
}

/**
 * Role-based access control middleware.
 * Ensures req.user has one of the allowed roles.
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return errorResponse(res, 401, "Authentication required", "UNAUTHORIZED");
    }

    if (!allowedRoles.includes(req.user.role)) {
      return errorResponse(
        res,
        403,
        `Access restricted to ${allowedRoles.join(", ")}`,
        "FORBIDDEN"
      );
    }

    next();
  };
}
