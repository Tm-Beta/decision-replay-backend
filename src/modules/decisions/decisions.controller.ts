// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Decisions HTTP Controller & Route Endpoints
//
// TODO: [Member A]
// 1. Map HTTP requests to decisionsService.
// 2. Enforce response codes according to `decision-replay-docs/api-contracts/decisions-api.md`.
// ==============================================================================

import { Router, Response, NextFunction } from "express";
import { prisma } from "../../config/database";
import { decisionsService } from "./decisions.service";
import { CreateDecisionSchema } from "./dto/create-decision.dto";
import { AppendTimelineSchema } from "./dto/append-timeline.dto";
import { validateBody } from "../../common/guards/validation.guard";
import { AuthenticatedRequest } from "../../common/guards/auth.guard";

export const decisionsRouter = Router();

// POST /api/v1/decisions - Create and lock decision
decisionsRouter.post(
  "/",
  validateBody(CreateDecisionSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const decision = await decisionsService.createDecision(
        req.body,
        req.userId,
      );
      res.status(201).json(decision);
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/v1/decisions - List decisions with query filters scoped to authenticated user
decisionsRouter.get(
  "/",
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { status, projectId, category } = req.query;
      const decisions = await decisionsService.listDecisions({
        status: status as string | undefined,
        projectId: projectId as string | undefined,
        category: category as string | undefined,
        userId: req.userId,
      });
      res.json({ data: decisions, total: decisions.length });
    } catch (error) {
      next(error);
    }
  },
);

decisionsRouter.get(
  "/due-reviews",
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const now = new Date();
      res.json(
        await prisma.decision.findMany({
          where: {
            userId: req.userId,
            outcome: null,
            OR: [
              { nextReminder: { lte: now } },
              { nextReminder: null, reviewDate: { lte: now } },
            ],
          },
          select: {
            id: true,
            title: true,
            project: { select: { name: true } },
          },
          orderBy: { createdAt: "asc" },
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/decisions/:id - Get frozen snapshot by ID
decisionsRouter.get(
  "/:id",
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const decision = await decisionsService.getDecisionById(
        req.params.id,
        req.userId,
      );
      if (!decision) {
        res
          .status(404)
          .json({ statusCode: 404, message: "Decision not found" });
        return;
      }
      res.json(decision);
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/v1/decisions/:id/events - Append evidence or note to timeline
decisionsRouter.post(
  "/:id/events",
  validateBody(AppendTimelineSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const event = await decisionsService.appendTimelineEvent(
        req.params.id,
        req.body,
        req.userId,
      );
      res.status(201).json(event);
    } catch (error) {
      next(error);
    }
  },
);

decisionsRouter.patch(
  "/:id/reminder",
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const date = new Date(req.body.nextReminder);
      if (
        typeof req.body.nextReminder !== "string" ||
        !Number.isFinite(date.getTime()) ||
        date <= new Date()
      ) {
        res.status(400).json({ message: "Choose a future reminder." });
        return;
      }
      const updated = await prisma.decision.updateMany({
        where: { id: req.params.id, userId: req.userId, outcome: null },
        data: { nextReminder: date },
      });
      if (!updated.count) {
        res
          .status(409)
          .json({ message: "This decision is no longer awaiting review." });
        return;
      }
      res.sendStatus(204);
    } catch (err) {
      next(err);
    }
  },
);
