import { Router, Request, Response, NextFunction } from "express";
import { authService } from "./auth.service";
import { AuthenticatedRequest } from "../../common/guards/auth.guard";

export const authRouter = Router();

/**
 * POST /api/v1/auth/google
 * Authenticates or registers a user via Google credentials or GIS ID Token.
 */
authRouter.post("/google", async (req: Request, res: Response, next: NextFunction) => {
  try {
    let { email, name, avatar, googleId, credential } = req.body;

    // Decode official Google Identity Services (GSI) credential JWT if provided
    if (credential && typeof credential === "string") {
      try {
        const parts = credential.split(".");
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
          if (payload.email) {
            email = payload.email;
            name = payload.name || name || email.split("@")[0];
            avatar = payload.picture || avatar;
            googleId = payload.sub || googleId;
          }
        }
      } catch (decodeErr) {
        console.warn("Failed to decode Google JWT payload, falling back to body fields:", decodeErr);
      }
    }

    if (!email) {
      res.status(400).json({
        type: "https://decision-replay.dev/errors/missing-email",
        title: "Bad Request",
        status: 400,
        detail: "Email or verified Google credential is required for Google authentication.",
      });
      return;
    }

    const result = await authService.loginWithGoogle({
      email,
      name: name || email.split("@")[0],
      avatar,
      googleId,
    });

    res.status(200).json({
      status: "success",
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/auth/me
 * Retrieves current authenticated user.
 */
authRouter.get("/me", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({
        type: "https://decision-replay.dev/errors/unauthorized",
        title: "Unauthorized",
        status: 401,
        detail: "No active session found.",
      });
      return;
    }

    const user = await authService.getCurrentUser(userId);
    if (!user) {
      res.status(404).json({
        type: "https://decision-replay.dev/errors/user-not-found",
        title: "User Not Found",
        status: 404,
        detail: "User record does not exist.",
      });
      return;
    }

    res.status(200).json({
      status: "success",
      data: user,
    });
  } catch (error) {
    next(error);
  }
});

