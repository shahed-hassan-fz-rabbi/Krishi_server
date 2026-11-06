/**
 * MongoDB connection manager (Mongoose).
 * - Connects using MONGODB_URI from env.
 * - Does not crash the app when the URI is missing: the server stays online
 *   and /api/v1/health reports the real database state.
 * - Never logs connection secrets.
 */
import mongoose from "mongoose";

let connectionString = ""; // kept only for health diagnostics, secrets never logged

export async function connectDatabase() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.warn(
      "[db] MONGODB_URI is not set — running without a database connection. " +
        "Add the MongoDB Atlas URI to server/.env to enable database features."
    );
    return { connected: false, reason: "MONGODB_URI not set" };
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
    });
    connectionString = `${mongoose.connection.name} @ ${mongoose.connection.host}`;
    console.log(`[db] Connected to MongoDB (${connectionString})`);
    return { connected: true };
  } catch (error) {
    console.error(`[db] MongoDB connection failed: ${error.message}`);
    // Do not rethrow: keep API online so health endpoint can report status.
    return { connected: false, reason: error.message };
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
