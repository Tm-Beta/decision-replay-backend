// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: AI Analyst HTTP Controller & Challenger Endpoints
//
// TODO: [Member C]
// 1. Expose POST /api/v1/ai-analyst/challenge for real-time Socratic question generation.
// 2. Expose POST /api/v1/ai-analyst/replay-analysis for neutral post-mortem variance breakdown.
// ==============================================================================

import { Router, Request, Response, NextFunction } from "express";
import { aiAnalystService } from "./ai.service";
import { z } from "zod";
import { validateBody } from "../../common/guards/validation.guard";

export const aiRouter = Router();

const ChallengeRequestSchema = z.object({
  title: z.string(),
  choice: z.string(),
  decisionReason: z.string().optional(),
  expectedOutcome: z.string(),
  confidence: z.number().int().min(1).max(100),
  assumptions: z.array(z.object({ statement: z.string() })).default([]),
  alternatives: z.array(z.object({ title: z.string() })).default([]),
  preMortems: z.array(z.object({ failureScenario: z.string() })).default([]),
});

const ReplayAnalysisRequestSchema = z.object({
  decisionId: z.string(),
  expectedOutcome: z.string(),
  actualOutcome: z.string(),
  confidence: z.number().int(),
  outcomeScore: z.number().int(),
  assumptions: z.array(
    z.object({
      statement: z.string(),
      validated: z.boolean().nullable().optional(),
    })
  ).default([]),
});

// POST /api/v1/ai-analyst/challenge - Pre-decision Socratic provocation
aiRouter.post(
  "/challenge",
  validateBody(ChallengeRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const challenge = await aiAnalystService.generatePreDecisionChallenge(req.body);
      res.json(challenge);
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/v1/ai-analyst/replay-analysis - Post-replay variance analysis
aiRouter.post(
  "/replay-analysis",
  validateBody(ReplayAnalysisRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const analysis = await aiAnalystService.generatePostReplayAnalysis(req.body);
      res.json(analysis);
    } catch (error) {
      next(error);
    }
  }
);
