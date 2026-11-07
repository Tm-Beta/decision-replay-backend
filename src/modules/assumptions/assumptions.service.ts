// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay & DNA) & Member A
// FEATURE: Assumption Hypothesis Testing & Validation Service
//
// TODO: [Member C]
// 1. Update assumption test results (metricActual and validated boolean).
// 2. Trigger timeline event logging when an assumption is validated or falsified.
// ==============================================================================

import { prisma } from "../../config/database";

export class AssumptionsService {
  /**
   * Updates an assumption's reality state during review.
   */
  public async validateAssumption(
    assumptionId: string,
    data: { metricActual?: string; validated: boolean }
  ) {
    const updated = await prisma.assumption.update({
      where: { id: assumptionId },
      data: {
        metricActual: data.metricActual,
        validated: data.validated,
      },
    });

    // Append an automated timeline note
    await prisma.timelineEvent.create({
      data: {
        decisionId: updated.decisionId,
        eventType: "ASSUMPTION_UPDATE",
        title: `Assumption ${data.validated ? "Validated" : "Falsified"}`,
        detail: `Assumption "${updated.statement}" was marked as ${
          data.validated ? "VALIDATED" : "FALSIFIED"
        }. Actual metric: ${data.metricActual || "N/A"}`,
      },
    });

    return updated;
  }

  /**
   * Retrieves all assumptions for a decision.
   */
  public async getAssumptionsByDecision(decisionId: string) {
    return await prisma.assumption.findMany({
      where: { decisionId },
    });
  }
}

export const assumptionsService = new AssumptionsService();
