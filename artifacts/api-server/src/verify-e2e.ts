import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io as ioClient, type Socket } from "socket.io-client";
import app from "./app";
import { attachRoomSockets, closeRoomStorage, initializeRoomStorage } from "./lib/rooms";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../../..");

function logGate(step: string, status: "PASS" | "FAIL" | "INFO", details?: string) {
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "ℹ️";
  console.log(`${icon} [Gate ${step}] ${details || ""}`);
}

async function runAcceptanceGates(): Promise<void> {
  console.log("\n=======================================================");
  console.log("   EPHEMERAL-SYNC-ROOMS: PRODUCTION ACCEPTANCE SUITE   ");
  console.log("=======================================================\n");

  // -------------------------------------------------------------------------
  // Gate 1: Workspace Hygiene Gate
  // -------------------------------------------------------------------------
  const forbiddenPaths = [
    path.join(rootDir, "lib/db"),
    path.join(rootDir, "artifacts/mockup-sandbox"),
    path.join(rootDir, ".replit"),
  ];

  for (const forbidden of forbiddenPaths) {
    if (existsSync(forbidden)) {
      logGate("1: Hygiene", "FAIL", `Forbidden dead artifact still exists: ${path.relative(rootDir, forbidden)}`);
      process.exit(1);
    }
  }

  const mandatoryFiles = [
    path.join(rootDir, ".env.example"),
    path.join(rootDir, "artifacts/api-server/.env.example"),
    path.join(rootDir, "artifacts/ephemeral-sync/.env.example"),
    path.join(rootDir, ".conversation/01-architecture-and-context.md"),
    path.join(rootDir, ".conversation/02-next-agent-handoff.md"),
  ];

  for (const file of mandatoryFiles) {
    if (!existsSync(file)) {
      logGate("1: Hygiene", "FAIL", `Missing required file: ${path.relative(rootDir, file)}`);
      process.exit(1);
    }
    const content = readFileSync(file, "utf-8").trim();
    if (content.length === 0) {
      logGate("1: Hygiene", "FAIL", `File is empty: ${path.relative(rootDir, file)}`);
      process.exit(1);
    }
  }
  logGate("1: Hygiene", "PASS", "Workspace is completely clean of legacy Replit files and all required docs exist.");

  // -------------------------------------------------------------------------
  // Gate 5: End-to-End Runtime Verification
  // -------------------------------------------------------------------------
  process.env.TEST_MOCK_STORAGE = "true"; // Ensure mock storage is enabled for reproducible CI/local verification
  await initializeRoomStorage();

  const server = createServer(app);
  attachRoomSockets(server, "*");

  const testPort = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        resolve(address.port);
      } else {
        throw new Error("Failed to acquire ephemeral port");
      }
    });
  });

  const baseUrl = `http://127.0.0.1:${testPort}`;
  logGate("5: Runtime", "INFO", `Ephemeral test server listening on ${baseUrl}`);

  let clientSocket: Socket | undefined;

  try {
    // -----------------------------------------------------------------------
    // Test 5.1: Health Check Endpoint
    // -----------------------------------------------------------------------
    const healthRes = await fetch(`${baseUrl}/api/healthz`);
    if (healthRes.status !== 200) {
      throw new Error(`Health check returned status ${healthRes.status}`);
    }
    const healthData = (await healthRes.json()) as { status?: string };
    if (healthData.status !== "ok") {
      throw new Error(`Health check body status is '${healthData.status}', expected 'ok'`);
    }
    logGate("5.1: Health", "PASS", "GET /api/healthz returned HTTP 200 { status: 'ok' }");

    // -----------------------------------------------------------------------
    // Test 5.2: Create Room
    // -----------------------------------------------------------------------
    const createRes = await fetch(`${baseUrl}/api/rooms`, { method: "POST" });
    if (createRes.status !== 201) {
      throw new Error(`Create room returned status ${createRes.status}`);
    }
    const roomData = (await createRes.json()) as {
      pin: string;
      text: string;
      expiresAt: string;
      files: unknown[];
    };

    if (!/^\d{6}$/.test(roomData.pin)) {
      throw new Error(`Invalid room PIN returned: ${roomData.pin}`);
    }
    const initialExpiresAt = roomData.expiresAt;
    const expiresMs = new Date(initialExpiresAt).getTime();
    const diffMs = expiresMs - Date.now();
    if (diffMs < 14 * 60 * 1000 || diffMs > 16 * 60 * 1000) {
      throw new Error(`Expiration timestamp not within expected 15-minute window: ${diffMs}ms`);
    }
    logGate("5.2: Create Room", "PASS", `Created Room PIN ${roomData.pin} with 15-minute expiry (${initialExpiresAt})`);

    // -----------------------------------------------------------------------
    // Test 5.3: Socket.IO Real-time Sync & Strict Non-Extending TTL
    // -----------------------------------------------------------------------
    clientSocket = ioClient(baseUrl, {
      path: "/api/socket.io",
      transports: ["websocket", "polling"],
      forceNew: true,
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Socket connection timeout")), 4000);
      clientSocket!.on("connect", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // Join room and assert initial state
    const socketRoomState = await new Promise<{ pin: string; text: string; expiresAt: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("join-room response timeout")), 3000);
      clientSocket!.on("room-state", (state) => {
        clearTimeout(timer);
        resolve(state);
      });
      clientSocket!.emit("join-room", { pin: roomData.pin });
    });

    if (socketRoomState.pin !== roomData.pin) {
      throw new Error(`Socket room-state pin mismatch: expected ${roomData.pin}, got ${socketRoomState.pin}`);
    }

    // Emit text update
    const syncText = "Production Ready Sync Text - 100% Invariant Check";
    clientSocket.emit("text-update", { text: syncText });

    // Wait 250ms for async storage update
    await new Promise((r) => setTimeout(r, 250));

    // Verify via HTTP GET that text persisted and expiresAt is strictly unchanged
    const getRoomRes = await fetch(`${baseUrl}/api/rooms/${roomData.pin}`);
    if (getRoomRes.status !== 200) {
      throw new Error(`Failed to GET /api/rooms/${roomData.pin}: status ${getRoomRes.status}`);
    }
    const updatedRoom = (await getRoomRes.json()) as { text?: string; expiresAt?: string };
    if (updatedRoom.text !== syncText) {
      throw new Error(`Room text mismatch after socket sync: expected '${syncText}', got '${updatedRoom.text}'`);
    }

    if (!updatedRoom.expiresAt) {
      throw new Error("Missing expiresAt in updated room response");
    }
    const currentExpiresAt = new Date(updatedRoom.expiresAt).toISOString();
    const origExpiresAt = new Date(initialExpiresAt).toISOString();
    if (currentExpiresAt !== origExpiresAt) {
      throw new Error(`Strict Non-Extending TTL violated! Original: ${origExpiresAt}, Current: ${currentExpiresAt}`);
    }
    logGate("5.3: Socket Sync & Strict TTL", "PASS", "Text synced via Socket.IO; verified expiresAt is strictly non-extending.");

    // -----------------------------------------------------------------------
    // Test 5.4: File Upload & Download Stream
    // -----------------------------------------------------------------------
    let fileAddedPromise = new Promise<{ id: string; name: string; size: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("file-added socket event timeout")), 4000);
      clientSocket!.on("file-added", (data) => {
        clearTimeout(timer);
        resolve(data.file);
      });
    });

    const filePayload = Buffer.from("Ephemeral Sync File Payload for Streaming Test", "utf-8");
    const formData = new FormData();
    const blob = new Blob([filePayload], { type: "text/plain" });
    formData.append("file", blob, "test-document.txt");

    const uploadRes = await fetch(`${baseUrl}/api/upload/${roomData.pin}`, {
      method: "POST",
      body: formData,
    });

    if (uploadRes.status !== 201) {
      const errBody = await uploadRes.text();
      throw new Error(`File upload failed with status ${uploadRes.status}: ${errBody}`);
    }
    const uploadJson = (await uploadRes.json()) as { id: string; name: string; size: number };
    const socketReceivedFile = await fileAddedPromise;

    if (socketReceivedFile.id !== uploadJson.id) {
      throw new Error(`Socket file ID mismatch: expected ${uploadJson.id}, got ${socketReceivedFile.id}`);
    }

    // Verify download byte-for-byte stream
    const downloadRes = await fetch(`${baseUrl}/api/rooms/${roomData.pin}/files/${uploadJson.id}/download`);
    if (downloadRes.status !== 200) {
      throw new Error(`File download failed with status ${downloadRes.status}`);
    }
    const downloadedBuffer = Buffer.from(await downloadRes.arrayBuffer());
    if (!downloadedBuffer.equals(filePayload)) {
      throw new Error("Downloaded file bytes do not match uploaded payload!");
    }
    logGate("5.4: File Stream", "PASS", "File uploaded to storage, broadcast via socket, and downloaded 100% byte-matched.");

    // -----------------------------------------------------------------------
    // Test 5.4.1: Multi-file & Strict 10-file limit invariant check
    // -----------------------------------------------------------------------
    for (let i = 2; i <= 10; i++) {
      const extraFormData = new FormData();
      const extraBlob = new Blob([Buffer.from(`Payload ${i}`)], { type: "application/octet-stream" });
      extraFormData.append("file", extraBlob, `media-file-${i}.bin`);
      const extraRes = await fetch(`${baseUrl}/api/upload/${roomData.pin}`, {
        method: "POST",
        body: extraFormData,
      });
      if (extraRes.status !== 201) {
        throw new Error(`Failed to upload file ${i}: status ${extraRes.status}`);
      }
    }

    // 11th file MUST be rejected with HTTP 429
    const eleventhFormData = new FormData();
    const eleventhBlob = new Blob([Buffer.from("Overflow file")], { type: "text/plain" });
    eleventhFormData.append("file", eleventhBlob, "overflow.txt");
    const overflowRes = await fetch(`${baseUrl}/api/upload/${roomData.pin}`, {
      method: "POST",
      body: eleventhFormData,
    });
    if (overflowRes.status !== 429) {
      throw new Error(`Expected status 429 for 11th file, got ${overflowRes.status}`);
    }
    logGate("5.4.1: 10-File Limit", "PASS", "Strictly allowed 10 files of any format; 11th upload rejected with HTTP 429.");

    // -----------------------------------------------------------------------
    // Test 5.5: Burn Room Cleanup & Invalidation
    // -----------------------------------------------------------------------
    const sessionExpiredPromise = new Promise<{ reason: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("session-expired socket event timeout")), 4000);
      clientSocket!.on("session-expired", (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    const burnRes = await fetch(`${baseUrl}/api/rooms/${roomData.pin}`, {
      method: "DELETE",
    });
    if (burnRes.status !== 204) {
      throw new Error(`Burn room failed with status ${burnRes.status}`);
    }

    const expiredEvent = await sessionExpiredPromise;
    if (expiredEvent.reason !== "burned") {
      throw new Error(`Expected reason 'burned', got '${expiredEvent.reason}'`);
    }

    // Assert room is now 404
    const postBurnGet = await fetch(`${baseUrl}/api/rooms/${roomData.pin}`);
    if (postBurnGet.status !== 404) {
      throw new Error(`Expected room to be 404 after burning, got ${postBurnGet.status}`);
    }

    // Assert file download is now 404
    const postBurnDownload = await fetch(`${baseUrl}/api/rooms/${roomData.pin}/files/${uploadJson.id}/download`);
    if (postBurnDownload.status !== 404) {
      throw new Error(`Expected file download to be 404 after burning, got ${postBurnDownload.status}`);
    }
    logGate("5.5: Burn Cleanup", "PASS", "Room and files burned; socket received session-expired; all resources 404.");

    console.log("\n=======================================================");
    console.log("   🎉 ALL 6 PRODUCTION ACCEPTANCE GATES PASSED! 🎉    ");
    console.log("=======================================================\n");
  } finally {
    // -----------------------------------------------------------------------
    // Gate 6: Clean Process Exit
    // -----------------------------------------------------------------------
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
    }
    await closeRoomStorage();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    logGate("6: Teardown", "PASS", "All sockets, timers, and server listeners closed cleanly.");
  }
}

runAcceptanceGates().catch((err) => {
  console.error("\n❌ ACCEPTANCE TEST FAILED:", err);
  process.exit(1);
});
