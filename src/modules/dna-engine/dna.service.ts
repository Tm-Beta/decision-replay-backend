// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: Decision DNA Longitudinal Aggregation & Evidence Mapping
//
// This file only loads data. All math lives in dna.scoring.ts (unit tested), using
// the formulas in decision-replay-docs/product-specs/decision-dna-formulas.md.
//
// Response shape is unchanged from the first draft (totalDecisions, overallDnaScore,
// dimensions[]). Added fields: dimensions[].hasData, dimensions[].evidence[], patterns[].
// ==============================================================================

import { prisma } from "../../config/database";
import { computeDnaProfile, DnaDecisionInput, DnaProfile } from "./dna.scoring";

export type { DnaDimensionMetric, DnaPattern, DnaProfile } from "./dna.scoring";

export class DnaService {
  /**
   * Aggregates longitudinal decision history into a 6-dimensional Decision DNA profile.
   * Only replayed decisions (an outcome exists) are included.
   */
  public async getDecisionDnaProfile(userId?: string): Promise<DnaProfile> {
    const decisions = await prisma.decision.findMany({
      where: {
        ...(userId ? { OR: [{ userId }, { userId: null }] } : {}),
        status: "REPLAYED",
        outcome: { isNot: null },
      },
      include: {
        assumptions: true,
        alternatives: true,
        preMortems: true,
        outcome: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const inputs: DnaDecisionInput[] = decisions.flatMap((d) =>
      d.outcome
        ? [
            {
              id: d.id,
              title: d.title,
              confidence: d.confidence, // set at lock time; the API has no way to edit it
              outcome: {
                outcomeScore: d.outcome.outcomeScore,
                predictionAccuracy: d.outcome.predictionAccuracy,
                unexpectedFactors: d.outcome.unexpectedFactors,
              },
              assumptions: d.assumptions.map((a) => ({
                metricTarget: a.metricTarget,
                metricActual: a.metricActual,
                validated: a.validated,
              })),
              preMortems: d.preMortems.map((p) => ({ occurredInReality: p.occurredInReality })),
              alternatives: d.alternatives.map((a) => ({ title: a.title, pros: a.pros, cons: a.cons })),
            },
          ]
        : [],
    );

    return computeDnaProfile(inputs);
  }

  /**
   * Detected reasoning patterns only (SCHEDULE_OPTIMISM, COST_UNDERESTIMATION,
   * PRE_MORTEM_ACCURACY, OVERCONFIDENCE, UNDERCONFIDENCE), each with evidence decision ids.
   */
  public async getPatterns(userId?: string) {
    const profile = await this.getDecisionDnaProfile(userId);
    return { totalDecisions: profile.totalDecisions, patterns: profile.patterns };
  }
}

export const dnaService = new DnaService();
