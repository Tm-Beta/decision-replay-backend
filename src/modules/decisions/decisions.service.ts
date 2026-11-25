// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Decision Creation, Snapshot Freezing & Query Business Logic
//
// TODO: [Member A]
// 1. Execute atomic creation of Decision, Relations, and Snapshot in a $transaction.
// 2. Prohibit UPDATE on original snapshot fields (immutability invariant).
// 3. Integrate snapshotsService to compute cryptographic contentHash.
// ==============================================================================

import { prisma } from "../../config/database";
import { CreateDecisionDto } from "./dto/create-decision.dto";
import { AppendTimelineDto } from "./dto/append-timeline.dto";
import { snapshotsService } from "../snapshots/snapshots.service";

export class DecisionsService {
  /**
   * Creates a new decision and immediately freezes its initial state into an immutable snapshot.
   */
  public async createDecision(dto: CreateDecisionDto, userId?: string) {
    return await prisma.$transaction(async (tx) => {
      const group = dto.projectId ? await tx.project.findFirst({
        where: { id: dto.projectId, userId },
      }) : null;
      if (dto.projectId && !group)
        throw Object.assign(new Error("Group not found."), { statusCode: 404 });
      if (!group && (dto.parentId || dto.planId || dto.influences.length || dto.sourceLinks.length)) {
        throw Object.assign(new Error("Choose a project to link decisions or plans."), { statusCode: 400 });
      }
      const scope = { projectId: group?.id ?? null, userId };
      if (dto.parentId) {
        const parent = await tx.decision.findFirst({
          where: { ...scope, id: dto.parentId },
        });
        if (!parent)
          throw Object.assign(new Error("Choose a parent in this group."), {
            statusCode: 400,
          });
      }
      const influences = [...new Set(dto.influences)].filter(
        (id) => id !== dto.parentId,
      );
      if (
        influences.length !==
        (await tx.decision.count({
          where: { ...scope, id: { in: influences } },
        }))
      ) {
        throw Object.assign(
          new Error("Choose related decisions in this group."),
          { statusCode: 400 },
        );
      }
      if (group && dto.sourceLinks.length) {
        for (const s of dto.sourceLinks) {
          if (s.type === "DECISION") {
            const ok = await tx.decision.findFirst({ where: { id: s.id, projectId: group.id, userId }, select: { id: true } });
            if (!ok) throw Object.assign(new Error("Source decision not found in this collection."), { statusCode: 400 });
          } else if (s.type === "OUTCOME") {
            const ok = await tx.outcomeBranch.findFirst({ where: { id: s.id, projectId: group.id }, select: { id: true } });
            if (!ok) throw Object.assign(new Error("Source outcome not found in this collection."), { statusCode: 400 });
          } else if (s.type === "PLAN") {
            const ok = await tx.branchPlan.findFirst({ where: { id: s.id, projectId: group.id }, select: { id: true } });
            if (!ok) throw Object.assign(new Error("Source plan not found in this collection."), { statusCode: 400 });
          }
        }
      }
      const plan = dto.planId
        ? await tx.branchPlan.findFirst({
            where: {
              id: dto.planId,
              projectId: group?.id,
              decision: null,
              status: "OPEN",
            },
          })
        : null;
      if (dto.planId && !plan) {
        throw Object.assign(new Error("This planned branch is unavailable."), {
          statusCode: 409,
        });
      }
      const decision = await tx.decision.create({
        data: {
          title: dto.title,
          category: dto.category,
          projectId: dto.projectId,
          influences: JSON.stringify(influences),
          decidedOn: dto.decidedOn,
          outcomeKnown: dto.outcomeKnown,
          parentId: dto.parentId,
          planId: dto.planId,
          joinRule: plan?.joinRule ?? "ANY",
          userId: userId,
          choice: dto.choice,
          context: dto.context,
          decisionReason: dto.decisionReason,
          beliefRationale: dto.beliefRationale,
          expectedOutcome: dto.expectedOutcome,
          confidence: dto.confidence,
          reviewDate: dto.reviewDate ? new Date(dto.reviewDate) : null,
          status: "LOCKED",
          lockedAt: new Date(),
          assumptions: {
            create: dto.assumptions.map((a) => ({
              statement: a.statement,
              metricTarget: a.metricTarget,
              confidence: a.confidence,
            })),
          },
          alternatives: {
            create: dto.alternatives.map((alt) => ({
              title: alt.title,
              pros: alt.pros,
              cons: alt.cons,
            })),
          },
          preMortems: {
            create: dto.preMortems.map((pm) => ({
              failureScenario: pm.failureScenario,
              preventiveAction: pm.preventiveAction,
              severityScore: pm.severityScore,
            })),
          },
          events: {
            create: {
              eventType: "EVIDENCE_NOTE",
              title: "Decision Locked",
              detail: "Original decision recorded.",
            },
          },
        },
      });

      // Record graph edges for DAG connections (parentId, influences, sourceLinks, and promoted plan links)
      if (group) {
        const edgeMap = new Map<string, { fromType: string; fromId: string }>();
        if (dto.parentId) {
          edgeMap.set(`DECISION:${dto.parentId}`, { fromType: "DECISION", fromId: dto.parentId });
        }
        for (const infId of influences) {
          edgeMap.set(`DECISION:${infId}`, { fromType: "DECISION", fromId: infId });
        }
        for (const s of dto.sourceLinks) {
          if (s.type === "DECISION" || s.type === "OUTCOME") {
            edgeMap.set(`${s.type}:${s.id}`, { fromType: s.type, fromId: s.id });
          } else if (s.type === "PLAN") {
            const promotedDec = await tx.decision.findFirst({ where: { planId: s.id }, select: { id: true } });
            if (promotedDec) {
              edgeMap.set(`DECISION:${promotedDec.id}`, { fromType: "DECISION", fromId: promotedDec.id });
            } else {
              const promotedOut = await tx.outcomeBranch.findFirst({ where: { planId: s.id }, select: { id: true } });
              if (promotedOut) edgeMap.set(`OUTCOME:${promotedOut.id}`, { fromType: "OUTCOME", fromId: promotedOut.id });
            }
          }
        }
        if (dto.planId) {
          const planIncoming = await tx.graphLink.findMany({
            where: { projectId: group.id, toType: "PLAN", toId: dto.planId },
          });
          for (const link of planIncoming) {
            if (link.fromType === "DECISION" || link.fromType === "OUTCOME") {
              edgeMap.set(`${link.fromType}:${link.fromId}`, { fromType: link.fromType, fromId: link.fromId });
            } else if (link.fromType === "PLAN") {
              const promotedDec = await tx.decision.findFirst({ where: { planId: link.fromId }, select: { id: true } });
              if (promotedDec) {
                edgeMap.set(`DECISION:${promotedDec.id}`, { fromType: "DECISION", fromId: promotedDec.id });
              } else {
                const promotedOut = await tx.outcomeBranch.findFirst({ where: { planId: link.fromId }, select: { id: true } });
                if (promotedOut) edgeMap.set(`OUTCOME:${promotedOut.id}`, { fromType: "OUTCOME", fromId: promotedOut.id });
              }
            }
          }
        }
        for (const edge of edgeMap.values()) {
          await tx.graphLink.create({
            data: {
              projectId: group.id,
              fromType: edge.fromType,
              fromId: edge.fromId,
              toType: "DECISION",
              toId: decision.id,
            },
          });
        }
      }

      // 2. Prepare snapshot payload and compute SHA-256 hash
      const snapshotPayload = {
        decidedOn: dto.decidedOn,
        outcomeKnown: dto.outcomeKnown,
        title: dto.title,
        category: dto.category,
        choice: dto.choice,
        context: dto.context,
        decisionReason: dto.decisionReason,
        beliefRationale: dto.beliefRationale,
        expectedOutcome: dto.expectedOutcome,
        confidence: dto.confidence,
        reviewDate: dto.reviewDate,
        assumptions: dto.assumptions,
        alternatives: dto.alternatives,
        preMortems: dto.preMortems,
      };

      const { contentHash } = await snapshotsService.freezeSnapshot(
        decision.id,
        snapshotPayload,
        tx,
      );

      return {
        ...decision,
        snapshotHash: contentHash,
      };
    });
  }

  /**
   * Retrieves a decision by ID including snapshot verification and relational timeline.
   */
  public async getDecisionById(id: string, userId?: string) {
    const decision = await prisma.decision.findFirst({
      where: {
        id,
        ...(userId ? { userId } : {}),
      },
      include: {
        snapshot: true,
        assumptions: true,
        alternatives: true,
        preMortems: true,
        events: {
          orderBy: { createdAt: "desc" },
        },
        outcome: true,
        analyses: true,
      },
    });

    if (!decision) {
      return null;
    }

    // Verify cryptographic integrity
    let isVerified = false;
    if (decision.snapshot) {
      const verification = await snapshotsService.verifySnapshot(decision.id);
      isVerified = verification.isVerified;
    }

    return {
      ...decision,
      isVerified,
    };
  }

  /**
   * Appends an auditable event to the decision timeline without altering original fields.
   */
  public async appendTimelineEvent(
    decisionId: string,
    dto: AppendTimelineDto,
    userId?: string,
  ) {
    const decision = await prisma.decision.findFirst({
      where: {
        id: decisionId,
        ...(userId ? { userId } : {}),
      },
    });
    if (!decision) {
      throw new Error(`Decision ${decisionId} not found`);
    }

    return await prisma.timelineEvent.create({
      data: {
        decisionId,
        eventType: dto.eventType,
        title: dto.title,
        detail: dto.detail,
        metadataJson: dto.metadataJson ?? "{}",
      },
    });
  }

  /**
   * Lists decisions with filtering by status, project, and user.
   */
  public async listDecisions(filters: {
    status?: string;
    projectId?: string;
    category?: string;
    userId?: string;
  }) {
    return await prisma.decision.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.projectId ? { projectId: filters.projectId } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.userId ? { userId: filters.userId } : {}),
      },
      include: {
        outcome: true,
        _count: {
          select: { assumptions: true, events: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }
}

export const decisionsService = new DecisionsService();
