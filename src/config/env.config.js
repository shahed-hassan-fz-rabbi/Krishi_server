/**
 * Loads environment variables from .env into process.env.
 * Must be imported first in server.js (before config values are read).
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveJwtSecret } from "./security.config.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const serverRootDir = path.resolve(currentDir, "../..");
export const serverEnvPath = path.resolve(serverRootDir, ".env");

// Load .env explicitly with override: true so that disk values are always prioritized
dotenv.config({ path: serverEnvPath, override: true });

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "5000", 10),
  mongoUri: process.env.MONGODB_URI || "",
  clientUrl: process.env.CLIENT_URL || "http://localhost:3000",
  corsOrigin: (process.env.CORS_ORIGIN || process.env.CLIENT_URL || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  jwtSecret: resolveJwtSecret(process.env.NODE_ENV || "development", process.env.JWT_SECRET),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  logLevel: process.env.LOG_LEVEL || "info",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  get googleClientId() {
    return (process.env.GOOGLE_CLIENT_ID || "").trim();
  },
  get googleClientSecret() {
    return (process.env.GOOGLE_CLIENT_SECRET || "").trim();
  },
  get googleCallbackUrl() {
    return (process.env.GOOGLE_CALLBACK_URL || "http://localhost:5000/api/v1/auth/google/callback").trim();
  },
};

/**
 * Checks whether Google OAuth is configured with real Client ID & Secret (not placeholders).
 * Performs an on-demand disk re-sync if in-memory variables are missing or placeholders.
 */
export function isGoogleOAuthConfigured() {
  const isPlaceholder = (val) =>
    !val ||
    val.trim().length === 0 ||
    val.toLowerCase().includes("your_google") ||
    val.toLowerCase().includes("your_client") ||
    val.toLowerCase().includes("placeholder") ||
    val.startsWith("<");

  let clientId = (process.env.GOOGLE_CLIENT_ID || env.googleClientId || "").trim();
  let clientSecret = (process.env.GOOGLE_CLIENT_SECRET || env.googleClientSecret || "").trim();

  // If values are missing or are placeholders, re-read .env from disk with override
  if (isPlaceholder(clientId) || isPlaceholder(clientSecret)) {
    try {
      dotenv.config({ path: serverEnvPath, override: true });
      clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
      clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
    } catch {
      // Fallback gracefully
    }
  }

  return Boolean(
    clientId &&
    !isPlaceholder(clientId) &&
    clientSecret &&
    !isPlaceholder(clientSecret)
  );
}
