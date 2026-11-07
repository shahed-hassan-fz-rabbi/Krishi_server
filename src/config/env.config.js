/**
 * Loads environment variables from .env into process.env.
 * Must be imported first in server.js (before config values are read).
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "5000", 10),
  mongoUri: process.env.MONGODB_URI || "",
  corsOrigin: (process.env.CORS_ORIGIN || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  jwtSecret: process.env.JWT_SECRET || "krishi-mama-super-secure-jwt-signing-secret-key-32chars",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  logLevel: process.env.LOG_LEVEL || "info",
};
