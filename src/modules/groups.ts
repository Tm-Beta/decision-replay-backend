import { Router, Response } from "express";
import { AuthenticatedRequest } from "../common/guards/auth.guard";
import { prisma } from "../config/database";

export const groupsRouter = Router();
const fail = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });
type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const route =
  (handle: Handler): import("express").RequestHandler =>
  (req, res, next) => {
    handle(req, res).catch(next);
  };

function required(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim())
    throw fail("Enter " + label + ".", 400);
  return value.trim();
}

export async function recoverUngrouped() {
  await prisma.$transaction(async (tx) => {
    const buckets = await tx.decision.groupBy({
      by: ["userId", "category"],
      where: { projectId: null },
    });
    for (const { userId, category } of buckets) {
      const group = await tx.project.create({
        data: {
          userId,
          name: category || "Previous decisions",
          purpose: "",
          desiredOutcome: "",
        },
      });
      await tx.decision.updateMany({
        where: { userId, category, projectId: null },
        data: { projectId: group.id },
      });
    }
  });
}

groupsRouter.get(
  "/",
  route(async (req, res) => {
    const isArchived = req.query.archived === "true";
    const where: { userId: string | undefined; status?: string | { not: string } } = {
      userId: req.userId,
    };
    if (isArchived) {
      where.status = "ARCHIVED";
    } else if (req.query.all !== "true") {
      where.status = { not: "ARCHIVED" };
    }

    res.json(
      await prisma.project.findMany({
        where,
        include: { _count: { select: { decisions: true } } },
        orderBy: { createdAt: "desc" },
      }),
    );
  }),
);
groupsRouter.post(
  "/",
  route(async (req, res) => {
    res.status(201).json(
      await prisma.project.create({
        data: {
          userId: req.userId,
          name: required(req.body.name, "a group name"),
          purpose: "",
          desiredOutcome: "",
        },
      }),
    );
  }),
);
groupsRouter.patch(
  "/:id",
  route(async (req, res) => {
    const result = await prisma.project.updateMany({
      where: { id: req.params.id, userId: req.userId },
      data: { name: required(req.body.name, "a group name") },
    });
    if (!result.count) throw fail("Group not found.", 404);
    res.sendStatus(204);
  }),
);
groupsRouter.post(
  "/:id/archive",
  route(async (req, res) => {
    const pendingRemindersCount = await prisma.decision.count({
      where: {
        projectId: req.params.id,
        userId: req.userId,
        outcome: null,
        reviewDate: { not: null },
      },
    });

    const result = await prisma.project.updateMany({
      where: { id: req.params.id, userId: req.userId },
      data: { status: "ARCHIVED" },
    });
    if (!result.count) throw fail("Group not found.", 404);

    res.json({
      success: true,
      status: "ARCHIVED",
      pendingRemindersCount,
      message:
        pendingRemindersCount > 0
          ? `Group archived. ${pendingRemindersCount} pending outcome reminder(s) will continue to notify you when due.`
          : "Group archived successfully.",
    });
  }),
);
groupsRouter.post(
  "/:id/restore",
  route(async (req, res) => {
    const result = await prisma.project.updateMany({
      where: { id: req.params.id, userId: req.userId },
      data: { status: "ACTIVE" },
    });
    if (!result.count) throw fail("Group not found.", 404);

    res.json({
      success: true,
      status: "ACTIVE",
      message: "Group restored to active list.",
    });
  }),
);
groupsRouter.delete(
  "/:id",
  route(async (req, res) => {
    await prisma.$transaction(async tx => {
      const group = await tx.project.findFirst({where:{id:req.params.id,userId:req.userId}});
      if (!group) throw fail("Group not found.",404);
      await tx.chatMessage.deleteMany({where:{projectId:group.id,userId:req.userId}});
      await tx.decision.updateMany({where:{projectId:group.id},data:{parentId:null,planId:null}});
      await tx.decision.deleteMany({where:{projectId:group.id}});
      await tx.branchPlan.deleteMany({where:{projectId:group.id}});
      await tx.project.delete({where:{id:group.id}});
    });
    res.sendStatus(204);
  }),
);
groupsRouter.get(
  "/:id",
  route(async (req, res) => {
    const group = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: {
        decisions: {
          where: { userId: req.userId },
          include: {
            outcome: true,
            assumptions: true,
            events: {
              where: {
                OR: [
                  { eventType: "CONTEXT_SHIFT" },
                  {
                    eventType: "EVIDENCE_NOTE",
                    title: { in: ["Progress update", "Observation Log"] },
                  },
                ],
              },
              orderBy: { createdAt: "asc" },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        plans: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!group) throw fail("Group not found.", 404);
    const pendingRemindersCount = group.decisions.filter(
      (d) => !d.outcome && d.reviewDate,
    ).length;
    res.json({ ...group, pendingRemindersCount });
  }),
);
groupsRouter.post(
  "/:id/plans",
  route(async (req, res) => {
    const projectId = req.params.id;
    const { originId, parentPlanId } = req.body;
    if (Boolean(originId) === Boolean(parentPlanId))
      throw fail("Choose one starting branch.", 400);
    const plan = await prisma.$transaction(async (tx) => {
      const scope = { projectId, project: { userId: req.userId } };
      const parent = originId
        ? await tx.decision.findFirst({
            where: {
              ...scope,
              id: required(originId, "a decision"),
              userId: req.userId,
            },
          })
        : await tx.branchPlan.findFirst({
            where: { ...scope, id: required(parentPlanId, "a planned branch") },
          });
      if (!parent) throw fail("Starting branch not found.", 404);
      return tx.branchPlan.create({
        data: {
          projectId,
          originId,
          parentPlanId,
          title: required(req.body.title, "a planned choice"),
          expectedOutcome: required(
            req.body.expectedOutcome,
            "an expected outcome",
          ),
        },
      });
    });
    res.status(201).json(plan);
  }),
);

groupsRouter.patch(
  "/:id/plans/:planId",
  route(async (req, res) => {
    const status = req.body.status;
    if (!["OPEN", "DEFERRED", "DROPPED"].includes(status))
      throw fail("Choose a plan status.", 400);
    const updated = await prisma.branchPlan.updateMany({
      where: {
        id: req.params.planId,
        projectId: req.params.id,
        project: { userId: req.userId },
        decision: null,
      },
      data: { status },
    });
    if (!updated.count) throw fail("Plan unavailable.", 409);
    res.sendStatus(204);
  }),
);
