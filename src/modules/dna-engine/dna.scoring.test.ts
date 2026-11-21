import { describe, it, expect } from "vitest";
import { computeDnaProfile, countSurprises, DnaDecisionInput } from "./dna.scoring";

// Three decisions, all numbers computed by hand:
//
// Calibration: (0.8-0.6)^2 + (0.7-0.9)^2 + (0.9-0.4)^2 = 0.04 + 0.04 + 0.25 -> Brier 0.11 -> 89
//   sum(c - r) = 0.2 - 0.2 + 0.5 = 0.5 > 0.15 * 3 = 0.45 -> OVERCONFIDENCE
// Prediction accuracy: (63 + 85 + 40 [outcomeScore fallback]) / 3 = 62.67 -> 63
// Assumption rigor: validated 2 + 1 + 0 = 3 of 3 + 1 + 1 = 5 -> 60
// Risk foresight: anticipated 1 + 0 + 1 = 2, unanticipated 1 + 0 + 0 = 1 -> 2/3 = 66.7 -> 67 (no pattern)
// Estimation: "< 2 weeks" vs "3 weeks" = 50 (over), "$500" vs "$450" = 90, "< 10 days" vs "8 days" = 80,
//   "< 1 week" vs "10 days" = 57.14 (over). Mean = 69.29 -> 69.
//   Days: 3 measurements, 2 over (66.7% > 60%) -> SCHEDULE_OPTIMISM for decisions a and c.
//   Currency: only 1 measurement (< 3) -> no COST_UNDERESTIMATION.
// Breadth: a = 30 + 20 = 50, b = 60 + 20 = 80, c = 0 -> 43.33 -> 43
// Overall: (89 + 63 + 60 + 67 + 69 + 43) / 6 = 65.17 -> 65
const decisions: DnaDecisionInput[] = [
  {
    id: "a",
    title: "Decision A",
    confidence: 80,
    outcome: { outcomeScore: 60, predictionAccuracy: 63, unexpectedFactors: "Cloud pricing change" },
    assumptions: [
      { metricTarget: "< 2 weeks", metricActual: "3 weeks", validated: false },
      { metricTarget: "$500", metricActual: "$450", validated: true },
      { metricTarget: null, metricActual: null, validated: true },
    ],
    preMortems: [{ occurredInReality: true }, { occurredInReality: false }],
    alternatives: [{ title: "X", pros: "cheap", cons: "" }],
  },
  {
    id: "b",
    title: "Decision B",
    confidence: 70,
    outcome: { outcomeScore: 90, predictionAccuracy: 85, unexpectedFactors: "" },
    assumptions: [{ metricTarget: "< 10 days", metricActual: "8 days", validated: true }],
    preMortems: [{ occurredInReality: false }],
    alternatives: [
      { title: "Y", pros: "", cons: "" },
      { title: "Z", pros: "", cons: "slow" },
    ],
  },
  {
    id: "c",
    title: "Decision C",
    confidence: 90,
    outcome: { outcomeScore: 40, predictionAccuracy: null, unexpectedFactors: "" },
    assumptions: [{ metricTarget: "< 1 week", metricActual: "10 days", validated: false }],
    preMortems: [{ occurredInReality: true }],
    alternatives: [],
  },
];

const make = (id: string, over: Partial<DnaDecisionInput>): DnaDecisionInput => ({
  id,
  title: id,
  confidence: 60,
  outcome: { outcomeScore: 60, predictionAccuracy: 60, unexpectedFactors: "" },
  assumptions: [],
  preMortems: [],
  alternatives: [],
  ...over,
});

describe("computeDnaProfile (hand-computed dataset)", () => {
  const profile = computeDnaProfile(decisions);
  const score = (name: string) => profile.dimensions.find((d) => d.name === name)!;

  it("scores the six dimensions", () => {
    expect(profile.totalDecisions).toBe(3);
    expect(score("Calibration").score).toBe(89);
    expect(score("PredictionAccuracy").score).toBe(63);
    expect(score("AssumptionRigor").score).toBe(60);
    expect(score("RiskForesight").score).toBe(67);
    expect(score("EstimationAccuracy").score).toBe(69);
    expect(score("AlternativeBreadth").score).toBe(43);
    expect(profile.overallDnaScore).toBe(65);
  });

  it("keeps the dimension names the frontend already uses", () => {
    expect(profile.dimensions.map((d) => d.name)).toEqual([
      "Calibration",
      "PredictionAccuracy",
      "AssumptionRigor",
      "RiskForesight",
      "EstimationAccuracy",
      "AlternativeBreadth",
    ]);
  });

  it("detects exactly OVERCONFIDENCE and SCHEDULE_OPTIMISM", () => {
    expect(profile.patterns.map((p) => p.patternKey).sort()).toEqual([
      "OVERCONFIDENCE",
      "SCHEDULE_OPTIMISM",
    ]);
  });

  it("points to the exact decisions behind each pattern", () => {
    const schedule = profile.patterns.find((p) => p.patternKey === "SCHEDULE_OPTIMISM")!;
    expect(schedule.evidenceDecisionIds).toEqual(["a", "c"]);
    const over = profile.patterns.find((p) => p.patternKey === "OVERCONFIDENCE")!;
    expect(over.evidenceDecisionIds).toEqual(["a", "c"]);
  });

  it("lists only contributing decisions as evidence", () => {
    expect(score("RiskForesight").evidenceDecisionIds).toEqual(["a", "c"]);
    expect(score("EstimationAccuracy").evidenceDecisionIds).toEqual(["a", "b", "c"]);
  });
});

describe("other cases", () => {
  it("returns a neutral empty profile with no data", () => {
    const p = computeDnaProfile([]);
    expect(p.totalDecisions).toBe(0);
    expect(p.overallDnaScore).toBe(0);
    expect(p.patterns).toEqual([]);
    expect(p.dimensions).toHaveLength(6);
    expect(p.dimensions.every((d) => !d.hasData && d.score === 50)).toBe(true);
  });

  it("flags PRE_MORTEM_ACCURACY as positive above 70%", () => {
    const three = ["x", "y", "z"].map((id) => make(id, { preMortems: [{ occurredInReality: true }] }));
    const p = computeDnaProfile(three);
    expect(p.dimensions.find((d) => d.name === "RiskForesight")!.score).toBe(100);
    const pm = p.patterns.find((x) => x.patternKey === "PRE_MORTEM_ACCURACY")!;
    expect(pm.severity).toBe("POSITIVE");
  });

  it("flags UNDERCONFIDENCE when outcomes beat stated confidence", () => {
    const three = ["x", "y", "z"].map((id) =>
      make(id, { confidence: 40, outcome: { outcomeScore: 80, predictionAccuracy: 80, unexpectedFactors: "" } }),
    );
    const keys = computeDnaProfile(three).patterns.map((p) => p.patternKey);
    expect(keys).toEqual(["UNDERCONFIDENCE"]);
  });

  it("does not flag patterns with fewer than 3 data points", () => {
    const two = [decisions[0], decisions[2]];
    expect(computeDnaProfile(two).patterns).toEqual([]);
  });

  it("counts surprises by line or semicolon", () => {
    expect(countSurprises("")).toBe(0);
    expect(countSurprises("Cloud pricing change")).toBe(1);
    expect(countSurprises("a; b\nc")).toBe(3);
  });
});
