# Ephemeral Sync ⚡

> **A temporary space between your devices. Move it over. Leave nothing behind.**

[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Ephemeral Sync** is a minimalist, privacy-first cross-device sync application. Need to quickly move a text snippet, code block, or files between your phone, laptop, or work desktop? Ephemeral Sync provides an instant disposable room paired via a 6-digit numeric PIN or QR code with **zero accounts, zero history, and automatic destruction after 15 minutes**.

---

## ✨ Features

- **No Accounts, No Tracking**: Instant entry with a 6-digit PIN. No registration, cookies, or personal data collection.
- **Strict 15-Minute Non-Extending Expiration**: Rooms strictly expire 15 minutes after creation. All text and files are permanently purged.
- **Instant "Burn Room" Destruction**: Close and wipe all room data and uploaded files across all devices on demand with a single click.
- **Real-Time Live Notepad**: Bi-directional text synchronization with character/word counter and quick clipboard copy.
- **Secure Ephemeral File Sharing**:
  - Up to **10 files** per room (strictly enforced).
  - Any file format supported up to **25 MB per file**.
  - Dropzone supporting multi-file drops with sequential upload handling.
  - Byte-accurate streaming downloads with content preservation.
- **Instant Mobile QR Pairing**: Scan a generated QR code with any smartphone camera to open the room instantly.
- **Clean Aesthetic & Dark/Light Mode**: Thoughtful high-contrast typography, distraction-free layout, and automatic theme persistence.
- **PWA & Mobile Ready**: Responsive mobile interface with tab toggling and progressive web app install prompt.
- **Free-Tier Keep-Alive**: Built-in 11-minute self-ping mechanism to prevent server idle sleep on free cloud tiers (e.g., Render).

---

## 🏗️ Architecture & Monorepo Structure

The repository is structured as a typed **pnpm workspace monorepo** driven by an **OpenAPI contract-first workflow**:

```text
Ephemeral-Sync-Rooms/
├── artifacts/
│   ├── api-server/             # Production Node.js + Express + Socket.IO API
│   │   ├── src/
│   │   │   ├── lib/            # Business logic, Redis & Azure adapters, logger
│   │   │   ├── routes/         # Express routes (rooms, upload, download, burn)
│   │   │   ├── app.ts          # Express app & CORS middleware
│   │   │   ├── index.ts        # Server entrypoint & keep-alive engine
│   │   │   └── verify-e2e.ts   # 6-step production acceptance gate suite
│   │   └── package.json
│   └── ephemeral-sync/         # Production React 19 + Vite 7 SPA
│       ├── src/
│       │   ├── App.tsx         # Main UI, real-time notepad, dropzone, QR
│       │   ├── main.tsx        # React root & API base URL configuration
│       │   └── index.css       # Clean utility typography and design tokens
│       └── package.json
├── lib/
│   ├── api-spec/               # Canonical OpenAPI 3.1 contract
│   │   └── openapi.yaml
│   ├── api-zod/                # Generated Zod validation schemas
│   └── api-client-react/       # Generated typed TanStack React Query hooks & fetcher
├── render.yaml                 # Render cloud deployment blueprint (Web Service)
├── vercel.json                 # Vercel deployment blueprint (Single-Page App)
├── pnpm-workspace.yaml         # Workspace monorepo definition
└── package.json                # Root build, typecheck, and verification scripts
```

### Storage Architecture
Ephemeral Sync features a decoupled storage adapter architecture:
- **Redis (`ioredis` / Upstash Redis)**: Holds transient room metadata, text content, file lists, and sets non-extending native Redis TTLs.
- **Azure Blob Storage (`@azure/storage-blob`)**: Stores uploaded file blobs temporarily, streaming them directly on download and destroying them on room expiration or burn.
- **In-Memory Mock Storage Adapter**: Activated automatically when external credentials are not set (`TEST_MOCK_STORAGE=true`), allowing zero-dependency local development and automated CI testing.

---

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Vite 7, Tailwind CSS, Lucide Icons, TanStack React Query, Socket.IO Client, QRCode, Wouter.
- **Backend**: Node.js, Express, TypeScript, Socket.IO Server, Multer, Pino HTTP logger, Express Rate Limit.
- **Storage / Cloud**: Redis (ioredis), Azure Blob Storage SDK (`@azure/storage-blob`).
- **Code Generation & Contracts**: Orval, Zod, OpenAPI 3.1.
- **Hosting Targets**:
  - API Server: [Render](https://render.com) (Node.js Web Service)
  - Web Client: [Vercel](https://vercel.com) (Static SPA)

---

## 🚀 Quickstart & Local Development

### Prerequisites
- **Node.js**: v20 or v22+
- **pnpm**: v9+ (`corepack enable pnpm` or `npm install -g pnpm`)

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/Siddhant-Bind/ephemeral-sync-v1.0.git
cd ephemeral-sync-v1.0
pnpm install
```

### 2. Configure Environment Variables
Copy `.env.example` to create your local `.env` file:
```bash
cp .env.example .env
```

For local testing, no Redis or Azure credentials are required; the server automatically uses the built-in memory storage mock if credentials are not specified.

### 3. Run Development Servers
Start both the API server (port 5000) and the Vite frontend (port 5173) in parallel:
```bash
pnpm run dev
```

Open your browser at:
```
http://localhost:5173
```

---

## 🧪 Production Acceptance Suite

The project includes an end-to-end verification gate that validates workspace hygiene, TypeScript compilation, bundle build, REST API contracts, Socket.IO live sync, strict 15-minute TTL integrity, 10-file upload limit, and byte-exact download streaming:

```bash
pnpm run verify:prod
```

### Gates Verified:
1. **Gate 1: Hygiene**: Verifies workspace is free of deprecated legacy files and ensures docs/examples exist.
2. **Gate 5.1: Health**: Validates `GET /api/healthz`.
3. **Gate 5.2: Create Room**: Validates room PIN allocation with strict 15-minute non-extending ISO expiration.
4. **Gate 5.3: Socket Sync & TTL**: Validates real-time text sync and ensures updates never extend room expiry.
5. **Gate 5.4: File Stream**: Uploads file, broadcasts via socket, downloads blob, and verifies byte-for-byte checksum.
6. **Gate 5.4.1: 10-File Limit**: Enforces the strict maximum of 10 uploads per room (11th upload rejected with HTTP 429).
7. **Gate 5.5: Burn Cleanup**: Destroys room, confirms `session-expired` socket broadcast, and verifies immediate 404 on room and files.
8. **Gate 6: Teardown**: Cleans up all server sockets, timers, and storage adapters cleanly.

---

## 🌐 Production Deployment

### Backend: Render
1. Connect your repository to [Render](https://render.com).
2. Create a new **Web Service** (or use the included `render.yaml`).
3. Set the following environment variables:
   | Variable | Value / Description |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `PORT` | `10000` |
   | `CORS_ORIGIN` | `https://your-frontend.vercel.app` |
   | `REDIS_URL` | `rediss://...` (e.g. from Upstash or Redis Cloud) |
   | `AZURE_STORAGE_CONNECTION_STRING` | Your Azure Storage connection string |
   | `AZURE_STORAGE_CONTAINER_NAME` | `ephemeral-uploads` |
4. Set Build Command: `pnpm install && pnpm run build:api`
5. Set Start Command: `node artifacts/api-server/dist/index.mjs`

### Frontend: Vercel
1. Import your repository into [Vercel](https://vercel.com).
2. Select **Root Directory**: leave default (`.`) or point to project root.
3. Set Framework Preset: **Vite**.
4. Configure Build & Output Settings:
   - Build Command: `pnpm --filter @workspace/ephemeral-sync run build`
   - Output Directory: `artifacts/ephemeral-sync/dist/public`
5. Add Environment Variable:
   | Variable | Value |
   | --- | --- |
   | `VITE_API_BASE_URL` | `https://your-backend.onrender.com` |

---

## 🔒 Security & Privacy Guarantees

- **No User Accounts**: There are no logins, emails, hashed passwords, or session cookies stored.
- **Zero Long-Term Storage**: Files and text are retained only in volatile storage (Redis memory & Azure blob container) and automatically purged when the 15-minute countdown elapses or when burned by the user.
- **Non-Extending Expiration**: Typing in the notepad or uploading a file does **not** reset the 15-minute timer.
- **File Sanitization**: Uploaded filenames are sanitized and cleaned of control characters, traversal attempts, and length-restricted to prevent storage vulnerabilities.
- **Rate-Limited Endpoints**: Room creation, reading, and file uploading are protected by IP-based rate limiting to prevent spam and denial of service.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
