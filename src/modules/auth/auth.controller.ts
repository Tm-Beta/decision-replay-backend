import express, { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authService } from "./auth.service";
import { AuthenticatedRequest, authGuard } from "../../common/guards/auth.guard";
import {
  decryptBackupVault,
  encryptBackupVault,
  InvalidBackupVaultError,
  MAX_BACKUP_FILE_BYTES,
} from "../../common/security/backup.crypto";

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
authRouter.get("/me", authGuard, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({
        type: "https://soichose.com/errors/unauthorized",
        title: "Unauthorized",
        status: 401,
        detail: "No active session found.",
      });
      return;
    }

    const user = await authService.getCurrentUser(userId);
    if (!user) {
      res.status(404).json({
        type: "https://soichose.com/errors/user-not-found",
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

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const preferencesSchema = z.object({
  onboardingCompleted: z.boolean().optional(),
  themeMode: z.enum(["dark", "light"]).optional(),
  presetId: z.string().max(40).optional(),
  primaryColor: hexColor.optional(),
  accentColor: hexColor.optional(),
  vortexIntensity: z.number().min(0).max(100).optional(),
  defaultLanding: z.enum(["/", "/decisions", "/dna"]).optional(),
  defaultReviewDays: z.number().int().min(1).max(365).optional(),
  showFloatingArt: z.boolean().optional(),
  persona: z
    .object({
      role: z
        .enum([
          "student",
          "professional",
          "founder",
          "creator",
          "parent",
          "researcher",
          "explorer",
          "mindful",
          "other",
        ])
        .optional(),
      customRole: z.string().trim().max(32).optional(),
      ageGroup: z.enum(["under_20", "20_26", "27_35", "36_45", "46_plus"]).optional(),
      goal: z
        .enum([
          "life_career",
          "ideas_projects",
          "daily_habits",
          "tough_calls",
          "studies_skills",
          "money_investing",
          "relationships",
          "creative_growth",
          "other",
        ])
        .optional(),
      customGoal: z.string().trim().max(40).optional(),
    })
    .optional(),
  character: z
    .object({
      id: z.enum(["sprout", "lumi", "pebble", "spark", "mochi", "nova"]).optional(),
      name: z.string().trim().min(1).max(24).optional(),
      color: z.union([z.literal("auto"), hexColor]).optional(),
      shape: z.enum(["classic", "tall", "chubby", "drop"]).optional(),
      eyes: z.enum(["dots", "starry", "calm"]).optional(),
      accessory: z
        .enum(["none", "leaf", "halo", "glasses", "bowtie", "crown"])
        .optional(),
      energy: z.enum(["calm", "lively", "minimal"]).optional(),
      tone: z.enum(["warm", "direct", "socratic", "playful"]).optional(),
      chattiness: z.enum(["concise", "balanced", "detailed"]).optional(),
    })
    .optional(),
});

/**
 * PATCH /api/v1/auth/preferences
 * Persists user theme, color palette, and companion character preferences.
 */
authRouter.patch("/preferences", authGuard, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ message: "No active session found." });
      return;
    }
    const parsed = preferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Please check your settings values." });
      return;
    }
    const user = await authService.updatePreferences(userId, parsed.data);
    res.status(200).json({ status: "success", data: user });
  } catch (error) {
    next(error);
  }
});

const rawBackupParser = express.raw({
  type: ["application/octet-stream", "application/x-soichose"],
  limit: MAX_BACKUP_FILE_BYTES,
});

/**
 * GET /api/v1/auth/export
 * Encrypts and downloads all user decisions, collections, outcomes, and chat history as a `.soichose` vault.
 */
authRouter.get("/export", authGuard, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.userId) {
      res.status(401).json({ message: "No active session found." });
      return;
    }
    const backup = await authService.exportUserData(req.userId);
    const vaultBuffer = encryptBackupVault(backup);
    const dateStamp = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="soichose-backup-${dateStamp}.soichose"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200).send(vaultBuffer);
  } catch (error) {
    next(error);
  }
});

const importNodeType = z.enum(["DECISION", "OUTCOME", "PLAN"]);
const importBackupPayloadSchema = z.object({
  app: z.literal("So I Chose"),
  exportedAt: z.string().max(64).optional(),
  version: z.number().int().optional(),
  user: z
    .object({
      preferences: preferencesSchema.optional(),
    })
    .nullable()
    .optional(),
  projects: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        purpose: z.string().max(4000).default(""),
        desiredOutcome: z.string().max(4000).default(""),
        status: z.enum(["ACTIVE", "ARCHIVED", "COMPLETED"]).default("ACTIVE"),
        horizon: z.string().max(64).default("MEDIUM_TERM"),
        constraints: z.string().max(8000).default("[]"),
        principles: z.string().max(8000).default("[]"),
        plans: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              status: z.string().max(32).default("OPEN"),
              nodeType: z.enum(["DECISION", "OUTCOME"]).default("DECISION"),
              joinRule: z.enum(["ANY", "ALL"]).default("ANY"),
              originId: z.string().max(64).nullable().optional(),
              parentPlanId: z.string().max(64).nullable().optional(),
              title: z.string().max(300).default("Untitled plan"),
              expectedOutcome: z.string().max(4000).default(""),
            }),
          )
          .max(200)
          .default([]),
        graphLinks: z
          .array(
            z.object({
              fromType: importNodeType,
              fromId: z.string().min(1).max(64),
              toType: importNodeType,
              toId: z.string().min(1).max(64),
              label: z.string().max(200).optional(),
            }),
          )
          .max(500)
          .default([]),
      }),
    )
    .max(100)
    .default([]),
  decisions: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        title: z.string().max(300).default("Untitled decision"),
        category: z.string().max(64).default("GENERAL"),
        projectId: z.string().max(64).nullable().optional(),
        parentId: z.string().max(64).nullable().optional(),
        planId: z.string().max(64).nullable().optional(),
        joinRule: z.enum(["ANY", "ALL"]).optional(),
        influences: z.string().max(8000).optional(),
        decidedOn: z.string().max(64).nullable().optional(),
        outcomeKnown: z.boolean().nullable().optional(),
        context: z.string().max(16000).default(""),
        decisionReason: z.string().max(8000).optional(),
        beliefRationale: z.string().max(8000).optional(),
        choice: z.string().max(8000).default(""),
        expectedOutcome: z.string().max(8000).default(""),
        confidence: z.number().int().min(1).max(100).nullable().optional(),
        status: z.string().max(32).default("LOCKED"),
        reviewDate: z.string().max(64).nullable().optional(),
        assumptions: z
          .array(
            z.object({
              statement: z.string().max(2000),
              metricTarget: z.string().max(500).nullable().optional(),
              metricActual: z.string().max(500).nullable().optional(),
              confidence: z.number().int().min(0).max(100).default(50),
              validated: z.boolean().nullable().optional(),
            }),
          )
          .max(50)
          .default([]),
        alternatives: z
          .array(
            z.object({
              title: z.string().max(500),
              pros: z.string().max(4000).default(""),
              cons: z.string().max(4000).default(""),
              selected: z.boolean().default(false),
            }),
          )
          .max(30)
          .default([]),
        preMortems: z
          .array(
            z.object({
              failureScenario: z.string().max(4000),
              preventiveAction: z.string().max(4000).default(""),
              severityScore: z.number().int().min(0).max(100).default(50),
              occurredInReality: z.boolean().nullable().optional(),
            }),
          )
          .max(30)
          .default([]),
        events: z
          .array(
            z.object({
              eventType: z.string().max(32).default("EVIDENCE_NOTE"),
              title: z.string().max(300),
              detail: z.string().max(8000).default(""),
              metadataJson: z.string().max(32000).nullable().optional(),
            }),
          )
          .max(150)
          .default([]),
        outcome: z
          .object({
            actualOutcome: z.string().max(8000),
            outcomeScore: z.number().int().min(0).max(100).nullable().optional(),
            predictionAccuracy: z.number().int().min(0).max(100).nullable().optional(),
            reflection: z.string().max(8000).default(""),
            wouldRepeat: z.boolean().nullable().optional(),
            unexpectedFactors: z.string().max(4000).optional(),
          })
          .nullable()
          .optional(),
        outcomeBranches: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              projectId: z.string().min(1).max(64),
              planId: z.string().max(64).nullable().optional(),
              title: z.string().max(300).default("Outcome branch"),
              detail: z.string().max(4000).default(""),
              isPrimary: z.boolean().default(false),
            }),
          )
          .max(30)
          .default([]),
        snapshot: z
          .object({
            contentHash: z.string().max(128),
            payloadJson: z.string().max(100000),
          })
          .nullable()
          .optional(),
      }),
    )
    .max(500)
    .default([]),
  chatSessions: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        projectId: z.string().max(64).nullable().optional(),
        title: z.string().max(200).default("Chat"),
      }),
    )
    .max(200)
    .optional(),
  chatMessages: z
    .array(
      z.object({
        projectId: z.string().max(64).nullable().optional(),
        sessionId: z.string().max(64).nullable().optional(),
        role: z.enum(["user", "assistant"]),
        content: z.string().max(16000),
      }),
    )
    .max(1000)
    .optional(),
});

function parseVerifiedVaultRequest(body: unknown) {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new InvalidBackupVaultError("Please upload an encrypted .soichose backup file.");
  }
  const decrypted = decryptBackupVault(body);
  const parsed = importBackupPayloadSchema.safeParse(decrypted);
  if (!parsed.success) {
    throw new InvalidBackupVaultError("Backup payload schema validation failed.");
  }
  return parsed.data;
}

/**
 * POST /api/v1/auth/import/inspect
 * Cryptographically verifies and inspects an encrypted `.soichose` backup without modifying DB.
 */
authRouter.post(
  "/import/inspect",
  authGuard,
  rawBackupParser,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.userId) {
        res.status(401).json({ message: "No active session found." });
        return;
      }
      const data = parseVerifiedVaultRequest(req.body);
      const prefs = data.user?.preferences as Record<string, unknown> | undefined;
      res.status(200).json({
        status: "success",
        data: {
          verified: true,
          exportedAt: data.exportedAt ?? null,
          projectsCount: data.projects.length,
          decisionsCount: data.decisions.length,
          chatsCount: data.chatMessages?.length ?? 0,
          hasPrefs: Boolean(prefs && Object.keys(prefs).length > 0),
        },
      });
    } catch (error) {
      if (error instanceof InvalidBackupVaultError) {
        res.status(400).json({ message: error.message });
        return;
      }
      next(error);
    }
  },
);

/**
 * POST /api/v1/auth/import
 * Cryptographically verifies, decrypts, and imports a `.soichose` backup with fresh ID remapping.
 */
authRouter.post(
  "/import",
  authGuard,
  rawBackupParser,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.userId) {
        res.status(401).json({ message: "No active session found." });
        return;
      }
      const data = parseVerifiedVaultRequest(req.body);
      const restorePreferences = req.query.restorePreferences === "true";

      const summary = await authService.importUserData(
        req.userId,
        {
          ...data,
          preferences: data.user?.preferences as Record<string, unknown> | undefined,
        },
        restorePreferences,
      );
      res.status(200).json({ status: "success", data: summary });
    } catch (error) {
      if (error instanceof InvalidBackupVaultError) {
        res.status(400).json({ message: error.message });
        return;
      }
      next(error);
    }
  },
);

/**
 * DELETE /api/v1/auth/chat-history
 * Clears all companion chat messages for the current user.
 */
authRouter.delete("/chat-history", authGuard, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.userId) {
      res.status(401).json({ message: "No active session found." });
      return;
    }
    await authService.clearChatHistory(req.userId);
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/auth/clear-journal
 * Permanently clears all decisions, collections, and chat history while keeping account & settings.
 */
authRouter.post("/clear-journal", authGuard, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.userId) {
      res.status(401).json({ message: "No active session found." });
      return;
    }
    if (req.body?.confirmation !== "CLEAR JOURNAL") {
      res.status(400).json({ message: 'Type "CLEAR JOURNAL" to confirm.' });
      return;
    }
    await authService.clearJournalData(req.userId);
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/auth/account
 * Permanently deletes the user's account and all associated data.
 */
authRouter.delete("/account", authGuard, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.userId) {
      res.status(401).json({ message: "No active session found." });
      return;
    }
    if (req.body?.confirmation !== "DELETE MY ACCOUNT") {
      res.status(400).json({ message: 'Type "DELETE MY ACCOUNT" to confirm.' });
      return;
    }
    await authService.deleteAccountPermanently(req.userId);
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});

