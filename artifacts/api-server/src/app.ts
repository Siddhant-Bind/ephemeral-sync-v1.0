import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { getCorsOriginConfig } from "./lib/cors";

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => {
        const url = req.url?.split("?")[0];
        return url === "/api/healthz" || url === "/healthz";
      },
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0].replace(/\/\d{6}(?=\/|$)/g, "/[pin]"),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

const corsOrigin = getCorsOriginConfig(process.env.CORS_ORIGIN);
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    exposedHeaders: ["Content-Disposition", "Content-Length"],
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Root-level health check endpoint for cloud platforms & uptime monitors
app.get("/healthz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ status: "ok" });
});

// Friendly root endpoint
app.get("/", (_req, res) => {
  res.status(200).json({
    name: "Ephemeral Sync API Server",
    status: "ok",
    webAppUrl: process.env.WEB_APP_URL || "http://localhost:5173",
    healthCheck: "/api/healthz",
  });
});

app.use("/api", router);

export default app;
