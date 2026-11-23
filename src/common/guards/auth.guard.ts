import { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/database";

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
      type: "https://decision-replay.dev/errors/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required. Please sign in with your Google account.",
    });
    return;
  }

  const token = authHeader.substring(7).trim();

  try {
    if (token.startsWith("usr_tok_")) {
      const parts = token.split("_");
      // Format: usr_tok_<cuid>_<base64email>
      if (parts.length >= 3 && parts[2]) {
        const userId = parts[2];
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, email: true },
        });

        if (user) {
          req.userId = user.id;
          req.userEmail = user.email;
          return next();
        }
      }
    }

    res.status(401).json({
      type: "https://decision-replay.dev/errors/invalid-token",
      title: "Unauthorized",
      status: 401,
      detail: "Invalid or expired session. Please sign in again with Google.",
    });
  } catch (error) {
    next(error);
  }
}

