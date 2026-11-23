import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

export function authGuard(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if (token.startsWith("usr_tok_")) {
      const parts = token.split("_");
      if (parts.length >= 3 && parts[2]) {
        req.userId = parts[2];
        return next();
      }
    }
    // Fallback if generic bearer token passed
    req.userId = "usr_demo_leader";
    return next();
  }

  // Fallback demo user for local development and unauthenticated guests
  req.userId = "usr_demo_leader";
  next();
}
