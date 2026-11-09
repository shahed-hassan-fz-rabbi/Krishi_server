import { OAuth2Client } from "google-auth-library";
import { env, isGoogleOAuthConfigured } from "../../config/env.config.js";

let oauth2ClientInstance = null;

/**
 * Returns an instance of OAuth2Client if credentials are configured.
 * Automatically refreshes the client if credentials have been reloaded.
 */
export function getOAuth2Client() {
  if (!isGoogleOAuthConfigured()) {
    oauth2ClientInstance = null;
    return null;
  }

  const clientId = env.googleClientId;
  const clientSecret = env.googleClientSecret;
  const callbackUrl = env.googleCallbackUrl;

  if (
    !oauth2ClientInstance ||
    oauth2ClientInstance._clientId !== clientId
  ) {
    oauth2ClientInstance = new OAuth2Client(clientId, clientSecret, callbackUrl);
  }

  return oauth2ClientInstance;
}

/**
 * Generates the Google OAuth 2.0 authorization URL with state parameter.
 * @param {string} state - Cryptographically random CSRF mitigation token.
 * @returns {string} Fully constructed consent URL.
 */
export function getGoogleAuthUrl(state) {
  const client = getOAuth2Client();
  if (!client) {
    const error = new Error("Google OAuth credentials are not configured in server/.env");
    error.code = "GOOGLE_AUTH_NOT_CONFIGURED";
    throw error;
  }

  return client.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });
}

/**
 * Exchanges authorization code for tokens and verifies the returned ID token.
 * @param {string} code - Authorization code received from Google callback.
 * @returns {Promise<{ googleId: string, email: string, name: string, picture: string|null }>}
 */
export async function exchangeCodeAndVerify(code) {
  const client = getOAuth2Client();
  if (!client) {
    const error = new Error("Google OAuth is not configured on the server");
    error.code = "GOOGLE_AUTH_NOT_CONFIGURED";
    throw error;
  }

  // 1. Exchange authorization code for tokens
  const { tokens } = await client.getToken(code);
  if (!tokens || !tokens.id_token) {
    const error = new Error("Google token exchange did not return an ID token");
    error.code = "GOOGLE_TOKEN_EXCHANGE_FAILED";
    throw error;
  }

  // 2. Cryptographically verify the ID token signature against Google's public certs
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.googleClientId,
  });

  const payload = ticket.getPayload();
  if (!payload) {
    const error = new Error("Invalid Google token payload");
    error.code = "INVALID_GOOGLE_PAYLOAD";
    throw error;
  }

  if (!payload.email_verified) {
    const error = new Error("Google email address is not verified");
    error.code = "EMAIL_NOT_VERIFIED";
    throw error;
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase().trim(),
    name: payload.name || payload.email.split("@")[0],
    picture: payload.picture || null,
  };
}

/**
 * Verifies an ID token received directly (e.g., from Google One Tap or native clients).
 * @param {string} idToken - The raw Google ID token JWT string.
 * @returns {Promise<{ googleId: string, email: string, name: string, picture: string|null }>}
 */
export async function verifyGoogleIdToken(idToken, customClient = null) {
  const client = customClient || getOAuth2Client();
  if (!client) {
    const error = new Error("Google OAuth is not configured on the server");
    error.code = "GOOGLE_AUTH_NOT_CONFIGURED";
    throw error;
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: env.googleClientId,
  });

  const payload = ticket.getPayload();
  if (!payload) {
    const error = new Error("Invalid Google token payload");
    error.code = "INVALID_GOOGLE_PAYLOAD";
    throw error;
  }

  if (!payload.email_verified) {
    const error = new Error("Google email address is not verified");
    error.code = "EMAIL_NOT_VERIFIED";
    throw error;
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase().trim(),
    name: payload.name || payload.email.split("@")[0],
    picture: payload.picture || null,
  };
}
