// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Centralized HTTP Exception Handler & Error Formatting
//
// TODO: [Member A]
// 1. Trap all unhandled errors and format according to RFC 7807 (Problem Details).
// 2. Prevent leakage of sensitive database connection strings or stack traces in production.
// ==============================================================================

import { Request, Response, NextFunction } from "express";

export interface AppError extends Error {
  statusCode?: number;
  details?: unknown;
}

export function httpExceptionFilter(
  err: AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  console.error(`[Error] [${req.method} ${req.url}] ${statusCode} - ${message}`);
  if (err.stack && process.env.NODE_ENV !== "production") {
    console.error(err.stack);
  }

  res.status(statusCode).json({
    statusCode,
    error: statusCode >= 500 ? "InternalServerError" : "ClientError",
    message,
    details: err.details ?? null,
    timestamp: new Date().toISOString(),
    path: req.originalUrl,
  });
}
