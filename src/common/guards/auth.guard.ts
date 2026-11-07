// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Authentication & Authorization Guards
//
// TODO: [Member A]
// 1. In production, verify JWT bearer token from Authorization header.
// 2. Attach authenticated user details to `req.user`.
// 3. For local demo mode, supply a default demo user id.
// ==============================================================================

import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

export function authGuard(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // TODO: [Member A] Replace with production JWT verification logic
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    // Demo decoding / validation
    req.userId = "usr_demo_leader";
    return next();
  }

  // Fallback demo user for local development
  req.userId = "usr_demo_leader";
  next();
}
