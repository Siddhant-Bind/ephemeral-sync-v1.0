import { randomInt, randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Readable } from "node:stream";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import Redis from "ioredis";
import { Server as SocketServer } from "socket.io";
import type { Room, RoomFile } from "@workspace/api-zod";
import { logger } from "./logger";

export const ROOM_TTL_MS = 15 * 60 * 1000; // Exactly 15 minutes (900,000 ms)
export const ROOM_TTL_SECONDS = 900; // 900 seconds
export const MAX_TEXT_LENGTH = 1_000_000;
export const MAX_FILES_PER_ROOM = 10;
export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

export type RoomEndReason = "expired" | "burned";

export interface StoredRoomFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  uploadedAt: string; // ISO timestamp
}

export interface RoomRecord {
  pin: string;
  text: string;
  expiresAt: string; // ISO timestamp (Strictly immutable!)
  files: StoredRoomFile[];
}

export interface RoomSocketSnapshot {
  pin: string;
  text: string;
  expiresAt: string;
  files: RoomFile[];
}

export interface BlobDownloadResult {
  stream: NodeJS.ReadableStream | Buffer;
  contentLength: number;
  contentType: string;
}

/**
 * Storage adapter interface decoupling Redis + Azure Blob from test mock storage
 */
export interface StorageAdapter {
  init(): Promise<void>;
  close(): Promise<void>;
  getRoom(pin: string): Promise<RoomRecord | null>;
  saveNewRoom(pin: string, room: RoomRecord, ttlSeconds: number): Promise<boolean>;
  updateRoom(pin: string, room: RoomRecord, ttlSeconds: number): Promise<void>;
  deleteRoom(pin: string): Promise<void>;
  uploadBlob(pin: string, fileId: string, buffer: Buffer, mimeType: string): Promise<void>;
  downloadBlob(pin: string, fileId: string): Promise<BlobDownloadResult | null>;
  deleteRoomBlobs(pin: string): Promise<void>;
}

/**
 * In-Memory Mock Storage Adapter (for testing when external credentials are absent)
 */
class InMemoryStorageAdapter implements StorageAdapter {
  private rooms = new Map<string, { record: RoomRecord; expiresAtMs: number }>();
  private blobs = new Map<string, { buffer: Buffer; mimeType: string; size: number }>();

  async init(): Promise<void> {
    logger.info("Storage: Initialized In-Memory Mock Storage Adapter (TEST_MOCK_STORAGE)");
  }

  async close(): Promise<void> {
    this.rooms.clear();
    this.blobs.clear();
  }

  async getRoom(pin: string): Promise<RoomRecord | null> {
    const item = this.rooms.get(pin);
    if (!item) return null;
    if (Date.now() >= item.expiresAtMs) {
      this.rooms.delete(pin);
      return null;
    }
    return JSON.parse(JSON.stringify(item.record)) as RoomRecord;
  }

  async saveNewRoom(pin: string, room: RoomRecord, ttlSeconds: number): Promise<boolean> {
    const existing = await this.getRoom(pin);
    if (existing) return false;
    this.rooms.set(pin, {
      record: JSON.parse(JSON.stringify(room)) as RoomRecord,
      expiresAtMs: Date.now() + ttlSeconds * 1000,
    });
    return true;
  }

  async updateRoom(pin: string, room: RoomRecord, ttlSeconds: number): Promise<void> {
    const existing = this.rooms.get(pin);
    const expiresAtMs = existing ? existing.expiresAtMs : Date.now() + ttlSeconds * 1000;
    this.rooms.set(pin, {
      record: JSON.parse(JSON.stringify(room)) as RoomRecord,
      expiresAtMs,
    });
  }

  async deleteRoom(pin: string): Promise<void> {
    this.rooms.delete(pin);
  }

  async uploadBlob(pin: string, fileId: string, buffer: Buffer, mimeType: string): Promise<void> {
    const key = `rooms/${pin}/${fileId}`;
    this.blobs.set(key, { buffer, mimeType, size: buffer.length });
  }

  async downloadBlob(pin: string, fileId: string): Promise<BlobDownloadResult | null> {
    const key = `rooms/${pin}/${fileId}`;
    const item = this.blobs.get(key);
    if (!item) return null;
    return {
      stream: Readable.from(item.buffer),
      contentLength: item.size,
      contentType: item.mimeType,
    };
  }

  async deleteRoomBlobs(pin: string): Promise<void> {
    const prefix = `rooms/${pin}/`;
    for (const key of this.blobs.keys()) {
      if (key.startsWith(prefix)) {
        this.blobs.delete(key);
      }
    }
  }
}

/**
 * Production Cloud Storage Adapter: Redis (`ioredis`) + Azure Blob Storage (`@azure/storage-blob`)
 */
class CloudStorageAdapter implements StorageAdapter {
  private redis!: Redis;
  private containerClient!: ContainerClient;

  constructor(
    private redisUrl: string,
    private azureConnString: string,
    private containerName: string,
  ) {}

  async init(): Promise<void> {
    this.redis = new Redis(this.redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    await this.redis.connect();

    const blobServiceClient = BlobServiceClient.fromConnectionString(this.azureConnString);
    this.containerClient = blobServiceClient.getContainerClient(this.containerName);
    await this.containerClient.createIfNotExists();
    logger.info({ containerName: this.containerName }, "Storage: Cloud Storage initialized (Redis + Azure Blob)");
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => this.redis.disconnect());
    }
  }

  async getRoom(pin: string): Promise<RoomRecord | null> {
    const data = await this.redis.get(`room:${pin}`);
    if (!data) return null;
    try {
      return JSON.parse(data) as RoomRecord;
    } catch {
      return null;
    }
  }

  async saveNewRoom(pin: string, room: RoomRecord, ttlSeconds: number): Promise<boolean> {
    const res = await this.redis.set(
      `room:${pin}`,
      JSON.stringify(room),
      "EX",
      ttlSeconds,
      "NX",
    );
    return res === "OK";
  }

  async updateRoom(pin: string, room: RoomRecord, ttlSeconds: number): Promise<void> {
    // Non-extending TTL update: compute exact remaining seconds so activity NEVER extends room lifespan
    await this.redis.set(`room:${pin}`, JSON.stringify(room), "EX", ttlSeconds);
  }

  async deleteRoom(pin: string): Promise<void> {
    await this.redis.del(`room:${pin}`);
  }

  async uploadBlob(pin: string, fileId: string, buffer: Buffer, mimeType: string): Promise<void> {
    const blobName = `rooms/${pin}/${fileId}`;
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(buffer, {
      maxSingleShotSize: MAX_FILE_SIZE,
      blobHTTPHeaders: {
        blobContentType: mimeType,
      },
    });
  }

  async downloadBlob(pin: string, fileId: string): Promise<BlobDownloadResult | null> {
    const blobName = `rooms/${pin}/${fileId}`;
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    const exists = await blockBlobClient.exists();
    if (!exists) return null;

    const downloadResponse = await blockBlobClient.download(0);
    if (!downloadResponse.readableStreamBody) return null;

    return {
      stream: downloadResponse.readableStreamBody,
      contentLength: downloadResponse.contentLength ?? 0,
      contentType: downloadResponse.contentType ?? "application/octet-stream",
    };
  }

  async deleteRoomBlobs(pin: string): Promise<void> {
    const prefix = `rooms/${pin}/`;
    const deletePromises: Promise<unknown>[] = [];
    for await (const blob of this.containerClient.listBlobsFlat({ prefix })) {
      deletePromises.push(this.containerClient.deleteBlob(blob.name).catch(() => undefined));
    }
    await Promise.allSettled(deletePromises);
  }
}

// ---------------------------------------------------------------------------
// Singleton State & Active Expiry Timers
// ---------------------------------------------------------------------------

let adapter: StorageAdapter;
let socketServer: SocketServer | undefined;
const expiryTimers = new Map<string, NodeJS.Timeout>();

export async function initializeRoomStorage(): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  const forceMock = process.env.TEST_MOCK_STORAGE === "true";
  const redisUrl = process.env.REDIS_URL;
  const azureConn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || "ephemeral-uploads";

  if (forceMock) {
    adapter = new InMemoryStorageAdapter();
  } else if (redisUrl && azureConn) {
    adapter = new CloudStorageAdapter(redisUrl, azureConn, containerName);
  } else if (isProduction) {
    throw new Error(
      "Production deployment requires REDIS_URL and AZURE_STORAGE_CONNECTION_STRING environment variables.",
    );
  } else {
    logger.warn(
      "REDIS_URL or AZURE_STORAGE_CONNECTION_STRING missing in non-production. Falling back to in-memory mock storage.",
    );
    adapter = new InMemoryStorageAdapter();
  }

  await adapter.init();
}

export async function closeRoomStorage(): Promise<void> {
  for (const timer of expiryTimers.values()) {
    clearTimeout(timer);
  }
  expiryTimers.clear();
  if (adapter) {
    await adapter.close();
  }
}

export function attachRoomSockets(
  server: HttpServer,
  corsOrigins: string[] | string | boolean = "*",
): SocketServer {
  socketServer = new SocketServer(server, {
    path: "/api/socket.io",
    cors: {
      origin: corsOrigins as any,
      methods: ["GET", "POST"],
      credentials: true,
    },
    maxHttpBufferSize: MAX_TEXT_LENGTH + 1024,
  });

  socketServer.on("connection", (socket) => {
    socket.on("join-room", async (payload: unknown) => {
      const pin =
        payload && typeof payload === "object" && "pin" in payload
          ? (payload as { pin: unknown }).pin
          : undefined;

      if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
        socket.emit("room-error", { error: "Enter a valid six-digit PIN." });
        return;
      }

      const room = await getRoom(pin);
      if (!room) {
        socket.emit("room-error", { error: "Room not found or expired." });
        return;
      }

      const previousPin = socket.data.roomPin;
      if (typeof previousPin === "string") {
        void socket.leave(previousPin);
      }

      socket.data.roomPin = pin;
      void socket.join(pin);
      socket.emit("room-state", toSocketSnapshot(room));
    });

    socket.on("text-update", async (payload: unknown) => {
      const pin = socket.data.roomPin;
      if (
        typeof pin !== "string" ||
        !payload ||
        typeof payload !== "object" ||
        !("text" in payload) ||
        typeof (payload as { text: unknown }).text !== "string"
      ) {
        return;
      }

      const text = (payload as { text: string }).text;
      if (text.length > MAX_TEXT_LENGTH) {
        socket.emit("room-error", { error: "Text is too large to sync." });
        return;
      }

      const room = await getRoom(pin);
      if (!room || !socket.rooms.has(pin)) {
        return;
      }

      const updated = await updateRoomText(pin, text);
      if (updated) {
        socket.to(pin).emit("text-update", { text });
      }
    });

    socket.on("disconnect", () => {
      delete socket.data.roomPin;
    });
  });

  return socketServer;
}

export function getSocketServer(): SocketServer | undefined {
  return socketServer;
}

// ---------------------------------------------------------------------------
// Room Business Logic & Non-Extending TTL Engine
// ---------------------------------------------------------------------------

function ensureExpiryTimer(pin: string, expiresAtIso: string): void {
  if (expiryTimers.has(pin)) return;
  const remainingMs = new Date(expiresAtIso).getTime() - Date.now();
  if (remainingMs <= 0) {
    void destroyRoom(pin, "expired");
    return;
  }
  const timer = setTimeout(() => {
    void destroyRoom(pin, "expired");
  }, remainingMs);
  expiryTimers.set(pin, timer);
}

export async function createRoom(): Promise<RoomRecord> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidatePin = String(randomInt(100_000, 1_000_000));
    const expiresAt = new Date(Date.now() + ROOM_TTL_MS).toISOString();
    const room: RoomRecord = {
      pin: candidatePin,
      text: "",
      expiresAt,
      files: [],
    };

    const success = await adapter.saveNewRoom(candidatePin, room, ROOM_TTL_SECONDS);
    if (success) {
      ensureExpiryTimer(candidatePin, expiresAt);
      return room;
    }
  }

  throw new Error("Unable to allocate a unique room PIN.");
}

export async function getRoom(pin: string): Promise<RoomRecord | undefined> {
  if (!/^\d{6}$/.test(pin)) return undefined;
  const room = await adapter.getRoom(pin);
  if (!room) return undefined;

  const remainingMs = new Date(room.expiresAt).getTime() - Date.now();
  if (remainingMs <= 0) {
    void destroyRoom(pin, "expired");
    return undefined;
  }

  ensureExpiryTimer(pin, room.expiresAt);
  return room;
}

export async function updateRoomText(pin: string, text: string): Promise<boolean> {
  const room = await getRoom(pin);
  if (!room) return false;
  if (text.length > MAX_TEXT_LENGTH) return false;

  room.text = text;

  // Compute strictly non-extending TTL
  const remainingSeconds = Math.max(
    1,
    Math.ceil((new Date(room.expiresAt).getTime() - Date.now()) / 1000),
  );

  await adapter.updateRoom(pin, room, remainingSeconds);
  return true;
}

const roomLocks = new Map<string, Promise<unknown>>();

export async function runWithRoomLock<T>(pin: string, fn: () => Promise<T>): Promise<T> {
  const currentLock = roomLocks.get(pin) || Promise.resolve();
  let release: () => void;
  const newLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  roomLocks.set(pin, currentLock.then(() => newLock));

  try {
    await currentLock;
    return await fn();
  } finally {
    release!();
    if (roomLocks.get(pin) === newLock) {
      roomLocks.delete(pin);
    }
  }
}

export async function addRoomFile(
  pin: string,
  fileMeta: { name: string; size: number; mimeType: string },
  buffer: Buffer,
): Promise<StoredRoomFile | null> {
  return runWithRoomLock(pin, async () => {
    const room = await getRoom(pin);
    if (!room) return null;
    if (room.files.length >= MAX_FILES_PER_ROOM) return null;
    if (buffer.length > MAX_FILE_SIZE) return null;

    const fileId = randomUUID();
    const storedFile: StoredRoomFile = {
      id: fileId,
      name: fileMeta.name,
      size: fileMeta.size,
      mimeType: fileMeta.mimeType,
      uploadedAt: new Date().toISOString(),
    };

    await adapter.uploadBlob(pin, fileId, buffer, fileMeta.mimeType);

    // Re-fetch latest room state after uploadBlob to serialize concurrent appends safely
    const freshRoom = await getRoom(pin);
    if (!freshRoom || freshRoom.files.length >= MAX_FILES_PER_ROOM) {
      return null;
    }

    freshRoom.files.push(storedFile);

    // Compute strictly non-extending TTL
    const remainingSeconds = Math.max(
      1,
      Math.ceil((new Date(freshRoom.expiresAt).getTime() - Date.now()) / 1000),
    );

    await adapter.updateRoom(pin, freshRoom, remainingSeconds);
    return storedFile;
  });
}

export async function downloadRoomFileBlob(
  pin: string,
  fileId: string,
): Promise<BlobDownloadResult | null> {
  const room = await getRoom(pin);
  if (!room) return null;
  const hasFile = room.files.some((f) => f.id === fileId);
  if (!hasFile) return null;

  return adapter.downloadBlob(pin, fileId);
}

export async function destroyRoom(pin: string, reason: RoomEndReason): Promise<boolean> {
  const timer = expiryTimers.get(pin);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(pin);
  }
  roomLocks.delete(pin);

  const room = await adapter.getRoom(pin);
  if (!room) {
    return false;
  }

  // Delete from Redis state & Azure Blob Storage concurrently
  await Promise.allSettled([
    adapter.deleteRoom(pin),
    adapter.deleteRoomBlobs(pin),
  ]);

  if (socketServer) {
    socketServer.to(pin).emit("session-expired", { reason });
    socketServer.in(pin).disconnectSockets(true);
  }

  return true;
}

export function broadcastFileAdded(pin: string, file: RoomFile): void {
  socketServer?.to(pin).emit("file-added", { file });
}

// ---------------------------------------------------------------------------
// Conversion Utilities (strictly adhering to @workspace/api-zod contracts)
// ---------------------------------------------------------------------------

export function toRoomResponse(room: RoomRecord): Room {
  return {
    pin: room.pin,
    text: room.text,
    expiresAt: new Date(room.expiresAt),
    files: room.files.map(toPublicFile),
  };
}

export function toSocketSnapshot(room: RoomRecord): RoomSocketSnapshot {
  return {
    pin: room.pin,
    text: room.text,
    expiresAt: new Date(room.expiresAt).toISOString(),
    files: room.files.map(toPublicFile),
  };
}

export function toPublicFile(file: StoredRoomFile): RoomFile {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    uploadedAt: new Date(file.uploadedAt),
  };
}
