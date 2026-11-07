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
      // 1. Create the core Decision entity
      const decision = await tx.decision.create({
        data: {
          title: dto.title,
          category: dto.category,
          projectId: dto.projectId,
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
              detail: `Decision reasoning captured and locked with ${dto.confidence}% confidence.`,
            },
          },
        },
      });

      // 2. Prepare snapshot payload and compute SHA-256 hash
      const snapshotPayload = {
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

      const { contentHash } = await snapshotsService.freezeSnapshot(decision.id, snapshotPayload, tx);

      return {
        ...decision,
        snapshotHash: contentHash,
      };
    });
  }

  /**
   * Retrieves a decision by ID including snapshot verification and relational timeline.
   */
  public async getDecisionById(id: string) {
    const decision = await prisma.decision.findUnique({
      where: { id },
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
  public async appendTimelineEvent(decisionId: string, dto: AppendTimelineDto) {
    const decision = await prisma.decision.findUnique({ where: { id: decisionId } });
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
   * Lists decisions with filtering by status and project.
   */
  public async listDecisions(filters: { status?: string; projectId?: string; category?: string }) {
    return await prisma.decision.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.projectId ? { projectId: filters.projectId } : {}),
        ...(filters.category ? { category: filters.category } : {}),
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
