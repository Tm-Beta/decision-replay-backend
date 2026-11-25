// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Decisions HTTP Controller & Route Endpoints
//
// TODO: [Member A]
// 1. Map HTTP requests to decisionsService.
// 2. Enforce response codes according to `decision-replay-docs/api-contracts/decisions-api.md`.
// ==============================================================================

import { z } from "zod";
import { Router, Response, NextFunction } from "express";
import { prisma } from "../../config/database";
import { decisionsService } from "./decisions.service";
import { CreateDecisionSchema } from "./dto/create-decision.dto";
import { AppendTimelineSchema } from "./dto/append-timeline.dto";
import { validateBody } from "../../common/guards/validation.guard";
import { AuthenticatedRequest } from "../../common/guards/auth.guard";
import { bridgeAndDeleteNodeLinks } from "../graph-helpers";

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
            outcomeBranches: { none: {} },
            OR: [
              { nextReminder: { lte: now } },
              { nextReminder: null, reviewDate: { lte: now } },
            ],
          },
          select: {
            id: true,
            title: true,
            project: { select: { name: true } },
            reviewDate: true,
            nextReminder: true,
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
      const nextReminder = req.body?.nextReminder;
      const date = new Date(nextReminder);
      if (
        typeof nextReminder !== "string" ||
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

decisionsRouter.delete("/:id", async (req: AuthenticatedRequest, res, next) => {
  try {
    await prisma.$transaction(async tx => {
      const decision = await tx.decision.findFirst({ where: { id: req.params.id, userId: req.userId }, include: { outcomeBranches: { select: { id: true } } } });
      if (!decision) throw Object.assign(new Error("Decision not found."), { statusCode: 404 });
      if (!decision.parentId && await tx.branchPlan.count({ where: { originId: decision.id, projectId: decision.projectId || "" } })) throw Object.assign(new Error("Move or remove plans from this starting decision first."), { statusCode: 409 });
      await tx.decision.updateMany({ where: { parentId: decision.id, projectId: decision.projectId, userId: req.userId }, data: { parentId: decision.parentId } });
      await tx.branchPlan.updateMany({ where: { originId: decision.id, projectId: decision.projectId || "" }, data: { originId: decision.parentId } });
      if (decision.projectId) {
        const targets = [
          { type: "DECISION", id: decision.id },
          ...decision.outcomeBranches.map((o) => ({ type: "OUTCOME", id: o.id })),
        ];
        await bridgeAndDeleteNodeLinks(tx, decision.projectId, targets);
      }
      const related = await tx.decision.findMany({ where: { userId: req.userId, projectId: decision.projectId }, select: { id: true, influences: true } });
      for (const row of related) { try { const ids = JSON.parse(row.influences); if (Array.isArray(ids) && ids.includes(decision.id)) await tx.decision.update({ where: { id: row.id }, data: { influences: JSON.stringify(ids.filter((id: string) => id !== decision.id)) } }) } catch { } }
      await tx.decision.delete({ where: { id: decision.id } });
    });
    res.sendStatus(204);
  } catch (error) { next(error) }
});


const editSchema = z.object({
  title: z.string().trim().min(1).max(200),
  choice: z.string().trim().min(1).max(4000),
  expectedOutcome: z.string().max(4000),
  decisionReason: z.string().max(4000),
  beliefRationale: z.string().max(4000),
  confidence: z.number().int().min(1).max(100).nullable(),
  reviewDate: z.string().datetime().nullable()
});
decisionsRouter.patch("/:id/details", async (req: AuthenticatedRequest, res, next) => {
  try {
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Please check the decision details." }); return; }
    await prisma.$transaction(async tx => {
      const current = await tx.decision.findFirst({ where: { id: req.params.id, userId: req.userId } });
      if (!current) throw Object.assign(new Error("Decision not found."), { statusCode: 404 });
      const nextData = { ...parsed.data, reviewDate: parsed.data.reviewDate ? new Date(parsed.data.reviewDate) : null };
      const fields = ["title", "choice", "expectedOutcome", "decisionReason", "beliefRationale", "confidence", "reviewDate"] as const;
      const changes = fields.flatMap(field => {
        const before = current[field], after = nextData[field];
        const oldValue = before instanceof Date ? before.toISOString() : before;
        const newValue = after instanceof Date ? after.toISOString() : after;
        return oldValue === newValue ? [] : [{ field, before: oldValue, after: newValue }];
      });
      if (!changes.length) return;
      await tx.decision.update({ where: { id: current.id }, data: { ...nextData, ...(changes.some(c => c.field === "reviewDate") ? { nextReminder: null } : {}) } });
      await tx.timelineEvent.create({ data: { decisionId: current.id, eventType: "CONTEXT_SHIFT", title: "Decision details updated", detail: changes.map(c => c.field + ": " + String(c.before ?? "—") + " → " + String(c.after ?? "—")).join("\n"), metadataJson: JSON.stringify({ changes }) } });
    });
    res.sendStatus(204);
  } catch (error) { next(error) }
});

decisionsRouter.patch("/:id/project", async (req: AuthenticatedRequest, res, next) => {
  try {
    const projectId = typeof req.body?.projectId === "string" && req.body.projectId ? req.body.projectId : null;
    await prisma.$transaction(async (tx) => {
      const current = await tx.decision.findFirst({
        where: { id: req.params.id, userId: req.userId },
        include: { outcomeBranches: { select: { id: true } } },
      });
      if (!current) throw Object.assign(new Error("Decision not found."), { statusCode: 404 });
      if (projectId) {
        const project = await tx.project.findFirst({ where: { id: projectId, userId: req.userId }, select: { id: true } });
        if (!project) throw Object.assign(new Error("Collection not found."), { statusCode: 404 });
      }
      if (current.projectId && current.projectId !== projectId) {
        const targets = [
          { type: "DECISION", id: current.id },
          ...current.outcomeBranches.map((o) => ({ type: "OUTCOME", id: o.id })),
        ];
        await bridgeAndDeleteNodeLinks(tx, current.projectId, targets);
        await tx.decision.updateMany({
          where: { parentId: current.id, projectId: current.projectId, userId: req.userId },
          data: { parentId: current.parentId },
        });
      }
      await tx.decision.update({
        where: { id: current.id },
        data: {
          projectId,
          parentId: current.projectId === projectId ? current.parentId : null,
          planId: current.projectId === projectId ? current.planId : null,
          influences: current.projectId === projectId ? current.influences : "[]",
        },
      });
      if (projectId && current.projectId !== projectId) {
        await tx.outcomeBranch.updateMany({
          where: { decisionId: current.id },
          data: { projectId },
        });
        for (const ob of current.outcomeBranches) {
          await tx.graphLink.create({
            data: { projectId, fromType: "DECISION", fromId: current.id, toType: "OUTCOME", toId: ob.id },
          });
        }
      } else if (!projectId && current.projectId) {
        await tx.outcomeBranch.deleteMany({ where: { decisionId: current.id } });
      }
    });
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});
