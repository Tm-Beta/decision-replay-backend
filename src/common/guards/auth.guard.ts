import { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/database";
import { verifySessionToken } from "../security/token.utils";

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userEmail?: string;
}

export async function authGuard(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      type: "https://soichose.com/errors/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required. Please sign in with your Google account.",
    });
    return;
  }

  const token = authHeader.substring(7).trim();

  try {
    const verified = verifySessionToken(token);

    if (verified && verified.userId) {
      const user = await prisma.user.findUnique({
        where: { id: verified.userId },
        select: { id: true, email: true },
      });

      if (user && (!verified.email || user.email.toLowerCase() === verified.email.toLowerCase())) {
        req.userId = user.id;
        req.userEmail = user.email;
        return next();
      }
    }

    res.status(401).json({
      type: "https://soichose.com/errors/invalid-token",
      title: "Unauthorized",
      status: 401,
      detail: "Invalid or expired session. Please sign in again with Google.",
    });
  } catch (error) {
    next(error);
  }
}

