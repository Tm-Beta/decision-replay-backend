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
import { reviewPushRouter, startReviewPushWorker } from "./modules/review-push";
import { groupsRouter } from "./modules/groups";

const app: Express = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const port = process.env.PORT || 4000;

// Security Headers Middleware
app.use((_req: Request, res: Response, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
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
    exposedHeaders: ["Content-Disposition"],
  })
);

app.use(express.json({ limit: "1mb" }));

// Bounded Rate Limiter: strict on login & destructive routes, permissive for settings autosave
const rateLimitBuckets = new Map<string, { count: number; resetTime: number }>();

function createRateLimiter(maxRequests: number, scope: string) {
  return function rateLimiter(req: Request, res: Response, next: NextFunction) {
    const clientIp = req.ip || req.socket.remoteAddress || "client";
    const key = `${scope}:${clientIp}`;
    const now = Date.now();

    if (rateLimitBuckets.size > 1000) {
      for (const [k, v] of rateLimitBuckets.entries()) {
        if (now > v.resetTime) rateLimitBuckets.delete(k);
      }
    }

    const record = rateLimitBuckets.get(key);
    if (!record || now > record.resetTime) {
      rateLimitBuckets.set(key, { count: 1, resetTime: now + 60 * 1000 });
      return next();
    }

    if (record.count >= maxRequests) {
      return res.status(429).json({
        type: "https://soichose.com/errors/rate-limit-exceeded",
        title: "Too Many Requests",
        status: 429,
        detail: "Too many requests. Please wait a moment and try again.",
      });
    }

    record.count++;
    next();
  };
}

const strictAuthRateLimiter = createRateLimiter(25, "strict-auth");
const generalAuthRateLimiter = createRateLimiter(120, "general-auth");
const aiRateLimiter = createRateLimiter(35, "ai");

// Request logger
app.use((req: Request, _res: Response, next) => {
  console.log(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "so-i-chose-backend",
    timestamp: new Date().toISOString(),
  });
});

// Mount API routes
app.use("/api/v1/auth/google", strictAuthRateLimiter);
app.use("/api/v1/auth/account", strictAuthRateLimiter);
app.use("/api/v1/auth/clear-journal", strictAuthRateLimiter);
app.use("/api/v1/auth/import", strictAuthRateLimiter);
app.use("/api/v1/auth", generalAuthRateLimiter, authRouter);
app.use("/api/v1/chat", aiRateLimiter, authGuard, chatRouter);
app.use("/api/v1/review-push", authGuard, reviewPushRouter);
app.use("/api/v1/groups", authGuard, groupsRouter);
app.use("/api/v1/decisions", authGuard, decisionsRouter);
app.use("/api/v1/assumptions", authGuard, assumptionsRouter);
app.use("/api/v1/replay", authGuard, replayRouter);
app.use("/api/v1/dna", authGuard, dnaRouter);
app.use("/api/v1/ai-analyst", aiRateLimiter, authGuard, aiRouter);

// Global RFC 7807 Exception Filter
app.use(httpExceptionFilter);

async function bootstrap() {
  await connectDatabase();
  const stopReviewPush = startReviewPushWorker();

  const server = app.listen(port, () => {
    console.log(`🚀 So I Chose Backend running at http://localhost:${port}`);
    console.log(`📄 API Contracts available in decision-replay-docs/api-contracts/`);
  });

  const handleShutdown = async () => {
    stopReviewPush();
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
