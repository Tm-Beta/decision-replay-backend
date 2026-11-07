// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Application Bootstrap, Express Middleware & Route Mounting
//
// TODO: [Member A]
// 1. Initialize Express server with CORS, JSON body parser, and request logging.
// 2. Mount API modules: decisionsRouter, assumptionsRouter, replayRouter, dnaRouter, aiRouter.
// 3. Connect to database on launch and register graceful termination handlers.
// ==============================================================================

import express, { Express, Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

import { connectDatabase, disconnectDatabase } from "./config/database";
import { authGuard } from "./common/guards/auth.guard";
import { httpExceptionFilter } from "./common/filters/http-exception.filter";

import { decisionsRouter } from "./modules/decisions/decisions.controller";
import { assumptionsRouter } from "./modules/assumptions/assumptions.controller";
import { replayRouter } from "./modules/replay-engine/replay.controller";
import { dnaRouter } from "./modules/dna-engine/dna.controller";
import { aiRouter } from "./modules/ai-analyst/ai.controller";

const app: Express = express();
const port = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

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
app.use("/api/v1/decisions", authGuard, decisionsRouter);
app.use("/api/v1/assumptions", authGuard, assumptionsRouter);
app.use("/api/v1/replay", authGuard, replayRouter);
app.use("/api/v1/dna", authGuard, dnaRouter);
app.use("/api/v1/ai-analyst", authGuard, aiRouter);

// Global RFC 7807 Exception Filter
app.use(httpExceptionFilter);

async function bootstrap() {
  await connectDatabase();

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
