const DEVELOPMENT_JWT_FALLBACK = "krishi-mama-super-secure-jwt-signing-secret-key-32chars";

/** Resolve the signing key without ever allowing the development key in production. */
export function resolveJwtSecret(nodeEnv, configuredSecret) {
  if (nodeEnv === "production") {
    if (typeof configuredSecret !== "string" || configuredSecret.length < 32) {
      throw new Error("JWT_SECRET must be configured with at least 32 characters in production.");
    }
    return configuredSecret;
  }

  return configuredSecret || DEVELOPMENT_JWT_FALLBACK;
}
