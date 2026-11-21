// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: AI Analyst HTTP Controller & Challenger Endpoints
//
// POST /api/v1/ai-analyst/challenge        - real-time Socratic questions
// POST /api/v1/ai-analyst/replay-analysis  - neutral post-mortem variance breakdown
//
// Request limits keep prompts (and cost) bounded. `metricTarget` on assumptions is optional.
// ==============================================================================

import { Router, Request, Response, NextFunction } from "express";
import { aiAnalystService } from "./ai.service";
import { z } from "zod";
import { validateBody } from "../../common/guards/validation.guard";

export const aiRouter = Router();

const ChallengeRequestSchema = z.object({
  title: z.string().max(200),
  choice: z.string().max(2000),
  decisionReason: z.string().max(2000).optional(),
  expectedOutcome: z.string().max(2000),
  confidence: z.number().int().min(1).max(100),
  assumptions: z
    .array(z.object({ statement: z.string().max(500), metricTarget: z.string().max(100).optional() }))
    .max(20)
    .default([]),
  alternatives: z.array(z.object({ title: z.string().max(200) })).max(20).default([]),
  preMortems: z.array(z.object({ failureScenario: z.string().max(500) })).max(20).default([]),
});

const ReplayAnalysisRequestSchema = z.object({
  decisionId: z.string(),
  expectedOutcome: z.string().max(2000),
  actualOutcome: z.string().max(2000),
  confidence: z.number().int().min(0).max(100),
  outcomeScore: z.number().int().min(0).max(100),
  assumptions: z
    .array(
      z.object({
        statement: z.string().max(500),
        validated: z.boolean().nullable().optional(),
      })
    )
    .max(20)
    .default([]),
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
