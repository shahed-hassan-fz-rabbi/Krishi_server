/**
 * Centralized error handling middleware.
 * Every error the API produces exits through here to keep the response
 * format consistent: { success: false, error: { code, message, details? }, meta: {} }
 */
import { errorResponse } from "../utils/response.js";

export function notFoundHandler(req, res) {
  return errorResponse(
    res,
    404,
    `Route not found: ${req.method} ${req.originalUrl}`,
    "ROUTE_NOT_FOUND"
  );
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Structured, non-secret logging.
  console.error(
    `[error] ${req.method} ${req.originalUrl} -> ${err.status || err.statusCode || 500}: ${err.message}`
  );

  const statusCode = err.status || err.statusCode || 500;
  const code =
    err.code ||
    (statusCode === 400
      ? "BAD_REQUEST"
      : statusCode === 404
      ? "NOT_FOUND"
      : statusCode === 503
      ? "SERVICE_UNAVAILABLE"
      : "INTERNAL_ERROR");

  const message =
    statusCode >= 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message;

  return errorResponse(res, statusCode, message, code, err.details);
}
