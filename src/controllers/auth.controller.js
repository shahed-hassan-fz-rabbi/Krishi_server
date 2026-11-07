import { User } from "../models/user.model.js";
import {
  validateRegisterInput,
  validateLoginInput,
  validateProfileUpdateInput,
} from "../validators/auth.validator.js";
import {
  signToken,
  SESSION_COOKIE_NAME,
  getAuthCookieOptions,
} from "../utils/token.util.js";
import { successResponse, errorResponse } from "../utils/response.js";
import { env } from "../config/env.config.js";

/**
 * POST /api/v1/auth/register
 * Register a new user account with role='farmer' by default.
 */
export async function register(req, res) {
  const { isValid, errors, sanitized } = validateRegisterInput(req.body);

  if (!isValid) {
    return errorResponse(res, 400, "Validation failed", "VALIDATION_ERROR", errors);
  }

  // Prevent duplicate email registration
  const existingUser = await User.findOne({ email: sanitized.email });
  if (existingUser) {
    return errorResponse(
      res,
      409,
      "An account with this email address already exists",
      "EMAIL_ALREADY_EXISTS"
    );
  }

  // Hash password with bcrypt (12 rounds)
  const passwordHash = await User.hashPassword(sanitized.password);

  const newUser = await User.create({
    name: sanitized.name,
    email: sanitized.email,
    passwordHash,
    preferredDistrict: sanitized.preferredDistrict,
    role: "farmer", // Server-enforced, public registration cannot escalate role
    lastLoginAt: new Date(),
  });

  const token = signToken(newUser);
  res.cookie(SESSION_COOKIE_NAME, token, getAuthCookieOptions());

  return successResponse(
    res,
    201,
    {
      user: newUser,
      token,
    },
    { message: "Registration successful" }
  );
}

/**
 * POST /api/v1/auth/login
 * Authenticate existing user, set httpOnly session cookie, and return token.
 */
export async function login(req, res) {
  const { isValid, errors, sanitized } = validateLoginInput(req.body);

  if (!isValid) {
    return errorResponse(res, 400, "Validation failed", "VALIDATION_ERROR", errors);
  }

  // Explicitly select passwordHash for verification
  const user = await User.findOne({ email: sanitized.email }).select("+passwordHash");
  if (!user) {
    return errorResponse(res, 401, "Invalid email or password", "INVALID_CREDENTIALS");
  }

  const isPasswordValid = await user.comparePassword(sanitized.password);
  if (!isPasswordValid) {
    return errorResponse(res, 401, "Invalid email or password", "INVALID_CREDENTIALS");
  }

  // Update last login timestamp
  user.lastLoginAt = new Date();
  await user.save();

  const token = signToken(user);
  res.cookie(SESSION_COOKIE_NAME, token, getAuthCookieOptions());

  return successResponse(
    res,
    200,
    {
      user,
      token,
    },
    { message: "Login successful" }
  );
}

/**
 * GET /api/v1/auth/me
 * Retrieve the current authenticated user's profile.
 */
export async function getMe(req, res) {
  return successResponse(res, 200, { user: req.user });
}

/**
 * POST /api/v1/auth/logout
 * Invalidate session by clearing the httpOnly cookie.
 */
export async function logout(_req, res) {
  const isProd = env.nodeEnv === "production";
  res.clearCookie(SESSION_COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
  });

  return successResponse(res, 200, { message: "Logged out successfully" });
}

/**
 * PATCH /api/v1/auth/profile
 * Update user preferences (name, preferredDistrict).
 */
export async function updateProfile(req, res) {
  const { isValid, errors, sanitized } = validateProfileUpdateInput(req.body);

  if (!isValid) {
    return errorResponse(res, 400, "Validation failed", "VALIDATION_ERROR", errors);
  }

  if (sanitized.name) {
    req.user.name = sanitized.name;
  }
  if (sanitized.preferredDistrict) {
    req.user.preferredDistrict = sanitized.preferredDistrict;
  }

  await req.user.save();

  return successResponse(
    res,
    200,
    { user: req.user },
    { message: "Profile updated successfully" }
  );
}
