// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: Replay Engine, Prediction Accuracy Calculation & Variance Analysis
//
// Merged version: keeps Member A's method names and response shapes, and adds:
//  - atomic $transaction (nothing is half-saved)
//  - correct match rate (validated / ALL assumptions of the decision)
//  - automatic assumption check ("< 2 weeks" vs "10 days") via scoring.ts
//  - pre-mortem verification (PreMortem.occurredInReality)
//  - 404 / 409 / 422 errors instead of a generic Error
//
// Sign convention (kept from Member A): confidenceVariance = outcomeScore - confidence
//   negative = overconfident, positive = underconfident.
// ==============================================================================

import { prisma } from "../../config/database";
import { RecordOutcomeDto } from "./outcome.dto";
import {
  assumptionMatchRate,
  evaluateAssumption,
  predictionAccuracy as computePredictionAccuracy,
} from "./scoring";

/** Error with an HTTP status, for the global error filter. */
export class ReplayError extends Error {
  public readonly status: number;
  public readonly statusCode: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ReplayError";
    this.status = status;
    this.statusCode = status;
  }
}

/** Confidence as locked in the snapshot (falls back to the Decision row). */
function originalConfidence(payloadJson: string | null | undefined, fallback: number): number {
  if (!payloadJson) return fallback;
  try {
    const p = JSON.parse(payloadJson);
    const c = p?.decision?.confidence ?? p?.confidence;
    return typeof c === "number" ? c : fallback;
  } catch {
    return fallback;
  }
}

export class ReplayService {
  /**
   * Records the actual outcome, validates assumptions, and calculates accuracy metrics.
   */
  public async recordOutcome(decisionId: string, dto: RecordOutcomeDto) {
    const assumptionEvals = dto.assumptionEvaluations ?? [];
    const preMortemEvals = dto.preMortemEvaluations ?? [];

    const decision = await prisma.decision.findUnique({
      where: { id: decisionId },
      include: { assumptions: true, preMortems: true, snapshot: true, outcome: true },
    });

    if (!decision) throw new ReplayError(404, `Decision ${decisionId} not found`);
    if (decision.outcome) throw new ReplayError(409, "Outcome already recorded for this decision");
    if (decision.status === "DRAFT") {
      throw new ReplayError(422, "Decision must be locked before an outcome can be recorded");
    }

    // Every id sent must belong to this decision.
    const assumptionIds = new Set(decision.assumptions.map((a) => a.id));
    const preMortemIds = new Set(decision.preMortems.map((p) => p.id));
    if (assumptionEvals.some((e) => !assumptionIds.has(e.assumptionId))) {
      throw new ReplayError(422, "assumptionEvaluations contains an id that is not part of this decision");
    }
    if (preMortemEvals.some((e) => !preMortemIds.has(e.preMortemId))) {
      throw new ReplayError(422, "preMortemEvaluations contains an id that is not part of this decision");
    }

    // 1. Resolve every assumption: manual verdict wins, otherwise auto-compare.
    const assumptionResults = decision.assumptions.map((a) => {
      const sent = assumptionEvals.find((e) => e.assumptionId === a.id);
      const metricActual = sent?.metricActual ?? a.metricActual ?? null;
      const validated: boolean | null =
        sent?.validated ?? evaluateAssumption(a.metricTarget, metricActual);
      return { id: a.id, metricActual, validated };
    });

    // 2. Pre-mortem verification
    const preMortemResults = decision.preMortems.map((p) => {
      const sent = preMortemEvals.find((e) => e.preMortemId === p.id);
      return { id: p.id, occurredInReality: sent?.occurredInReality ?? p.occurredInReality ?? false };
    });

    // 3. Metrics (formulas in scoring.ts, from decision-dna-formulas.md)
    const matchRate = assumptionMatchRate(assumptionResults); // 0..1 or null
    const predictionAccuracy = computePredictionAccuracy(dto.outcomeScore, matchRate);
    const confidence = originalConfidence(decision.snapshot?.payloadJson, decision.confidence);
    const confidenceVariance = dto.outcomeScore - confidence;

    // 4. Save everything atomically
    let outcome: Awaited<ReturnType<typeof prisma.outcome.create>>;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        for (const a of assumptionResults) {
          await tx.assumption.update({
            where: { id: a.id },
            data: { metricActual: a.metricActual, validated: a.validated },
          });
        }
        for (const p of preMortemResults) {
          await tx.preMortem.update({
            where: { id: p.id },
            data: { occurredInReality: p.occurredInReality },
          });
        }

        const created = await tx.outcome.create({
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

        await tx.decision.update({ where: { id: decisionId }, data: { status: "REPLAYED" } });

        await tx.timelineEvent.create({
          data: {
            decisionId,
            eventType: "EVIDENCE_NOTE",
            title: "Replay Completed",
            detail: `Outcome recorded with ${dto.outcomeScore}/100 score and ${predictionAccuracy}% prediction accuracy.`,
          },
        });

        return created;
      });
    } catch (e) {
      // Two requests at the same time: @unique on Outcome.decisionId catches the second one.
      if ((e as { code?: string }).code === "P2002") {
        throw new ReplayError(409, "Outcome already recorded for this decision");
      }
      throw e;
    }

    return {
      // --- same fields as before (Member D's frontend relies on these) ---
      outcomeId: outcome.id,
      decisionId,
      predictionAccuracy,
      outcomeScore: dto.outcomeScore,
      confidenceVariance,
      assumptionAccuracyRate: Math.round((matchRate ?? 0) * 100),
      recordedAt: outcome.recordedAt,
      // --- new, additive fields ---
      originalConfidence: confidence,
      assumptionsValidated: assumptionResults.filter((a) => a.validated === true).length,
      assumptionsTotal: assumptionResults.length,
      assumptionsUndetermined: assumptionResults.filter((a) => a.validated === null).map((a) => a.id),
      preMortemMatched: preMortemResults.some((p) => p.occurredInReality),
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
    const confidence = originalConfidence(decision.snapshot?.payloadJson, decision.confidence);

    return {
      decisionId: decision.id,
      title: decision.title,
      initialSnapshot: {
        lockedAt: decision.lockedAt,
        confidence,
        expectedOutcome: decision.expectedOutcome,
        decisionReason: decision.decisionReason,
      },
      outcome: decision.outcome,
      metrics: {
        predictionAccuracy: decision.outcome.predictionAccuracy ?? decision.outcome.outcomeScore,
        confidenceCalibrationDelta: decision.outcome.outcomeScore - confidence,
        assumptionsValidatedRatio: `${validatedCount}/${totalCount}`,
        preMortemMatched: decision.preMortems.some((p) => p.occurredInReality === true),
      },
      assumptionDiffs: decision.assumptions.map((a) => ({
        id: a.id,
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
   * TODO: replace with the real pattern detectors in dna-engine (dna.service.ts).
   * Left unchanged for now so the existing API keeps working.
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
