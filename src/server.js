/**
 * Krishi Mama API — server entry point.
 * 1. Load env config first.
 * 2. Try to connect to MongoDB (non-fatal if unavailable).
 * 3. Start the HTTP server.
 */
import "./config/env.config.js";

import { createApp } from "./app.js";
import { connectDatabase, getDatabaseState } from "./config/database.js";
import { env } from "./config/env.config.js";

async function main() {
  await connectDatabase();
  const db = getDatabaseState();
  if (db.readyState !== 1) {
    console.warn("[server] Starting without a database connection — see [db] logs for details.");
  }

  const app = createApp();

  const server = app.listen(env.port, "0.0.0.0", () => {
    console.log(`[server] Krishi Mama API listening on http://localhost:${env.port} (${env.nodeEnv})`);
    console.log(`[server] REST API base path: /api/v1`);
  });

  // ---- Graceful shutdown ----
  const shutdown = async (signal) => {
    console.log(`[server] Received ${signal} — shutting down gracefully`);
    server.close(async () => {
      const { disconnectDatabase } = await import("./config/database.js");
      await disconnectDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    console.error(`[server] Unhandled rejection: ${reason instanceof Error ? reason.message : reason}`);
  });
}

main().catch((error) => {
  console.error(`[server] Fatal startup error: ${error.message}`);
  process.exit(1);
});
