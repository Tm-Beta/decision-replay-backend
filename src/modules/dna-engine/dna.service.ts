// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: Decision DNA Longitudinal Aggregation & Evidence Mapping
//
// TODO: [Member C]
// 1. Calculate Brier score for Confidence Calibration using formulas in `decision-dna-formulas.md`.
// 2. Compute the 6 Decision DNA dimensions: Calibration, Prediction Accuracy, Assumption Rigor,
//    Risk Foresight, Estimation Accuracy, Alternative Breadth.
// 3. Attach clickable historical decision IDs (`evidenceDecisionIds`) for every metric so users can inspect evidence.
// ==============================================================================

import { prisma } from "../../config/database";

export interface DnaDimensionMetric {
  name: string;
  score: number; // 0 - 100
  label: string;
  description: string;
  evidenceDecisionIds: string[];
}

export class DnaService {
  /**
   * Aggregates longitudinal decision history into a 6-dimensional Decision DNA profile.
   */
  public async getDecisionDnaProfile(userId?: string) {
    const decisions = await prisma.decision.findMany({
      where: {
        ...(userId ? { userId } : {}),
        status: "REPLAYED",
      },
      include: {
        assumptions: true,
        alternatives: true,
        preMortems: true,
        outcome: true,
      },
    });

    if (decisions.length === 0) {
      return this.getDefaultEmptyProfile();
    }

    const decisionIds = decisions.map((d) => d.id);

    // 1. Confidence Calibration (Brier Score)
    // Brier Score = (1/N) * sum((confidence/100 - outcomeScore/100)^2)
    let brierSum = 0;
    for (const d of decisions) {
      const c = d.confidence / 100;
      const r = (d.outcome?.outcomeScore ?? 50) / 100;
      brierSum += Math.pow(c - r, 2);
    }
    const brierScore = brierSum / decisions.length;
    const calibrationScore = Math.round(Math.max(0, 100 * (1 - brierScore)));

    // 2. Prediction Accuracy
    const totalPredAccuracy = decisions.reduce(
      (acc, d) => acc + (d.outcome?.predictionAccuracy ?? d.outcome?.outcomeScore ?? 50),
      0
    );
    const avgPredictionAccuracy = Math.round(totalPredAccuracy / decisions.length);

    // 3. Assumption Rigor (% assumptions validated)
    let totalAssumptions = 0;
    let validatedAssumptions = 0;
    for (const d of decisions) {
      totalAssumptions += d.assumptions.length;
      validatedAssumptions += d.assumptions.filter((a) => a.validated === true).length;
    }
    const assumptionRigorScore =
      totalAssumptions > 0 ? Math.round((validatedAssumptions / totalAssumptions) * 100) : 70;

    // 4. Risk Foresight (Pre-Mortem effectiveness)
    let preMortemCount = 0;
    for (const d of decisions) {
      preMortemCount += d.preMortems.length;
    }
    const riskForesightScore = Math.min(100, Math.round((preMortemCount / decisions.length) * 40 + 20));

    // 5. Time & Cost Estimation
    const estimationScore = Math.round(
      Math.max(40, avgPredictionAccuracy * 0.85 + (assumptionRigorScore > 75 ? 10 : 0))
    );

    // 6. Alternative Breadth
    const avgAlternatives =
      decisions.reduce((acc, d) => acc + d.alternatives.length, 0) / decisions.length;
    const alternativeBreadthScore = Math.min(100, Math.round(avgAlternatives * 35));

    const dimensions: DnaDimensionMetric[] = [
      {
        name: "Calibration",
        score: calibrationScore,
        label: "Confidence Calibration",
        description: "How closely stated confidence correlates with empirical reality.",
        evidenceDecisionIds: decisionIds,
      },
      {
        name: "PredictionAccuracy",
        score: avgPredictionAccuracy,
        label: "Prediction Accuracy",
        description: "Overall fidelity of expected outcomes vs real outcomes.",
        evidenceDecisionIds: decisionIds,
      },
      {
        name: "AssumptionRigor",
        score: assumptionRigorScore,
        label: "Assumption Rigor",
        description: "Rate of validated hypotheses underpinning decisions.",
        evidenceDecisionIds: decisionIds,
      },
      {
        name: "RiskForesight",
        score: riskForesightScore,
        label: "Risk Foresight",
        description: "Proportion of real challenges anticipated in Pre-Mortems.",
        evidenceDecisionIds: decisionIds,
      },
      {
        name: "EstimationAccuracy",
        score: estimationScore,
        label: "Time & Cost Estimation",
        description: "Consistency in scheduling and cost estimation bounds.",
        evidenceDecisionIds: decisionIds,
      },
      {
        name: "AlternativeBreadth",
        score: alternativeBreadthScore,
        label: "Alternative Breadth",
        description: "Exploration of viable counter-options before commitment.",
        evidenceDecisionIds: decisionIds,
      },
    ];

    return {
      totalDecisions: decisions.length,
      overallDnaScore: Math.round(
        dimensions.reduce((acc, dim) => acc + dim.score, 0) / dimensions.length
      ),
      dimensions,
    };
  }

  private getDefaultEmptyProfile() {
    return {
      totalDecisions: 0,
      overallDnaScore: 0,
      dimensions: [
        { name: "Calibration", score: 50, label: "Confidence Calibration", description: "No replayed decisions yet.", evidenceDecisionIds: [] },
        { name: "PredictionAccuracy", score: 50, label: "Prediction Accuracy", description: "No replayed decisions yet.", evidenceDecisionIds: [] },
        { name: "AssumptionRigor", score: 50, label: "Assumption Rigor", description: "No replayed decisions yet.", evidenceDecisionIds: [] },
        { name: "RiskForesight", score: 50, label: "Risk Foresight", description: "No replayed decisions yet.", evidenceDecisionIds: [] },
        { name: "EstimationAccuracy", score: 50, label: "Time & Cost Estimation", description: "No replayed decisions yet.", evidenceDecisionIds: [] },
        { name: "AlternativeBreadth", score: 50, label: "Alternative Breadth", description: "No replayed decisions yet.", evidenceDecisionIds: [] },
      ],
    };
  }
}

export const dnaService = new DnaService();
