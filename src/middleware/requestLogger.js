/** simple HTTP request logger (method, path, status, ms) — no secrets, no headers. */
export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (req.originalUrl.startsWith("/api/v1/health")) return; // skip health spam
    console.log(`[http] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}
