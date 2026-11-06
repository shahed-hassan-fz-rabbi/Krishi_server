/** Small unified JSON response helpers for consistent API responses. */

export function successResponse(res, statusCode, data, meta = {}) {
  return res.status(statusCode).json({
    success: true,
    data,
    meta,
  });
}

export function errorResponse(res, statusCode, message, details = undefined) {
  const body = { success: false, error: { message } };
  if (details !== undefined) body.error.details = details;
  return res.status(statusCode).json(body);
}
