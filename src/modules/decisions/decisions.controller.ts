// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Decisions HTTP Controller & Route Endpoints
//
// TODO: [Member A]
// 1. Map HTTP requests to decisionsService.
// 2. Enforce response codes according to `decision-replay-docs/api-contracts/decisions-api.md`.
// ==============================================================================

import { Router, Request, Response, NextFunction } from "express";
import { decisionsService } from "./decisions.service";
import { CreateDecisionSchema } from "./dto/create-decision.dto";
import { AppendTimelineSchema } from "./dto/append-timeline.dto";
import { validateBody } from "../../common/guards/validation.guard";

export const decisionsRouter = Router();

// POST /api/v1/decisions - Create and lock decision
decisionsRouter.post(
  "/",
  validateBody(CreateDecisionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const decision = await decisionsService.createDecision(req.body);
      res.status(201).json(decision);
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/v1/decisions - List decisions with query filters
decisionsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, projectId, category } = req.query;
    const decisions = await decisionsService.listDecisions({
      status: status as string | undefined,
      projectId: projectId as string | undefined,
      category: category as string | undefined,
    });
    res.json({ data: decisions, total: decisions.length });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/decisions/:id - Get frozen snapshot by ID
decisionsRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const decision = await decisionsService.getDecisionById(req.params.id);
    if (!decision) {
      res.status(404).json({ statusCode: 404, message: "Decision not found" });
      return;
    }
    res.json(decision);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/decisions/:id/events - Append evidence or note to timeline
decisionsRouter.post(
  "/:id/events",
  validateBody(AppendTimelineSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = await decisionsService.appendTimelineEvent(req.params.id, req.body);
      res.status(201).json(event);
    } catch (error) {
      next(error);
    }
  }
);
