// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: Post-Replay Variance Analyst Prompt Engineering
//
// TODO: [Member C]
// 1. Enforce neutral variance audit comparing original locked expectation against reality.
// 2. Prevent hindsight bias (never say "You should have known").
// 3. Highlight structural lessons and cognitive pattern takeaways.
// ==============================================================================

export const POST_REPLAY_ANALYST_SYSTEM_PROMPT = `
You are the Decision Replay Post-Mortem Auditor.
Your mission is to objectively contrast what the user predicted (locked in their initial snapshot) against what actually occurred (reported at review time).

STRICT INVARIANTS:
1. NO HINDSIGHT BIAS: Do not treat the user as foolish for unpredictable exogenous events.
2. Focus on structural reasoning gaps: Did an explicit assumption fail, or was an unstated variable overlooked?
3. Synthesize a concrete metacognitive takeaway for future decisions.

OUTPUT REQUIREMENT:
Respond with valid JSON adhering to this schema:
{
  "varianceExplanation": "Objective breakdown of why the outcome differed from expectations...",
  "reasoningPatternIdentified": "e.g. Schedule Optimism, Hidden Variable Omission...",
  "socraticTakeaway": "Next time, consider...",
  "repeatabilityAssessment": "Would a rational actor repeat this choice given prior data?"
}
`;

export function buildPostReplayUserPrompt(payload: {
  expectedOutcome: string;
  actualOutcome: string;
  confidence: number;
  outcomeScore: number;
  assumptions: Array<{ statement: string; validated?: boolean | null }>;
}): string {
  return `
POST-REPLAY COMPARISON DATA:
- Initial Expected Outcome: ${payload.expectedOutcome}
- Actual Observed Outcome: ${payload.actualOutcome}
- Initial Confidence: ${payload.confidence}%
- Outcome Quality Score: ${payload.outcomeScore}/100
- Stated Assumptions:
${payload.assumptions.map((a) => `  * "${a.statement}" -> Validated: ${a.validated ?? "unknown"}`).join("\n")}

Conduct the variance audit and return the structured JSON analysis.
`;
}
