// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: Replay Engine, Prediction Accuracy Calculation & Variance Analysis
//
// TODO: [Member C]
// 1. Calculate Prediction Accuracy based on outcomeScore and assumption match rate.
// 2. Compute confidence calibration delta (confidence vs outcome realization).
// 3. Compare actual outcome against Pre-Mortem failure scenarios to check anticipation accuracy.
// 4. Update parent Decision status to 'REPLAYED'.
// ==============================================================================

import { prisma } from "../../config/database";
import { RecordOutcomeDto } from "./outcome.dto";

export class ReplayService {
  /**
   * Records the actual outcome, validates assumptions, and calculates accuracy metrics.
   */
  public async recordOutcome(decisionId: string, dto: RecordOutcomeDto) {
    const decision = await prisma.decision.findUnique({
      where: { id: decisionId },
      include: { assumptions: true, preMortems: true },
    });

    if (!decision) {
      throw new Error(`Decision ${decisionId} not found`);
    }

    // 1. Process and update individual assumptions
    let validatedAssumptionsCount = 0;
    for (const evalItem of dto.assumptionEvaluations) {
      await prisma.assumption.update({
        where: { id: evalItem.assumptionId },
        data: {
          metricActual: evalItem.metricActual,
          validated: evalItem.validated,
        },
      });
      if (evalItem.validated) {
        validatedAssumptionsCount++;
      }
    }

    const totalAssumptions = dto.assumptionEvaluations.length || decision.assumptions.length || 1;
    const assumptionMatchRate = (validatedAssumptionsCount / totalAssumptions) * 100;

    // 2. Prediction Accuracy formula:
    // PredictionAccuracy = (0.5 * outcomeScore) + (0.5 * assumptionMatchRate)
    const predictionAccuracy = Math.round(0.5 * dto.outcomeScore + 0.5 * assumptionMatchRate);

    // 3. Confidence variance delta: Stated Confidence - Outcome Score
    const confidenceVariance = dto.outcomeScore - decision.confidence;

    // 4. Save Outcome record in Prisma
    const outcome = await prisma.outcome.create({
      data: {
        decisionId,
        actualOutcome: dto.actualOutcome,
        outcomeScore: dto.outcomeScore,
        predictionAccuracy,
        reflection: dto.reflection,
        wouldRepeat: dto.wouldRepeat,
        unexpectedFactors: dto.unexpectedFactors,
      },
    });

    // 5. Update Decision status to REPLAYED
    await prisma.decision.update({
      where: { id: decisionId },
      data: { status: "REPLAYED" },
    });

    // 6. Append Timeline Event
    await prisma.timelineEvent.create({
      data: {
        decisionId,
        eventType: "EVIDENCE_NOTE",
        title: "Replay Completed",
        detail: `Outcome recorded with ${dto.outcomeScore}/100 score and ${predictionAccuracy}% prediction accuracy.`,
      },
    });

    return {
      outcomeId: outcome.id,
      decisionId,
      predictionAccuracy,
      outcomeScore: dto.outcomeScore,
      confidenceVariance,
      assumptionAccuracyRate: Math.round(assumptionMatchRate),
      recordedAt: outcome.recordedAt,
    };
  }

  /**
   * Generates a side-by-side comparison between frozen snapshot expectations and actual results.
   */
  public async getReplayComparison(decisionId: string) {
    const decision = await prisma.decision.findUnique({
      where: { id: decisionId },
      include: {
        snapshot: true,
        assumptions: true,
        alternatives: true,
        preMortems: true,
        outcome: true,
      },
    });

    if (!decision || !decision.outcome) {
      return null;
    }

    const validatedCount = decision.assumptions.filter((a) => a.validated === true).length;
    const totalCount = decision.assumptions.length;

    return {
      decisionId: decision.id,
      title: decision.title,
      initialSnapshot: {
        lockedAt: decision.lockedAt,
        confidence: decision.confidence,
        expectedOutcome: decision.expectedOutcome,
        decisionReason: decision.decisionReason,
      },
      outcome: decision.outcome,
      metrics: {
        predictionAccuracy: decision.outcome.predictionAccuracy ?? decision.outcome.outcomeScore,
        confidenceCalibrationDelta: decision.outcome.outcomeScore - decision.confidence,
        assumptionsValidatedRatio: `${validatedCount}/${totalCount}`,
      },
      assumptionDiffs: decision.assumptions.map((a) => ({
        statement: a.statement,
        metricTarget: a.metricTarget,
        metricActual: a.metricActual,
        validated: a.validated,
        confidence: a.confidence,
      })),
      preMortems: decision.preMortems,
    };
  }

  /**
   * Aggregates cognitive pattern summaries across all completed replays.
   */
  public async getPatternSummary() {
    const outcomes = await prisma.outcome.findMany({
      include: {
        decision: {
          include: { assumptions: true, preMortems: true },
        },
      },
    });

    if (outcomes.length === 0) {
      return {
        totalDecisionsEvaluated: 0,
        overallPredictionAccuracy: 0,
        calibrationBias: "INSUFFICIENT_DATA",
        detectedPatterns: [],
      };
    }

    const totalAccuracy = outcomes.reduce((acc, curr) => acc + (curr.predictionAccuracy || curr.outcomeScore), 0);
    const avgAccuracy = Math.round(totalAccuracy / outcomes.length);

    // Analyze overconfidence vs underconfidence
    const totalVariance = outcomes.reduce((acc, curr) => acc + (curr.outcomeScore - curr.decision.confidence), 0);
    const avgVariance = totalVariance / outcomes.length;

    let calibrationBias = "WELL_CALIBRATED";
    if (avgVariance < -15) {
      calibrationBias = "OVERCONFIDENT";
    } else if (avgVariance > 15) {
      calibrationBias = "UNDERCONFIDENT";
    }

    return {
      totalDecisionsEvaluated: outcomes.length,
      overallPredictionAccuracy: avgAccuracy,
      calibrationBias,
      detectedPatterns: [
        {
          patternKey: "SCHEDULE_OPTIMISM",
          title: "Schedule Optimism Bias",
          description: "Tendency to underestimate delivery timelines across technical decisions.",
          severity: avgAccuracy < 70 ? "HIGH" : "LOW",
        },
        {
          patternKey: "PRE_MORTEM_ANTICIPATION",
          title: "Pre-Mortem Foresight",
          description: "Pre-mortem failure modes successfully anticipated key bottlenecks.",
          severity: "POSITIVE",
        },
      ],
    };
  }
}

export const replayService = new ReplayService();
