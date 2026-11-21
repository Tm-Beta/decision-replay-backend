// Pure scoring functions for the Replay Engine.
// Formulas follow decision-replay-docs/product-specs/decision-dna-formulas.md
// No database access here, so everything is easy to unit test.

export const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

// ---------- Metric text parsing ("< 2 weeks", "$500", "10 days") ----------

export type Comparator = '<' | '<=' | '>' | '>=' | '=';

export interface ParsedMetric {
  comparator: Comparator;
  value: number;
  unit: string; // '' | 'days' | 'currency' | any other lower-cased unit
}

const TIME_TO_DAYS: Record<string, number> = {
  h: 1 / 24, hr: 1 / 24, hrs: 1 / 24, hour: 1 / 24, hours: 1 / 24,
  d: 1, day: 1, days: 1,
  w: 7, wk: 7, wks: 7, week: 7, weeks: 7,
  mo: 30, month: 30, months: 30,
};

// optional operator, optional currency symbol, number, optional "k", optional unit
const PATTERN =
  /^\s*(<=|>=|≤|≥|<|>|=)?\s*([$€£])?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(k(?![a-zA-Z]))?\s*([a-zA-Z%]*)\s*$/;

export function parseMetric(text: string | null | undefined): ParsedMetric | null {
  if (!text) return null;
  const m = PATTERN.exec(text);
  if (!m) return null;

  const [, op, currency, num, kilo, rawUnit] = m;
  const comparator: Comparator =
    op === '≤' ? '<=' : op === '≥' ? '>=' : ((op as Comparator) ?? '=');

  let value = parseFloat(num.replace(/,/g, '')) * (kilo ? 1000 : 1);
  let unit = rawUnit.toLowerCase();

  if (currency) {
    unit = 'currency';
  } else if (unit in TIME_TO_DAYS) {
    value *= TIME_TO_DAYS[unit];
    unit = 'days';
  }
  return { comparator, value, unit };
}

// Units are compatible when equal, or when either side has no unit.
const unitsCompatible = (a: ParsedMetric, b: ParsedMetric): boolean =>
  !a.unit || !b.unit || a.unit === b.unit;

/**
 * Compares the target ("< 2 weeks") with the actual ("10 days").
 * Returns true/false, or null if the text can't be compared automatically
 * (then the user must mark the assumption as validated manually).
 * Targets with no operator ("$500") count as met within +/-10%.
 */
export function evaluateAssumption(
  target: string | null | undefined,
  actual: string | null | undefined,
): boolean | null {
  const t = parseMetric(target);
  const a = parseMetric(actual);
  if (!t || !a || !unitsCompatible(t, a)) return null;

  switch (t.comparator) {
    case '<': return a.value < t.value;
    case '<=': return a.value <= t.value;
    case '>': return a.value > t.value;
    case '>=': return a.value >= t.value;
    case '=':
      return t.value === 0
        ? a.value === 0
        : Math.abs(a.value - t.value) <= 0.1 * Math.abs(t.value);
  }
}

// ---------- Formula 2.2: Prediction accuracy ----------

/** Fraction 0..1 of assumptions validated === true. null when there are none. */
export function assumptionMatchRate(
  assumptions: { validated: boolean | null }[],
): number | null {
  if (assumptions.length === 0) return null;
  const ok = assumptions.filter((a) => a.validated === true).length;
  return ok / assumptions.length;
}

/**
 * 0.5 * OutcomeScore + 0.5 * AssumptionMatchRate.
 * NOTE: the docs mix scales (OutcomeScore is 0-100, match rate is 0-1),
 * so the match rate is multiplied by 100 here.
 * With no assumptions, accuracy falls back to the outcome score alone.
 */
export function predictionAccuracy(
  outcomeScore: number,
  matchRate: number | null,
): number {
  const raw =
    matchRate === null
      ? outcomeScore
      : 0.5 * outcomeScore + 0.5 * (matchRate * 100);
  return Math.round(clamp(raw, 0, 100));
}

// ---------- Formula 2.1: Brier score & calibration ----------

/** Positive = overconfident, negative = underconfident (percentage points). */
export const calibrationDelta = (confidence: number, outcomeScore: number): number =>
  confidence - outcomeScore;

/** Squared error for one decision, using c = confidence/100, r = outcomeScore/100. */
export const brierTerm = (confidence: number, outcomeScore: number): number =>
  ((confidence - outcomeScore) / 100) ** 2;

/** Mean Brier score over many decisions. null when the list is empty. */
export function brierScore(
  items: { confidence: number; outcomeScore: number }[],
): number | null {
  if (items.length === 0) return null;
  const sum = items.reduce((s, i) => s + brierTerm(i.confidence, i.outcomeScore), 0);
  return sum / items.length;
}

/** max(0, 100 * (1 - Brier)) */
export const calibrationScore = (brier: number): number =>
  Math.max(0, 100 * (1 - brier));

// ---------- Formula 2.3: Time & cost estimation ----------

/** max(0, 100 * (1 - |actual - target| / target)). null if target <= 0. */
export function estimationScore(target: number, actual: number): number | null {
  if (!(target > 0)) return null;
  const errorRatio = Math.abs(actual - target) / target;
  return Math.max(0, 100 * (1 - errorRatio));
}

/** Same as above but takes the raw text values ("2 weeks", "3 weeks"). */
export function estimationScoreFromText(
  target: string | null | undefined,
  actual: string | null | undefined,
): number | null {
  const t = parseMetric(target);
  const a = parseMetric(actual);
  if (!t || !a || !unitsCompatible(t, a)) return null;
  return estimationScore(t.value, a.value);
}
