// Pure Decision DNA math (no database). Formulas: decision-dna-formulas.md
// dna.service.ts loads replayed decisions and passes them in as plain objects.

import { calibrationScore, estimationScore, parseMetric } from "../replay-engine/scoring";

/** Patterns need at least this many data points before they are flagged. */
export const MIN_SAMPLES = 3;
/** Planning fallacy flag: actual > target in more than 60% of measurements (formula 2.3). */
const PLANNING_FALLACY_RATIO = 0.6;
/** Over/under-confidence flag: sum of differences > 0.15 * N (formula 2.1). */
const CALIBRATION_BIAS_PER_DECISION = 0.15;

export interface DnaDecisionInput {
  id: string;
  title: string;
  confidence: number; // 1-100, stated before the decision was locked
  outcome: {
    outcomeScore: number; // 0-100
    predictionAccuracy: number | null;
    unexpectedFactors: string;
  };
  assumptions: {
    metricTarget: string | null;
    metricActual: string | null;
    validated: boolean | null;
  }[];
  preMortems: { occurredInReality: boolean | null }[];
  alternatives: { title: string; pros: string; cons: string }[];
}

export interface DnaEvidence {
  decisionId: string;
  title: string;
  note: string;
}

export interface DnaDimensionMetric {
  name: string;
  score: number; // 0-100 (50 = neutral placeholder when hasData is false)
  label: string;
  description: string;
  hasData: boolean;
  evidenceDecisionIds: string[];
  evidence: DnaEvidence[];
}

export interface DnaPattern {
  patternKey: string;
  title: string;
  description: string;
  severity: "HIGH" | "MEDIUM" | "LOW" | "POSITIVE";
  evidenceDecisionIds: string[];
}

export interface DnaProfile {
  totalDecisions: number;
  overallDnaScore: number;
  dimensions: DnaDimensionMetric[];
  patterns: DnaPattern[];
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const unique = (xs: string[]): string[] => Array.from(new Set(xs));

/** Counts items in a free-text list separated by new lines or semicolons. */
export function countSurprises(text: string): number {
  return text
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

function dimension(
  name: string,
  label: string,
  description: string,
  score: number | null,
  evidence: DnaEvidence[],
): DnaDimensionMetric {
  const hasData = score !== null;
  return {
    name,
    label,
    description: hasData ? description : `${description} Not enough data yet.`,
    score: hasData ? Math.round(score as number) : 50,
    hasData,
    evidenceDecisionIds: evidence.map((e) => e.decisionId),
    evidence,
  };
}

interface Measurement {
  decisionId: string;
  kind: "days" | "currency";
  score: number;
  over: boolean;
}

/** Time/cost estimates: assumptions whose target AND actual both parse as days or money. */
function measureEstimates(d: DnaDecisionInput): Measurement[] {
  const out: Measurement[] = [];
  for (const a of d.assumptions) {
    const t = parseMetric(a.metricTarget);
    const act = parseMetric(a.metricActual);
    if (!t || !act) continue;
    if (t.unit !== "days" && t.unit !== "currency") continue;
    if (act.unit && act.unit !== t.unit) continue;
    if (t.comparator === ">" || t.comparator === ">=") continue; // not an estimate to stay under
    const s = estimationScore(t.value, act.value);
    if (s === null) continue;
    out.push({ decisionId: d.id, kind: t.unit as "days" | "currency", score: s, over: act.value > t.value });
  }
  return out;
}

export function computeDnaProfile(decisions: DnaDecisionInput[]): DnaProfile {
  const n = decisions.length;
  const patterns: DnaPattern[] = [];

  // ---- 1. Confidence Calibration (2.1) ----
  let calibration: number | null = null;
  const calibrationEvidence: DnaEvidence[] = [];
  if (n > 0) {
    const terms = decisions.map((d) => ({
      d,
      c: d.confidence / 100,
      r: d.outcome.outcomeScore / 100,
    }));
    const brier = mean(terms.map((t) => (t.c - t.r) ** 2));
    calibration = calibrationScore(brier);
    for (const t of terms) {
      calibrationEvidence.push({
        decisionId: t.d.id,
        title: t.d.title,
        note: `Confidence ${t.d.confidence}% vs outcome ${t.d.outcome.outcomeScore}/100`,
      });
    }
    const diff = terms.reduce((s, t) => s + (t.c - t.r), 0);
    if (n >= MIN_SAMPLES && diff > CALIBRATION_BIAS_PER_DECISION * n) {
      const ev = terms.filter((t) => t.c > t.r).map((t) => t.d.id);
      patterns.push({
        patternKey: "OVERCONFIDENCE",
        title: "Overconfidence",
        description: `Stated confidence was higher than the realized outcome in ${ev.length} of ${n} replayed decisions.`,
        severity: "MEDIUM",
        evidenceDecisionIds: ev,
      });
    } else if (n >= MIN_SAMPLES && -diff > CALIBRATION_BIAS_PER_DECISION * n) {
      const ev = terms.filter((t) => t.r > t.c).map((t) => t.d.id);
      patterns.push({
        patternKey: "UNDERCONFIDENCE",
        title: "Underconfidence",
        description: `The realized outcome was better than the stated confidence in ${ev.length} of ${n} replayed decisions.`,
        severity: "LOW",
        evidenceDecisionIds: ev,
      });
    }
  }

  // ---- 2. Prediction Accuracy (2.2) ----
  const predictionEvidence: DnaEvidence[] = decisions.map((d) => ({
    decisionId: d.id,
    title: d.title,
    note: `Prediction accuracy ${d.outcome.predictionAccuracy ?? d.outcome.outcomeScore}%`,
  }));
  const predictionAccuracy =
    n > 0 ? mean(decisions.map((d) => d.outcome.predictionAccuracy ?? d.outcome.outcomeScore)) : null;

  // ---- 3. Assumption Rigor ----
  const rigorEvidence: DnaEvidence[] = [];
  let totalAssumptions = 0;
  let validatedAssumptions = 0;
  for (const d of decisions) {
    if (d.assumptions.length === 0) continue;
    const ok = d.assumptions.filter((a) => a.validated === true).length;
    totalAssumptions += d.assumptions.length;
    validatedAssumptions += ok;
    rigorEvidence.push({
      decisionId: d.id,
      title: d.title,
      note: `${ok} of ${d.assumptions.length} assumptions validated`,
    });
  }
  const rigor = totalAssumptions > 0 ? (validatedAssumptions / totalAssumptions) * 100 : null;

  // ---- 4. Risk Foresight (2.4) ----
  // anticipated = pre-mortem failures that really happened
  // unanticipated = surprises listed in Outcome.unexpectedFactors (one item per line / ";")
  const riskEvidence: DnaEvidence[] = [];
  let anticipatedTotal = 0;
  let unanticipatedTotal = 0;
  for (const d of decisions) {
    const anticipated = d.preMortems.filter((p) => p.occurredInReality === true).length;
    const unanticipated = countSurprises(d.outcome.unexpectedFactors);
    anticipatedTotal += anticipated;
    unanticipatedTotal += unanticipated;
    if (anticipated + unanticipated > 0) {
      riskEvidence.push({
        decisionId: d.id,
        title: d.title,
        note: `${anticipated} anticipated, ${unanticipated} unanticipated`,
      });
    }
  }
  const riskDenominator = anticipatedTotal + unanticipatedTotal;
  const riskForesight = riskDenominator > 0 ? (anticipatedTotal / riskDenominator) * 100 : null;
  if (riskForesight !== null && riskEvidence.length >= MIN_SAMPLES) {
    const ids = riskEvidence.map((e) => e.decisionId);
    if (riskForesight > 70) {
      patterns.push({
        patternKey: "PRE_MORTEM_ACCURACY",
        title: "Pre-Mortem Foresight",
        description: `${anticipatedTotal} of ${riskDenominator} real failures or surprises were listed in a pre-mortem.`,
        severity: "POSITIVE",
        evidenceDecisionIds: ids,
      });
    } else if (riskForesight < 50) {
      patterns.push({
        patternKey: "PRE_MORTEM_ACCURACY",
        title: "Unanticipated Surprises",
        description: `Only ${anticipatedTotal} of ${riskDenominator} real failures or surprises were listed in a pre-mortem.`,
        severity: "MEDIUM",
        evidenceDecisionIds: ids,
      });
    }
  }

  // ---- 5. Time & Cost Estimation (2.3) ----
  const measurements = decisions.flatMap(measureEstimates);
  const byDecision = new Map<string, Measurement[]>();
  for (const m of measurements) byDecision.set(m.decisionId, [...(byDecision.get(m.decisionId) ?? []), m]);
  const estimationEvidence: DnaEvidence[] = decisions
    .filter((d) => byDecision.has(d.id))
    .map((d) => {
      const ms = byDecision.get(d.id)!;
      return {
        decisionId: d.id,
        title: d.title,
        note: `${ms.length} time/cost estimate(s), average score ${Math.round(mean(ms.map((m) => m.score)))}`,
      };
    });
  const estimation = measurements.length > 0 ? mean(measurements.map((m) => m.score)) : null;

  const planningRules: { kind: "days" | "currency"; key: string; title: string; what: string }[] = [
    { kind: "days", key: "SCHEDULE_OPTIMISM", title: "Schedule Optimism", what: "time estimates" },
    { kind: "currency", key: "COST_UNDERESTIMATION", title: "Cost Underestimation", what: "cost estimates" },
  ];
  for (const rule of planningRules) {
    const ms = measurements.filter((m) => m.kind === rule.kind);
    const over = ms.filter((m) => m.over);
    const ratio = ms.length > 0 ? over.length / ms.length : 0;
    if (ms.length >= MIN_SAMPLES && ratio > PLANNING_FALLACY_RATIO) {
      patterns.push({
        patternKey: rule.key,
        title: rule.title,
        description: `In ${over.length} of ${ms.length} ${rule.what}, the actual value exceeded the target.`,
        severity: ratio >= 0.8 ? "HIGH" : "MEDIUM",
        evidenceDecisionIds: unique(over.map((m) => m.decisionId)),
      });
    }
  }

  // ---- 6. Alternative Breadth (2.5) ----
  const breadthEvidence: DnaEvidence[] = decisions.map((d) => {
    const count = d.alternatives.filter((a) => a.title.trim().length > 0).length;
    const hasTradeoffs = d.alternatives.some((a) => a.pros.trim() || a.cons.trim());
    const score = Math.min(100, 30 * count + (hasTradeoffs ? 20 : 0));
    return {
      decisionId: d.id,
      title: d.title,
      note: `${count} alternative(s), trade-offs ${hasTradeoffs ? "listed" : "missing"} (score ${score})`,
    };
  });
  const breadth =
    n > 0
      ? mean(
          decisions.map((d) => {
            const count = d.alternatives.filter((a) => a.title.trim().length > 0).length;
            const hasTradeoffs = d.alternatives.some((a) => a.pros.trim() || a.cons.trim());
            return Math.min(100, 30 * count + (hasTradeoffs ? 20 : 0));
          }),
        )
      : null;

  const dimensions: DnaDimensionMetric[] = [
    dimension("Calibration", "Confidence Calibration", "How closely stated confidence matches realized outcomes (Brier score).", calibration, calibrationEvidence),
    dimension("PredictionAccuracy", "Prediction Accuracy", "Closeness of actual outcomes to expected results.", predictionAccuracy, predictionEvidence),
    dimension("AssumptionRigor", "Assumption Rigor", "Share of testable assumptions that were validated.", rigor, rigorEvidence),
    dimension("RiskForesight", "Risk Foresight", "Share of real failures and surprises that were anticipated in pre-mortems.", riskForesight, riskEvidence),
    dimension("EstimationAccuracy", "Time & Cost Estimation", "Precision of time and cost targets versus actual values.", estimation, estimationEvidence),
    dimension("AlternativeBreadth", "Alternative Breadth", "Alternatives and trade-offs weighed before committing.", breadth, breadthEvidence),
  ];

  const scored = dimensions.filter((d) => d.hasData);
  return {
    totalDecisions: n,
    overallDnaScore: scored.length > 0 ? Math.round(mean(scored.map((d) => d.score))) : 0,
    dimensions,
    patterns,
  };
}
