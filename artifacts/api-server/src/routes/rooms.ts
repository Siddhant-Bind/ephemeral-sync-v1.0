import path from "node:path";
import {
  BurnRoomParams,
  CreateRoomResponse,
  DownloadRoomFileParams,
  GetRoomParams,
  GetRoomResponse,
  UploadRoomFileParams,
  UploadRoomFileResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import {
  addRoomFile,
  broadcastFileAdded,
  createRoom,
  destroyRoom,
  downloadRoomFileBlob,
  getRoom,
  toPublicFile,
  toRoomResponse,
  MAX_FILES_PER_ROOM,
  MAX_FILE_SIZE,
} from "../lib/rooms";

const router: IRouter = Router();

const createRoomLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many rooms created. Try again in a few minutes." },
});

const roomReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many room requests. Try again shortly." },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many upload attempts. Try again shortly." },
});

const burnLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many burn requests. Try again shortly." },
});

// Multer memory storage - accepts any format up to 25 MB
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

async function parsePin(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
): Promise<void> {
  const parsed = UploadRoomFileParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "PIN must contain six digits." });
    return;
  }

  const room = await getRoom(parsed.data.pin);
  if (!room) {
    res.status(404).json({ error: "Room not found or expired." });
    return;
  }
  if (room.files.length >= MAX_FILES_PER_ROOM) {
    res.status(429).json({ error: "This room has reached its 10-file limit." });
    return;
  }

  next();
}

function runUploadMiddleware(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
): void {
  fileUpload.single("file")(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Files must be 25 MB or smaller." });
        return;
      }
      if (error.code === "LIMIT_FILE_COUNT") {
        res.status(400).json({ error: "Upload one file at a time." });
        return;
      }
    }

    const message =
      error instanceof Error ? error.message : "The file could not be uploaded.";
    res.status(400).json({ error: message });
  });
}

function safeDisplayName(originalName: string): string {
  const basename = path.basename(originalName.replaceAll("\\", "/"));
  const cleaned = basename.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 180) || "shared-file";
}

router.post("/rooms", createRoomLimiter, async (_req, res): Promise<void> => {
  const room = await createRoom();
  const response = CreateRoomResponse.parse(toRoomResponse(room));
  res.status(201).json(response);
});

router.get("/rooms/:pin", roomReadLimiter, async (req, res): Promise<void> => {
  const params = GetRoomParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "PIN must contain six digits." });
    return;
  }

  const room = await getRoom(params.data.pin);
  if (!room) {
    res.status(404).json({ error: "Room not found or expired." });
    return;
  }

  res.json(GetRoomResponse.parse(toRoomResponse(room)));
});

router.delete("/rooms/:pin", burnLimiter, async (req, res): Promise<void> => {
  const params = BurnRoomParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "PIN must contain six digits." });
    return;
  }

  const removed = await destroyRoom(params.data.pin, "burned");
  if (!removed) {
    res.status(404).json({ error: "Room not found or expired." });
    return;
  }

  res.sendStatus(204);
});

router.post(
  "/upload/:pin",
  uploadLimiter,
  parsePin,
  runUploadMiddleware,
  async (req, res): Promise<void> => {
    const params = UploadRoomFileParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "PIN must contain six digits." });
      return;
    }
    if (!req.file || !req.file.buffer) {
      res.status(400).json({ error: "Choose a file before uploading." });
      return;
    }

    const room = await getRoom(params.data.pin);
    if (!room) {
      res.status(404).json({ error: "Room not found or expired." });
      return;
    }
    if (room.files.length >= MAX_FILES_PER_ROOM) {
      res.status(429).json({ error: "This room has reached its 10-file limit." });
      return;
    }

    const metadata = await addRoomFile(
      params.data.pin,
      {
        name: safeDisplayName(req.file.originalname),
        size: req.file.size,
        mimeType: req.file.mimetype || "application/octet-stream",
      },
      req.file.buffer,
    );

    if (!metadata) {
      const checkRoom = await getRoom(params.data.pin);
      if (!checkRoom) {
        res.status(404).json({ error: "Room not found or expired." });
        return;
      }
      if (checkRoom.files.length >= MAX_FILES_PER_ROOM) {
        res.status(429).json({ error: "This room has reached its 10-file limit." });
        return;
      }
      res.status(400).json({ error: "Could not upload file to room." });
      return;
    }

    const response = UploadRoomFileResponse.parse(toPublicFile(metadata));
    broadcastFileAdded(params.data.pin, response);
    res.status(201).json(response);
  },
);

router.get(
  "/rooms/:pin/files/:fileId/download",
  roomReadLimiter,
  async (req, res): Promise<void> => {
    const params = DownloadRoomFileParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid room or file identifier." });
      return;
    }

    const room = await getRoom(params.data.pin);
    const file = room?.files.find((entry) => entry.id === params.data.fileId);
    if (!room || !file) {
      res.status(404).json({ error: "File not found or expired." });
      return;
    }

    const blobData = await downloadRoomFileBlob(params.data.pin, params.data.fileId);
    if (!blobData) {
      res.status(404).json({ error: "File not found or expired." });
      return;
    }

    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    const safeEncodedName = encodeURIComponent(file.name);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.name.replace(/"/g, '\\"')}"; filename*=UTF-8''${safeEncodedName}`,
    );
    res.setHeader("Content-Length", String(blobData.contentLength || file.size));
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (Buffer.isBuffer(blobData.stream)) {
      res.end(blobData.stream);
    } else {
      blobData.stream.pipe(res);
    }
  },
);

export default router;
