// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: Replay Engine HTTP Controller & Route Endpoints
//
// TODO: [Member C]
// 1. Expose POST /api/v1/replay/:decisionId/outcome to submit outcome and run accuracy engine.
// 2. Expose GET /api/v1/replay/:decisionId to fetch expectation vs reality comparison diff.
// 3. Expose GET /api/v1/replay/patterns/summary for pattern aggregate stats.
// ==============================================================================

import { Router, Request, Response, NextFunction } from "express";
import { replayService } from "./replay.service";
import { RecordOutcomeSchema } from "./outcome.dto";
import { validateBody } from "../../common/guards/validation.guard";

export const replayRouter = Router();

// POST /api/v1/replay/:decisionId/outcome - Record outcome and run replay engine
replayRouter.post(
  "/:decisionId/outcome",
  validateBody(RecordOutcomeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await replayService.recordOutcome(req.params.decisionId, req.body);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/v1/replay/patterns/summary - Pattern summary across historical decisions
replayRouter.get("/patterns/summary", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await replayService.getPatternSummary();
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/replay/:decisionId - Side-by-side comparison between snapshot and reality
replayRouter.get("/:decisionId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const comparison = await replayService.getReplayComparison(req.params.decisionId);
    if (!comparison) {
      res.status(404).json({ statusCode: 404, message: "Replay comparison not available. Record an outcome first." });
      return;
    }
    res.json(comparison);
  } catch (error) {
    next(error);
  }
});
