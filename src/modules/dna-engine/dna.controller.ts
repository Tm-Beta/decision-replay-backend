// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: Decision DNA HTTP Controller
//
// GET /api/v1/dna/profile   - six radar dimensions, each with evidence decision ids, plus patterns
// GET /api/v1/dna/patterns  - detected reasoning patterns only
// ==============================================================================

import { Router, Response, NextFunction } from "express";
import { dnaService } from "./dna.service";
import { AuthenticatedRequest } from "../../common/guards/auth.guard";

export const dnaRouter = Router();

// GET /api/v1/dna/profile - Return longitudinal Decision DNA profile
dnaRouter.get("/profile", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const profile = await dnaService.getDecisionDnaProfile(req.userId);
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/dna/patterns - Detected patterns with the decisions that prove them
dnaRouter.get("/patterns", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await dnaService.getPatterns(req.userId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});
