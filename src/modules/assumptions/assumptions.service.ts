// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay & DNA) & Member A
// FEATURE: Assumption Hypothesis Testing & Validation Service
//
// Rules:
//  - Unknown assumption                      -> 404
//  - Outcome already recorded for the decision -> 409 (the replay result is final)
//  - Neither `validated` nor `metricActual`    -> 422
//  - `validated` omitted: compared automatically with metricTarget (scoring.ts);
//    if the text can't be compared                -> 422 (send `validated` yourself)
//  - Assumption update + timeline event are saved in one transaction.
// ==============================================================================

import { prisma } from "../../config/database";
import { evaluateAssumption } from "../replay-engine/scoring";

/** Error with an HTTP status, read by the global error filter. */
export class AssumptionError extends Error {
  public readonly status: number;
  public readonly statusCode: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AssumptionError";
    this.status = status;
    this.statusCode = status;
  }
}

export class AssumptionsService {
  /**
   * Updates an assumption's reality state during review.
   */
  public async validateAssumption(
    assumptionId: string,
    data: { metricActual?: string; validated?: boolean }
  ) {
    const assumption = await prisma.assumption.findUnique({
      where: { id: assumptionId },
      include: { decision: { select: { outcome: { select: { id: true } } } } },
    });

    if (!assumption) {
      throw new AssumptionError(404, `Assumption ${assumptionId} not found`);
    }
    if (assumption.decision.outcome) {
      throw new AssumptionError(
        409,
        "An outcome is already recorded for this decision, so its assumptions can no longer be changed"
      );
    }
    if (data.validated === undefined && !data.metricActual) {
      throw new AssumptionError(422, "Provide `validated`, or `metricActual` to compare with the target");
    }

    // Manual verdict wins, otherwise compare metricActual with metricTarget.
    const autoChecked = data.validated === undefined;
    const validated: boolean | null =
      data.validated ?? evaluateAssumption(assumption.metricTarget, data.metricActual);

    if (validated === null) {
      throw new AssumptionError(
        422,
        "Could not compare metricActual with the target automatically. Send `validated` (true/false) yourself."
      );
    }

    return await prisma.$transaction(async (tx) => {
      const updated = await tx.assumption.update({
        where: { id: assumptionId },
        data: {
          metricActual: data.metricActual,
          validated,
        },
      });

      // Append an automated timeline note
      await tx.timelineEvent.create({
        data: {
          decisionId: updated.decisionId,
          eventType: "ASSUMPTION_UPDATE",
          title: `Assumption ${validated ? "Validated" : "Falsified"}`,
          detail: `Assumption "${updated.statement}" was marked as ${
            validated ? "VALIDATED" : "FALSIFIED"
          }${autoChecked ? " (compared automatically with the target)" : ""}. Target: ${
            updated.metricTarget ?? "N/A"
          }. Actual metric: ${data.metricActual || "N/A"}`,
        },
      });

      return updated;
    });
  }

  /**
   * Retrieves all assumptions for a decision.
   */
  public async getAssumptionsByDecision(decisionId: string) {
    return await prisma.assumption.findMany({
      where: { decisionId },
      orderBy: { createdAt: "asc" },
    });
  }
}

export const assumptionsService = new AssumptionsService();
