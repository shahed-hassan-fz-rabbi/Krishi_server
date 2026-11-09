import crypto from "node:crypto";
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
import { env, isGoogleOAuthConfigured } from "../config/env.config.js";
import {
  getGoogleAuthUrl,
  exchangeCodeAndVerify,
  verifyGoogleIdToken,
} from "../services/auth/google.oauth.service.js";

const OAUTH_STATE_COOKIE_NAME = "km_oauth_state";

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

/**
 * GET /api/v1/auth/google/status
 * Returns whether Google OAuth is configured, and provides the public client ID.
 */
export async function getGoogleStatus(_req, res) {
  const configured = isGoogleOAuthConfigured();
  return successResponse(res, 200, {
    configured,
    clientId: configured ? env.googleClientId : null,
  });
}

/**
 * GET /api/v1/auth/google
 * Initiates the Google OAuth authorization-code flow.
 */
export async function initiateGoogleAuth(req, res) {
  if (!isGoogleOAuthConfigured()) {
    return errorResponse(
      res,
      503,
      "Google OAuth is not configured on the server. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env.",
      "GOOGLE_AUTH_NOT_CONFIGURED"
    );
  }

  // Generate cryptographically secure state parameter
  const state = crypto.randomBytes(32).toString("hex");

  // Store state in httpOnly cookie for 10 minutes to verify on callback
  const isProd = env.nodeEnv === "production";
  res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });

  const authUrl = getGoogleAuthUrl(state);

  // If client specifically requested JSON format (e.g. for popup or SPA initiation)
  if (req.query.format === "json") {
    return successResponse(res, 200, { url: authUrl });
  }

  // Otherwise perform standard HTTP 302 redirect to Google consent screen
  return res.redirect(authUrl);
}

const VALID_ROLES = ["farmer", "extension_officer", "admin"];
const VALID_DISTRICTS = ["chattogram", "cumilla"];

/**
 * Safely resolves or creates a User document from a cryptographically verified Google profile.
 * - New Google users: always assigned role 'farmer'.
 * - Existing users: strictly preserves valid role (admin, extension_officer, farmer).
 * - Legacy accounts (e.g. from prior mock/seed data): normalizes invalid roles safely to 'farmer'.
 * - Google identity fields (googleId, avatarUrl, lastLoginAt) linked safely.
 * - Password compatibility preserved (local accounts retain passwordHash).
 * @param {{ googleId: string, email: string, name: string, picture: string|null }} profile
 * @returns {Promise<User>}
 */
export async function findOrCreateGoogleUser(profile) {
  if (!profile || !profile.email || !profile.googleId) {
    throw new Error("Invalid Google profile: missing email or googleId");
  }

  const normalizedEmail = profile.email.toLowerCase().trim();

  // 1. Look for user by existing Google ID
  let user = await User.findOne({ googleId: profile.googleId });

  if (user) {
    user.lastLoginAt = new Date();
    if (profile.picture && !user.avatarUrl) {
      user.avatarUrl = profile.picture;
    }
    // Safeguard schema constraints on existing documents
    if (!VALID_ROLES.includes(user.role)) {
      user.role = "farmer";
    }
    if (!user.preferredDistrict || !VALID_DISTRICTS.includes(user.preferredDistrict)) {
      user.preferredDistrict = "chattogram";
    }
    await user.save();
    return user;
  }

  // 2. Check if user with matching verified email already exists (Account Linking)
  user = await User.findOne({ email: normalizedEmail });

  if (user) {
    user.googleId = profile.googleId;
    user.lastLoginAt = new Date();
    if (profile.picture && !user.avatarUrl) {
      user.avatarUrl = profile.picture;
    }
    // Strictly preserve valid role (admin, extension_officer, farmer).
    // If existing role is legacy/unrecognized, safely normalize to 'farmer'.
    if (!VALID_ROLES.includes(user.role)) {
      user.role = "farmer";
    }
    if (!user.preferredDistrict || !VALID_DISTRICTS.includes(user.preferredDistrict)) {
      user.preferredDistrict = "chattogram";
    }
    await user.save();
    return user;
  }

  // 3. Create brand-new Google-authenticated user (strictly role: 'farmer')
  user = await User.create({
    name: profile.name || normalizedEmail.split("@")[0],
    email: normalizedEmail,
    googleId: profile.googleId,
    avatarUrl: profile.picture || null,
    authProvider: "google",
    preferredDistrict: "chattogram",
    role: "farmer",
    lastLoginAt: new Date(),
  });

  return user;
}

/**
 * GET /api/v1/auth/google/callback
 * Handles the redirect from Google OAuth consent screen.
 */
export async function handleGoogleCallback(req, res) {
  const { code, state, error: oauthError } = req.query;
  const clientUrl = env.clientUrl.replace(/\/+$/, "");

  // Handle user cancellation or denial
  if (oauthError) {
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });
    const isCancelled = oauthError === "access_denied";
    return res.redirect(`${clientUrl}/login?error=${isCancelled ? "cancelled" : "oauth_error"}&message=${encodeURIComponent(oauthError)}`);
  }

  // Validate state parameter against stored cookie to prevent CSRF attacks
  const storedState = req.cookies?.[OAUTH_STATE_COOKIE_NAME];
  if (!state || !storedState || state !== storedState) {
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });
    return res.redirect(`${clientUrl}/login?error=state_mismatch&message=${encodeURIComponent("OAuth state validation failed. Please try again.")}`);
  }

  // Clear state cookie now that it has been validated
  res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });

  if (!code) {
    return res.redirect(`${clientUrl}/login?error=missing_code&message=${encodeURIComponent("Authorization code missing from Google callback.")}`);
  }

  try {
    // Exchange code for tokens and cryptographically verify ID token
    const profile = await exchangeCodeAndVerify(code);

    const user = await findOrCreateGoogleUser(profile);

    // Generate JWT session token and set httpOnly session cookie
    const token = signToken(user);
    res.cookie(SESSION_COOKIE_NAME, token, getAuthCookieOptions());

    // Redirect to authenticated dashboard with success indication
    return res.redirect(`${clientUrl}/dashboard?auth=google_success`);
  } catch (err) {
    const errorMsg = err.message || "Google authentication failed";
    return res.redirect(`${clientUrl}/login?error=google_failed&message=${encodeURIComponent(errorMsg)}`);
  }
}

/**
 * POST /api/v1/auth/google/token
 * Direct ID token verification endpoint (supports Google One Tap or native clients).
 */
export async function verifyGoogleTokenDirect(req, res) {
  const { idToken } = req.body;

  if (!idToken || typeof idToken !== "string") {
    return errorResponse(res, 400, "idToken is required", "VALIDATION_ERROR");
  }

  if (!isGoogleOAuthConfigured()) {
    return errorResponse(
      res,
      503,
      "Google OAuth is not configured on the server",
      "GOOGLE_AUTH_NOT_CONFIGURED"
    );
  }

  try {
    const profile = await verifyGoogleIdToken(idToken);

    const user = await findOrCreateGoogleUser(profile);

    const token = signToken(user);
    res.cookie(SESSION_COOKIE_NAME, token, getAuthCookieOptions());

    return successResponse(res, 200, { user, token }, { message: "Google authentication successful" });
  } catch (err) {
    return errorResponse(res, 401, err.message || "Invalid Google ID token", "INVALID_GOOGLE_TOKEN");
  }
}
