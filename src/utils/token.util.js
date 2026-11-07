import jwt from "jsonwebtoken";
import { env } from "../config/env.config.js";

export const SESSION_COOKIE_NAME = "km_session";

/**
 * Returns consistent cookie configuration for session tokens.
 */
export function getAuthCookieOptions() {
  const isProd = env.nodeEnv === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
    path: "/",
  };
}

/**
 * Sign a JWT containing essential user identity fields.
 */
export function signToken(user) {
  const payload = {
    sub: user._id.toString(),
    email: user.email,
    role: user.role,
  };

  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
}

/**
 * Synchronously or asynchronously verify a JWT.
 */
export function verifyToken(token) {
  return jwt.verify(token, env.jwtSecret);
}
