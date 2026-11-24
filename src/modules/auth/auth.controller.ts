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
    const { credential, accessToken } = req.body;
    if ((!credential || typeof credential !== "string") && (!accessToken || typeof accessToken !== "string")) {
      res.status(401).json({ message: "A verified Google sign-in is required." });
      return;
    }
    let verified;
    try {
      verified = typeof accessToken === "string" && accessToken
        ? await authService.verifyGoogleAccessToken(accessToken)
        : await authService.verifyGoogleToken(credential);
    } catch {
      res.status(401).json({ message: "Google sign-in could not be verified." });
      return;
    }
    const result = await authService.loginWithGoogle(verified);

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

