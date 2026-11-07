// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: Decision DNA HTTP Controller
//
// TODO: [Member C]
// 1. Expose GET /api/v1/dna/profile to return multi-dimensional radar scores and evidence.
// ==============================================================================

import { Router, Request, Response, NextFunction } from "express";
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
