/**
 * Centralized error handling middleware.
 * Every error the API produces exits through here to keep the response
 * format consistent: { success: false, error: { message, details? } }
 */

export function notFoundHandler(req, res) {
  return res.status(404).json({
    success: false,
    error: { message: `Route not found: ${req.method} ${req.originalUrl}` },
  });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Structured, non-secret logging.
  console.error(
    `[error] ${req.method} ${req.originalUrl} -> ${err.status || err.statusCode || 500}: ${err.message}`
  );

  const statusCode = err.status || err.statusCode || 500;
  const message =
    statusCode >= 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message;

  const body = { success: false, error: { message } };
  if (err.details !== undefined) body.error.details = err.details;

  return res.status(statusCode).json(body);
}
