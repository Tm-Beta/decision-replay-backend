// ==============================================================================
// Guardrail enforcement for AI output (decision-replay-docs/product-specs/ai-guardrails.md)
//
// Live LLM answers are never trusted. Every answer must:
//   1. be valid JSON in the expected shape,
//   2. contain no guardrail violation (G-01 prescriptive, G-03 diagnosis, G-04 certainty,
//      hindsight bias),
// otherwise it is dropped and the deterministic analyzer is used instead.
// ==============================================================================

import { z } from "zod";

export const MAX_QUESTIONS = 4;

const RULES: { rule: string; pattern: RegExp }[] = [
  // G-01: never tell the user what to choose
  {
    rule: "G-01 prescriptive",
    pattern:
      /\byou should (?:not )?(?:choose|pick|select|go with|proceed|abandon|cancel|reject|accept|commit|lock|hire|buy|invest|stick with)\b/i,
  },
  {
    rule: "G-01 prescriptive",
    pattern:
      /\bi (?:strongly |would )?(?:recommend|suggest|advise)\b[^.?!]{0,60}\b(?:choos|pick|select|go(?:ing)? with|proceed|option|alternative)/i,
  },
  {
    rule: "G-01 prescriptive",
    pattern:
      /\b(?:option|alternative|choice)\s+\w+\s+is\s+(?:clearly\s+|definitely\s+)?(?:the\s+)?(?:best|better|superior|optimal|right|wrong|worse)\b/i,
  },
  {
    rule: "G-01 prescriptive",
    pattern: /\bthe (?:best|right|wrong|safest|smartest) (?:option|choice|decision|alternative|path)\b/i,
  },
  {
    rule: "G-01 prescriptive",
    pattern: /\b(?:go|going|stick|sticking) with (?:option|alternative|the (?:first|second|original|safer|cheaper))\b/i,
  },
  // G-03: no psychological diagnosis
  {
    rule: "G-03 diagnosis",
    pattern:
      /\byou(?:'re| are| seem| appear)\s+(?:a |an |very |too |rather |quite )?(?:narcissistic|fearful|anxious|reckless|lazy|arrogant|impulsive|irrational|stupid|foolish|careless|naive)\b/i,
  },
  { rule: "G-03 diagnosis", pattern: /\byour (?:personality|character flaw|temperament)\b/i },
  // Hindsight bias
  {
    rule: "hindsight",
    pattern:
      /\b(?:should have known|could have (?:seen|known|predicted|avoided)|obvious (?:in hindsight|that)|you were (?:foolish|wrong to|careless))\b/i,
  },
  // G-04: epistemic humility, no definitive predictions
  {
    rule: "G-04 certainty",
    pattern:
      /\b(?:will (?:definitely|certainly|surely|absolutely)|is (?:certain|guaranteed|bound) to|(?:guaranteed|certain) to (?:fail|succeed)|100% (?:certain|sure))\b/i,
  },
];

/** Names of the guardrail rules the text breaks (empty array = clean). */
export function findViolations(text: string): string[] {
  return Array.from(new Set(RULES.filter((r) => r.pattern.test(text)).map((r) => r.rule)));
}

/** Makes user-supplied text safe to place inside a prompt (no tags, one line, length limit). */
export function cleanForPrompt(text: string, max = 400): string {
  return text.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Extracts a JSON object from an LLM reply, tolerating code fences and surrounding text. */
export function parseLooseJson(content: unknown): unknown {
  if (typeof content !== "string") return null;
  const cleaned = content.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const text = (max: number) => z.string().trim().min(1).max(max);

export const ChallengeOutputSchema = z.object({
  socraticQuestions: z
    .array(z.object({ focusArea: text(80), question: text(600), suggestedAction: text(500) }))
    .min(1)
    .max(8),
  detectedBiases: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
});

export const ReplayAnalysisOutputSchema = z.object({
  varianceExplanation: text(1200),
  reasoningPatternIdentified: text(200),
  socraticTakeaway: text(600),
  repeatabilityAssessment: text(600),
});

export type ChallengeOutput = z.infer<typeof ChallengeOutputSchema>;
export type ReplayAnalysisOutput = z.infer<typeof ReplayAnalysisOutputSchema>;

/** Validates shape, drops questions that break a guardrail. null = unusable, use the fallback. */
export function sanitizeChallenge(raw: unknown): ChallengeOutput | null {
  const parsed = ChallengeOutputSchema.safeParse(raw);
  if (!parsed.success) return null;

  const questions = parsed.data.socraticQuestions
    .filter((q) => findViolations(`${q.focusArea} ${q.question} ${q.suggestedAction}`).length === 0)
    .slice(0, MAX_QUESTIONS);
  if (questions.length === 0) return null;

  const biases = Array.from(
    new Set(
      parsed.data.detectedBiases
        .map((b) => b.toUpperCase().replace(/[\s-]+/g, "_"))
        .filter((b) => /^[A-Z_]+$/.test(b)),
    ),
  );
  return { socraticQuestions: questions, detectedBiases: biases };
}

/** Validates shape. Any guardrail violation rejects the whole analysis. */
export function sanitizeReplayAnalysis(raw: unknown): ReplayAnalysisOutput | null {
  const parsed = ReplayAnalysisOutputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const all = Object.values(parsed.data).join(" ");
  return findViolations(all).length === 0 ? parsed.data : null;
}
