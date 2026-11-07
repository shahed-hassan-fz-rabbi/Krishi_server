/**
 * MongoDB connection manager (Mongoose).
 * - Connects using MONGODB_URI from env.
 * - Does not crash the app when the URI is missing: the server stays online
 *   and /api/v1/health reports the real database state.
 * - Never logs connection secrets.
 */
import mongoose from "mongoose";

let connectionString = ""; // kept only for health diagnostics, secrets never logged

function classifyConnectionError(error) {
  const chain = [];
  const seen = new Set();
  const queue = [error];
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    if (current.cause) queue.push(current.cause);
    for (const server of current.reason?.servers?.values?.() || []) {
      if (server.error) queue.push(server.error);
    }
  }

  const messages = chain.map((item) => String(item.message || "")).join(" ");
  const codes = chain.map((item) => item.code).filter(Boolean);
  // MongoServerSelectionError includes generic Atlas whitelist advice even
  // when the operating system rejected the socket before Atlas was reached.
  if (chain.some((item) => item.code === "EACCES" && item.syscall === "connect")) {
    return "local_outbound_socket_permission_denied";
  }
  if (chain.some((item) => item.code === "EPERM" && item.syscall === "connect")) {
    return "local_outbound_socket_permission_denied";
  }
  if (codes.includes("ENOTFOUND") || codes.includes("EAI_AGAIN")) return "dns_resolution";
  if (codes.includes("ECONNREFUSED")) return "remote_socket_refused";
  if (/authentication failed|bad auth|sasl|code 18/i.test(messages) || codes.includes(18)) return "authentication";
  if (/certificate|tls|ssl|handshake/i.test(messages)) return "tls_certificate_or_handshake";
  // Atlas's generic server-selection hint mentions whitelisting for ordinary
  // timeouts too. Only use this class for an explicit server-side rejection.
  if (/ip address .* (?:is not allowed|is not authorized) (?:to )?(?:access|connect)/i.test(messages)) {
    return "atlas_ip_access_list";
  }
  if (/timed out|timeout|server selection|could not connect/i.test(messages)) return "server_selection_or_network_timeout";
  return "connection_failed";
}

function connectionErrorCode(error) {
  const queue = [error];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (current.code) return current.code;
    if (current.cause) queue.push(current.cause);
    for (const server of current.reason?.servers?.values?.() || []) {
      if (server.error) queue.push(server.error);
    }
  }
  return "none";
}

export async function connectDatabase({ databaseName, required = false } = {}) {
  const uri = process.env.MONGODB_TEST_URI || process.env.MONGODB_URI;

  if (!uri) {
    const error = new Error("MongoDB URI is not configured.");
    if (required) throw error;
    console.warn("[db] MongoDB URI is not configured; database features are unavailable.");
    return { connected: false, classification: "missing_configuration" };
  }

  // Only the database name portion (if present) is safe to surface.
  try {
    const parsed = new URL(uri.replace("mongodb+srv://", "https://"));
    connectionString = parsed.pathname || "";
  } catch {
    connectionString = "";
  }

  mongoose.set("strictQuery", true);

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      ...(databaseName ? { dbName: databaseName } : {}),
    });
    connectionString = mongoose.connection.name;
    console.log(`[db] Connected to MongoDB database (${connectionString}).`);
    return { connected: true };
  } catch (error) {
    const classification = classifyConnectionError(error);
    console.error(`[db] MongoDB connection failed; class=${classification}; code=${connectionErrorCode(error)}.`);
    // API startup remains non-fatal; callers that require a database get a clear failure.
    if (required) {
      throw new Error(`MongoDB connection failed (${classification}); verify test database access and network configuration.`);
    }
    return { connected: false, classification };
  }
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log("[db] MongoDB connection closed");
  }
}

/** Reflects the live mongoose connection state. */
export function getDatabaseState() {
  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  const states = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
    99: "uninitialized",
  };
  return {
    state: states[mongoose.connection.readyState] || "unknown",
    readyState: mongoose.connection.readyState,
    target: connectionString,
  };
}
