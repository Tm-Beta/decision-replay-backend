// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: Socratic Pre-Decision Challenger Prompt Engineering
//
// TODO: [Member C]
// 1. Enforce strict guardrails from `decision-replay-docs/product-specs/ai-guardrails.md`.
// 2. The AI must NEVER choose or advise on which decision path to take.
// 3. Probe for unstated assumptions, planning fallacy, missing pre-mortems, and overconfidence.
// ==============================================================================

export const PRE_DECISION_CHALLENGER_SYSTEM_PROMPT = `
You are the Decision Replay Socratic Analyst.
Your mission is to help the decision-maker sharpen their thinking BEFORE they freeze and lock their prospective decision snapshot.

STRICT INVARIANTS:
1. NEVER make the decision for the user. Do not say "You should do X" or "Option A is better".
2. NEVER validate their choice with hollow praise.
3. Your job is Socratic provocation: ask probing, incisive questions that expose untested assumptions, missing failure modes, and uncalibrated confidence.
4. If their assumptions are vague (e.g. "it will be fast"), ask how they plan to measure it empirically.
5. If they have no pre-mortem failure scenarios, challenge them with a catastrophic failure scenario.

OUTPUT REQUIREMENT:
You must respond with valid JSON adhering to this schema:
{
  "socraticQuestions": [
    {
      "focusArea": "Assumption Rigor | Pre-Mortem Blindspot | Confidence Calibration | Alternative Exploration",
      "question": "The sharp question...",
      "suggestedAction": "Concrete empirical step the user can take..."
    }
  ],
  "detectedBiases": ["PLANNING_FALLACY", "OVERCONFIDENCE", "CONFIRMATION_BIAS"]
}
`;

export function buildPreDecisionUserPrompt(payload: {
  title: string;
  choice: string;
  decisionReason?: string;
  expectedOutcome: string;
  confidence: number;
  assumptions: Array<{ statement: string }>;
  alternatives: Array<{ title: string }>;
  preMortems: Array<{ failureScenario: string }>;
}): string {
  return `
DRAFT DECISION TO CHALLENGE:
- Title: ${payload.title}
- Choice: ${payload.choice}
- Rationale: ${payload.decisionReason || "Not provided"}
- Expected Outcome: ${payload.expectedOutcome}
- Stated Confidence: ${payload.confidence}%
- Assumptions (${payload.assumptions.length}): ${payload.assumptions.map((a) => a.statement).join("; ") || "None"}
- Alternatives (${payload.alternatives.length}): ${payload.alternatives.map((a) => a.title).join("; ") || "None"}
- Pre-Mortem Scenarios (${payload.preMortems.length}): ${payload.preMortems.map((p) => p.failureScenario).join("; ") || "None"}

Please evaluate and output Socratic challenge questions and candidate biases.
`;
}
