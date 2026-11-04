import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

// Auto-load .env from current directory, parent directories, or monorepo root
if (typeof process.loadEnvFile === "function") {
  const envCandidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(import.meta.dirname, "../../../.env"),
    path.resolve(import.meta.dirname, "../../.env"),
    path.resolve(import.meta.dirname, ".env"),
  ];
  for (const candidate of envCandidates) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
        break;
      } catch {
        // Continue searching
      }
    }
  }
}

import app from "./app";
import { logger } from "./lib/logger";
import { attachRoomSockets, initializeRoomStorage } from "./lib/rooms";
import { getCorsOriginConfig } from "./lib/cors";

const rawPort = process.env["PORT"] || "5000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
const corsOrigin = getCorsOriginConfig(process.env.CORS_ORIGIN);
attachRoomSockets(server, corsOrigin);

await initializeRoomStorage();

const host = process.env["HOST"] || "0.0.0.0";

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

server.listen(port, host, () => {
  logger.info({ port, host }, "Server listening");
  startKeepAlivePing();
});

// ---------------------------------------------------------------------------
// Render Free-Tier Keep-Alive Ping (11 minutes to prevent 15-minute idle sleep)
// ---------------------------------------------------------------------------
const KEEP_ALIVE_INTERVAL_MS = 11 * 60 * 1000; // 11 minutes

function startKeepAlivePing(): void {
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
  if (!externalUrl) {
    return;
  }

  const targetUrl = `${externalUrl.replace(/\/+$/, "")}/api/healthz`;
  logger.info({ targetUrl, intervalMinutes: 11 }, "Keep-alive: Scheduled self-ping to prevent Render sleep.");

  const timer = setInterval(async () => {
    try {
      const res = await fetch(targetUrl);
      logger.info({ status: res.status, url: targetUrl }, "Keep-alive: Self-ping successful.");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message, url: targetUrl }, "Keep-alive: Self-ping attempt logged.");
    }
  }, KEEP_ALIVE_INTERVAL_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}
