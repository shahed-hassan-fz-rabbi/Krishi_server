/**
 * Loads environment variables from .env into process.env.
 * Must be imported first in server.js (before config values are read).
 */
import dotenv from "dotenv";

dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "5000", 10),
  mongoUri: process.env.MONGODB_URI || "",
  corsOrigin: (process.env.CORS_ORIGIN || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL || "info",
};
