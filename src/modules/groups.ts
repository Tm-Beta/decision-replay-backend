import { Router, Response } from "express";
import { AuthenticatedRequest } from "../common/guards/auth.guard";
import { prisma } from "../config/database";
import { bridgeAndDeleteNodeLinks } from "./graph-helpers";

export const groupsRouter = Router();
const fail = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });
type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const route =
  (handle: Handler): import("express").RequestHandler =>
    (req, res, next) => {
      handle(req, res).catch(next);
    };

function required(value: unknown, label: string, maxLength = 300) {
  if (typeof value !== "string" || !value.trim())
    throw fail("Enter " + label + ".", 400);
  return value.trim().slice(0, maxLength);
}

const VALID_NODE_TYPES = new Set(["DECISION", "OUTCOME", "PLAN"]);

async function verifyNodeInProject(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  projectId: string,
  userId: string | undefined,
  nodeType: string,
  nodeId: string,
) {
  if (!VALID_NODE_TYPES.has(nodeType)) throw fail("Invalid node type.", 400);
  if (nodeType === "DECISION") {
    const found = await tx.decision.findFirst({
      where: { id: nodeId, projectId, userId },
      select: { id: true },
    });
    if (!found) throw fail("Decision not found in this collection.", 404);
  } else if (nodeType === "OUTCOME") {
    const found = await tx.outcomeBranch.findFirst({
      where: { id: nodeId, projectId, project: { userId } },
      select: { id: true },
    });
    if (!found) throw fail("Outcome not found in this collection.", 404);
  } else {
    const found = await tx.branchPlan.findFirst({
      where: { id: nodeId, projectId, project: { userId } },
      select: { id: true },
    });
    if (!found) throw fail("Plan not found in this collection.", 404);
  }
}

async function createsCycle(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  projectId: string,
  fromKey: string,
  toKey: string,
) {
  if (fromKey === toKey) return true;
  const links = await tx.graphLink.findMany({
    where: { projectId },
    select: { fromType: true, fromId: true, toType: true, toId: true },
  });
  const adj = new Map<string, string[]>();
  for (const l of links) {
    const f = `${l.fromType}:${l.fromId}`;
    const t = `${l.toType}:${l.toId}`;
    adj.set(f, [...(adj.get(f) ?? []), t]);
  }
  // Check if `fromKey` is reachable from `toKey`
  const visited = new Set<string>([toKey]);
  const queue = [toKey];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === fromKey) return true;
    for (const next of adj.get(cur) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
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
          name: required(req.body?.name, "a group name", 200),
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
      data: { name: required(req.body?.name, "a group name", 200) },
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
    await prisma.$transaction(async (tx) => {
      const group = await tx.project.findFirst({ where: { id: req.params.id, userId: req.userId } });
      if (!group) throw fail("Group not found.", 404);
      await tx.chatMessage.deleteMany({ where: { projectId: group.id, userId: req.userId } });
      await tx.chatSession.deleteMany({ where: { projectId: group.id, userId: req.userId } });
      await tx.graphLink.deleteMany({ where: { projectId: group.id } });
      await tx.outcomeBranch.deleteMany({ where: { projectId: group.id } });
      await tx.decision.updateMany({ where: { projectId: group.id }, data: { parentId: null, planId: null } });
      await tx.decision.deleteMany({ where: { projectId: group.id } });
      await tx.branchPlan.deleteMany({ where: { projectId: group.id } });
      await tx.project.delete({ where: { id: group.id } });
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
            outcomeBranches: { orderBy: { createdAt: "asc" } },
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
        outcomeBranches: { orderBy: { createdAt: "asc" } },
        graphLinks: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!group) throw fail("Group not found.", 404);
    const pendingRemindersCount = group.decisions.filter(
      (d) => !d.outcome && !d.outcomeBranches?.length && d.reviewDate,
    ).length;
    res.json({ ...group, pendingRemindersCount });
  }),
);

groupsRouter.post(
  "/:id/plans",
  route(async (req, res) => {
    const projectId = req.params.id;
    const {
      originId,
      parentPlanId,
      nodeType = "DECISION",
      parentNodes,
    } = (req.body || {}) as {
      originId?: string;
      parentPlanId?: string;
      nodeType?: string;
      parentNodes?: { type: string; id: string }[];
    };

    if (nodeType !== "DECISION" && nodeType !== "OUTCOME") {
      throw fail("Choose either a decision or an outcome.", 400);
    }

    const plan = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, userId: req.userId },
        select: { id: true },
      });
      if (!project) throw fail("Collection not found.", 404);

      const sources: { type: string; id: string }[] = Array.isArray(parentNodes)
        ? parentNodes.filter((p) => p && typeof p.type === "string" && typeof p.id === "string")
        : [];
      if (originId) sources.push({ type: "DECISION", id: originId });
      if (parentPlanId) sources.push({ type: "PLAN", id: parentPlanId });

      // Deduplicate sources
      const uniqueSources = Array.from(
        new Map(sources.map((s) => [`${s.type}:${s.id}`, s])).values(),
      );

      for (const s of uniqueSources) {
        await verifyNodeInProject(tx, projectId, req.userId, s.type, s.id);
      }

      const firstDecision = uniqueSources.find((s) => s.type === "DECISION")?.id ?? null;
      const firstPlan = uniqueSources.find((s) => s.type === "PLAN")?.id ?? null;

      const created = await tx.branchPlan.create({
        data: {
          projectId,
          nodeType,
          joinRule: req.body.joinRule === "ALL" ? "ALL" : "ANY",
          originId: firstDecision,
          parentPlanId: firstPlan,
          title: required(req.body.title, nodeType === "OUTCOME" ? "a possible outcome" : "a planned choice"),
          expectedOutcome: typeof req.body.expectedOutcome === "string" ? req.body.expectedOutcome.trim() : "",
        },
      });

      for (const s of uniqueSources) {
        await tx.graphLink.create({
          data: {
            projectId,
            fromType: s.type,
            fromId: s.id,
            toType: "PLAN",
            toId: created.id,
          },
        });
      }

      return created;
    });
    res.status(201).json(plan);
  }),
);

groupsRouter.patch(
  "/:id/plans/:planId",
  route(async (req, res) => {
    const { status, title, expectedOutcome, nodeType, joinRule } = req.body || {};
    if (status !== undefined && !["OPEN", "DEFERRED", "DROPPED"].includes(status))
      throw fail("Choose a plan status.", 400);
    if (nodeType !== undefined && !["DECISION", "OUTCOME"].includes(nodeType))
      throw fail("Choose either a decision or an outcome.", 400);
    if (joinRule !== undefined && !["ANY", "ALL"].includes(joinRule))
      throw fail("Choose ANY or ALL.", 400);
    if (
      status === undefined &&
      title === undefined &&
      expectedOutcome === undefined &&
      nodeType === undefined &&
      joinRule === undefined
    )
      throw fail("Enter a change to the plan.", 400);
    const data = {
      status,
      nodeType,
      joinRule,
      title: title === undefined ? undefined : required(title, "a planned step"),
      expectedOutcome: expectedOutcome === undefined ? undefined : String(expectedOutcome).trim(),
    };
    const updated = await prisma.branchPlan.updateMany({
      where: {
        id: req.params.planId,
        projectId: req.params.id,
        project: { userId: req.userId },
        decision: null,
      },
      data,
    });
    if (!updated.count) throw fail("This plan is unavailable or already recorded.", 409);
    res.sendStatus(204);
  }),
);

groupsRouter.post(
  "/:id/plans/:planId/promote-outcome",
  route(async (req, res) => {
    const projectId = req.params.id;
    const planId = req.params.planId;
    const { decisionId } = req.body as { decisionId?: string };

    const result = await prisma.$transaction(async (tx) => {
      const plan = await tx.branchPlan.findFirst({
        where: {
          id: planId,
          projectId,
          project: { userId: req.userId },
          decision: null,
          outcomeBranch: null,
        },
      });
      if (!plan) throw fail("This planned outcome is unavailable or already recorded.", 409);

      const decId = required(decisionId, "a decision");
      const decision = await tx.decision.findFirst({
        where: { id: decId, projectId, userId: req.userId },
        select: { id: true },
      });
      if (!decision) throw fail("Decision not found in this collection.", 404);

      const outcomeBranch = await tx.outcomeBranch.create({
        data: {
          projectId,
          decisionId: decision.id,
          planId: plan.id,
          title: plan.title,
          detail: plan.expectedOutcome || "",
          isPrimary: false,
        },
      });

      await tx.graphLink.upsert({
        where: {
          projectId_fromType_fromId_toType_toId: {
            projectId,
            fromType: "DECISION",
            fromId: decision.id,
            toType: "OUTCOME",
            toId: outcomeBranch.id,
          },
        },
        update: {},
        create: {
          projectId,
          fromType: "DECISION",
          fromId: decision.id,
          toType: "OUTCOME",
          toId: outcomeBranch.id,
        },
      });

      // Migrate all outgoing follow-up connections from this planned outcome to the real OutcomeBranch
      const outgoingLinks = await tx.graphLink.findMany({
        where: { projectId, fromType: "PLAN", fromId: plan.id },
      });
      const childPlans = await tx.branchPlan.findMany({
        where: { projectId, parentPlanId: plan.id },
        select: { id: true },
      });

      const targets: { type: string; id: string }[] = [
        ...outgoingLinks.map((l) => ({ type: l.toType, id: l.toId })),
        ...childPlans.map((c) => ({ type: "PLAN", id: c.id })),
      ];

      for (const t of targets) {
        await tx.graphLink.upsert({
          where: {
            projectId_fromType_fromId_toType_toId: {
              projectId,
              fromType: "OUTCOME",
              fromId: outcomeBranch.id,
              toType: t.type,
              toId: t.id,
            },
          },
          update: {},
          create: {
            projectId,
            fromType: "OUTCOME",
            fromId: outcomeBranch.id,
            toType: t.type,
            toId: t.id,
          },
        });
      }

      // Clean up old PLAN-scoped links so the graph stays tidy
      await tx.graphLink.deleteMany({
        where: {
          projectId,
          OR: [
            { fromType: "PLAN", fromId: plan.id },
            { toType: "PLAN", toId: plan.id },
          ],
        },
      });

      await tx.branchPlan.update({
        where: { id: plan.id },
        data: { status: "CONVERTED" },
      });

      return outcomeBranch;
    });

    res.status(201).json(result);
  }),
);

groupsRouter.delete(
  "/:id/plans/:planId",
  route(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const scope = { projectId: req.params.id, project: { userId: req.userId } };
      const plan = await tx.branchPlan.findFirst({
        where: { ...scope, id: req.params.planId, decision: null },
      });
      if (!plan) throw fail("This plan is unavailable or already recorded.", 409);
      await tx.branchPlan.updateMany({
        where: { ...scope, parentPlanId: plan.id },
        data: { parentPlanId: plan.parentPlanId, originId: plan.originId },
      });
      await bridgeAndDeleteNodeLinks(tx, req.params.id, [{ type: "PLAN", id: plan.id }]);
      await tx.branchPlan.delete({ where: { id: plan.id } });
    });
    res.sendStatus(204);
  }),
);

// ---- Outcome Branches (Actual Outcomes on Tree) ----

groupsRouter.post(
  "/:id/outcomes",
  route(async (req, res) => {
    const projectId = req.params.id;
    const { decisionId, title, detail } = req.body as {
      decisionId?: string;
      title?: string;
      detail?: string;
    };
    const created = await prisma.$transaction(async (tx) => {
      const decId = required(decisionId, "a decision");
      const decision = await tx.decision.findFirst({
        where: { id: decId, projectId, userId: req.userId },
        select: { id: true },
      });
      if (!decision) throw fail("Decision not found in this collection.", 404);

      const outcomeBranch = await tx.outcomeBranch.create({
        data: {
          projectId,
          decisionId: decision.id,
          title: required(title, "what happened"),
          detail: typeof detail === "string" ? detail.trim() : "",
          isPrimary: false,
        },
      });

      await tx.graphLink.create({
        data: {
          projectId,
          fromType: "DECISION",
          fromId: decision.id,
          toType: "OUTCOME",
          toId: outcomeBranch.id,
        },
      });

      return outcomeBranch;
    });
    res.status(201).json(created);
  }),
);

groupsRouter.patch(
  "/:id/outcomes/:outcomeId",
  route(async (req, res) => {
    const { title, detail } = req.body as { title?: string; detail?: string };
    const updated = await prisma.outcomeBranch.updateMany({
      where: {
        id: req.params.outcomeId,
        projectId: req.params.id,
        project: { userId: req.userId },
      },
      data: {
        title: title === undefined ? undefined : required(title, "what happened"),
        detail: detail === undefined ? undefined : String(detail).trim(),
      },
    });
    if (!updated.count) throw fail("Outcome not found.", 404);
    res.sendStatus(204);
  }),
);

groupsRouter.delete(
  "/:id/outcomes/:outcomeId",
  route(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const outcome = await tx.outcomeBranch.findFirst({
        where: {
          id: req.params.outcomeId,
          projectId: req.params.id,
          project: { userId: req.userId },
        },
      });
      if (!outcome) throw fail("Outcome not found.", 404);
      await bridgeAndDeleteNodeLinks(tx, req.params.id, [{ type: "OUTCOME", id: outcome.id }]);
      await tx.outcomeBranch.delete({ where: { id: outcome.id } });
    });
    res.sendStatus(204);
  }),
);

// ---- Graph Links (Multi-Parent & Converging Connections) ----

groupsRouter.post(
  "/:id/links",
  route(async (req, res) => {
    const projectId = req.params.id;
    const { fromType, fromId, toType, toId, label } = req.body as {
      fromType: string;
      fromId: string;
      toType: string;
      toId: string;
      label?: string;
    };

    const link = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, userId: req.userId },
        select: { id: true },
      });
      if (!project) throw fail("Collection not found.", 404);

      await verifyNodeInProject(tx, projectId, req.userId, fromType, required(fromId, "source node"));
      await verifyNodeInProject(tx, projectId, req.userId, toType, required(toId, "target node"));

      const fromKey = `${fromType}:${fromId}`;
      const toKey = `${toType}:${toId}`;
      if (await createsCycle(tx, projectId, fromKey, toKey)) {
        throw fail("This connection would create a loop in the flow.", 400);
      }

      const existing = await tx.graphLink.findUnique({
        where: { projectId_fromType_fromId_toType_toId: { projectId, fromType, fromId, toType, toId } },
      });
      if (existing) return existing;

      return tx.graphLink.create({
        data: {
          projectId,
          fromType,
          fromId,
          toType,
          toId,
          label: typeof label === "string" ? label.trim() : "",
        },
      });
    });

    res.status(201).json(link);
  }),
);

async function unlinkLegacyFields(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  projectId: string,
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
) {
  if (toType === "DECISION" && fromType === "DECISION") {
    const dec = await tx.decision.findFirst({
      where: { id: toId, projectId },
      select: { id: true, parentId: true, influences: true },
    });
    if (dec) {
      let nextInfluences = dec.influences;
      try {
        const arr = JSON.parse(dec.influences || "[]");
        if (Array.isArray(arr)) {
          nextInfluences = JSON.stringify(arr.filter((id: string) => id !== fromId));
        }
      } catch {}
      await tx.decision.update({
        where: { id: dec.id },
        data: {
          parentId: dec.parentId === fromId ? null : dec.parentId,
          influences: nextInfluences,
        },
      });
    }
  } else if (toType === "PLAN") {
    const plan = await tx.branchPlan.findFirst({
      where: { id: toId, projectId },
      select: { id: true, originId: true, parentPlanId: true },
    });
    if (plan) {
      await tx.branchPlan.update({
        where: { id: plan.id },
        data: {
          originId: fromType === "DECISION" && plan.originId === fromId ? null : plan.originId,
          parentPlanId: fromType === "PLAN" && plan.parentPlanId === fromId ? null : plan.parentPlanId,
        },
      });
    }
  }
}

groupsRouter.delete(
  "/:id/links/:linkId",
  route(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const link = await tx.graphLink.findFirst({
        where: {
          id: req.params.linkId,
          projectId: req.params.id,
          project: { userId: req.userId },
        },
      });
      if (!link) throw fail("Connection not found.", 404);
      await tx.graphLink.delete({ where: { id: link.id } });
      await unlinkLegacyFields(
        tx,
        req.params.id,
        link.fromType,
        link.fromId,
        link.toType,
        link.toId,
      );
    });
    res.sendStatus(204);
  }),
);

groupsRouter.post(
  "/:id/unlink",
  route(async (req, res) => {
    const { fromType, fromId, toType, toId } = (req.body || {}) as {
      fromType?: string;
      fromId?: string;
      toType?: string;
      toId?: string;
    };
    if (
      !fromType ||
      !toType ||
      !VALID_NODE_TYPES.has(fromType) ||
      !VALID_NODE_TYPES.has(toType) ||
      typeof fromId !== "string" ||
      typeof toId !== "string" ||
      !fromId ||
      !toId
    ) {
      throw fail("Invalid connection payload.", 400);
    }
    await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: req.params.id, userId: req.userId },
        select: { id: true },
      });
      if (!project) throw fail("Collection not found.", 404);
      await tx.graphLink.deleteMany({
        where: { projectId: req.params.id, fromType, fromId, toType, toId },
      });
      await unlinkLegacyFields(tx, req.params.id, fromType, fromId, toType, toId);
    });
    res.sendStatus(204);
  }),
);

groupsRouter.patch(
  "/:id/nodes/:nodeType/:nodeId/join-rule",
  route(async (req, res) => {
    const { id: projectId, nodeType, nodeId } = req.params;
    const { joinRule } = req.body as { joinRule?: string };
    if (joinRule !== "ANY" && joinRule !== "ALL") {
      throw fail("Choose ANY or ALL.", 400);
    }
    if (nodeType === "DECISION") {
      const updated = await prisma.decision.updateMany({
        where: { id: nodeId, projectId, userId: req.userId },
        data: { joinRule },
      });
      if (!updated.count) throw fail("Decision not found in this collection.", 404);
    } else if (nodeType === "PLAN") {
      const updated = await prisma.branchPlan.updateMany({
        where: { id: nodeId, projectId, project: { userId: req.userId } },
        data: { joinRule },
      });
      if (!updated.count) throw fail("Plan not found in this collection.", 404);
    } else {
      throw fail("Join rule only applies to decisions and planned steps.", 400);
    }
    res.sendStatus(204);
  }),
);
