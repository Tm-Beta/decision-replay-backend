// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Application Bootstrap, Express Middleware & Route Mounting
//
// TODO: [Member A]
// 1. Initialize Express server with CORS, JSON body parser, and request logging.
// 2. Mount API modules: decisionsRouter, assumptionsRouter, replayRouter, dnaRouter, aiRouter.
// 3. Connect to database on launch and register graceful termination handlers.
// ==============================================================================

import "dotenv/config";
import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";


import { connectDatabase, disconnectDatabase } from "./config/database";
import { authGuard } from "./common/guards/auth.guard";
import { httpExceptionFilter } from "./common/filters/http-exception.filter";

import { decisionsRouter } from "./modules/decisions/decisions.controller";
import { assumptionsRouter } from "./modules/assumptions/assumptions.controller";
import { replayRouter } from "./modules/replay-engine/replay.controller";
import { dnaRouter } from "./modules/dna-engine/dna.controller";
import { aiRouter } from "./modules/ai-analyst/ai.controller";
import { authRouter } from "./modules/auth/auth.controller";

import { chatRouter } from "./modules/chat";
import { groupsRouter, recoverUngrouped } from "./modules/groups";

const app: Express = express();
const port = process.env.PORT || 4000;

// Security Headers Middleware
app.use((_req: Request, res: Response, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// Production-ready CORS with trusted origins
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== "production") {
        callback(null, true);
      } else {
        callback(new Error("Origin not permitted by CORS policy"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "2mb" }));

// In-Memory Rate Limiter for Auth Endpoint (Protection against brute-force / DDoS)
const authRateLimitMap = new Map<string, { count: number; resetTime: number }>();
function authRateLimiter(req: Request, res: Response, next: NextFunction) {
  const clientIp = req.ip || req.socket.remoteAddress || "client";
  const now = Date.now();
  const record = authRateLimitMap.get(clientIp);

  if (!record || now > record.resetTime) {
    authRateLimitMap.set(clientIp, { count: 1, resetTime: now + 60 * 1000 });
    return next();
  }

  if (record.count >= 30) {
    return res.status(429).json({
      type: "https://decision-replay.dev/errors/rate-limit-exceeded",
      title: "Too Many Requests",
      status: 429,
      detail: "Rate limit exceeded on authentication endpoint. Please wait 60 seconds.",
    });
  }

  record.count++;
  next();
}

// Request logger
app.use((req: Request, _res: Response, next) => {
  console.log(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "decision-replay-backend",
    timestamp: new Date().toISOString(),
  });
});

// Mount API routes
app.use("/api/v1/auth", authRateLimiter, authRouter);
app.use("/api/v1/chat", authGuard, chatRouter);
app.use("/api/v1/groups", authGuard, groupsRouter);
app.use("/api/v1/decisions", authGuard, decisionsRouter);
app.use("/api/v1/assumptions", authGuard, assumptionsRouter);
app.use("/api/v1/replay", authGuard, replayRouter);
app.use("/api/v1/dna", authGuard, dnaRouter);
app.use("/api/v1/ai-analyst", authGuard, aiRouter);

// Global RFC 7807 Exception Filter
app.use(httpExceptionFilter);

async function bootstrap() {
  await connectDatabase();
  await recoverUngrouped();

  const server = app.listen(port, () => {
    console.log(`🚀 Decision Replay Backend running at http://localhost:${port}`);
    console.log(`📄 API Contracts available in decision-replay-docs/api-contracts/`);
  });

  const handleShutdown = async () => {
    console.log("\n[Server] Shutting down gracefully...");
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}

bootstrap().catch((err) => {
  console.error("[Bootstrap] Fatal error:", err);
  process.exit(1);
});
