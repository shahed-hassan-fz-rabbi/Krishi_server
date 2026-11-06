/**
 * Krishi Mama API — Express application.
 * Mounts middleware and the versioned REST API under /api/v1.
 */
import express from "express";
import cors from "cors";

import { env } from "./config/env.config.js";
import apiV1Routes from "./routes/v1/index.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { requestLogger } from "./middleware/requestLogger.js";

export function createApp() {
  const app = express();

  // ---- Core middleware ----
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  // ---- CORS ----
  app.use(
    cors({
      origin: env.nodeEnv === "development" ? true : env.corsOrigin,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: false,
    })
  );

  // ---- Logging ----
  app.use(requestLogger);

  // ---- Versioned API ----
  app.use("/api/v1", apiV1Routes);

  // ---- 404 + centralized errors ----
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
