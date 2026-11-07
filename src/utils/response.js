/** Small unified JSON response helpers for consistent API responses. */

export function successResponse(res, statusCode, data, meta = {}) {
  return res.status(statusCode).json({
    success: true,
    data,
    meta,
  });
}

export function errorResponse(res, statusCode, message, code = "BAD_REQUEST", details = undefined, meta = {}) {
  const body = {
    success: false,
    error: {
      code,
      message,
    },
    meta,
  };
  if (details !== undefined) body.error.details = details;
  return res.status(statusCode).json(body);
}
