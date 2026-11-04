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
});
