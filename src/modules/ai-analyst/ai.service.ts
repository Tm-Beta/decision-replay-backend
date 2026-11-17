// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: AI Analyst Service & Socratic Challenger Orchestration
//
// 1. Live LLM inference when AI_API_KEY is configured (OpenAI-compatible gateway).
// 2. Every live answer is validated and guardrail-filtered (guardrails.ts).
//    Invalid, unsafe, slow or failed answers fall back to the deterministic analyzer.
// 3. Without a key the deterministic analyzer is used directly (offline demo mode).
//
// Responses keep the original shape and add `mode`: "LIVE_LLM" or "LOCAL_MOCK".
// ==============================================================================

import { aiConfig, isLiveAiEnabled } from "../../config/ai.config";
import {
  PRE_DECISION_CHALLENGER_SYSTEM_PROMPT,
  buildPreDecisionUserPrompt,
} from "./prompts/pre-decision-challenger.prompt";
import {
  POST_REPLAY_ANALYST_SYSTEM_PROMPT,
  buildPostReplayUserPrompt,
} from "./prompts/post-replay-analyst.prompt";
import {
  MAX_QUESTIONS,
  parseLooseJson,
  sanitizeChallenge,
  sanitizeReplayAnalysis,
} from "./guardrails";

export type AiMode = "LIVE_LLM" | "LOCAL_MOCK";

export interface SocraticChallengeRequest {
  title: string;
  choice: string;
  decisionReason?: string;
  expectedOutcome: string;
  confidence: number;
  assumptions: Array<{ statement: string; metricTarget?: string }>;
  alternatives: Array<{ title: string }>;
  preMortems: Array<{ failureScenario: string }>;
}

export interface PostReplayAnalysisRequest {
  decisionId: string;
  expectedOutcome: string;
  actualOutcome: string;
  confidence: number;
  outcomeScore: number;
  assumptions: Array<{ statement: string; validated?: boolean | null }>;
}

export interface SocraticQuestion {
  focusArea: string;
  question: string;
  suggestedAction: string;
}

export interface ChallengeResult {
  socraticQuestions: SocraticQuestion[];
  detectedBiases: string[];
  mode: AiMode;
}

export interface ReplayAnalysisResult {
  varianceExplanation: string;
  reasoningPatternIdentified: string;
  socraticTakeaway: string;
  repeatabilityAssessment: string;
  mode: AiMode;
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

// ---------------------------------------------------------------------------
// Deterministic analyzers (offline mode and fallback). Pure functions.
// All wording follows the guardrails: questions, evidence-based, no advice on the choice.
// ---------------------------------------------------------------------------

const TIME_WORDS = /\b(days?|weeks?|months?|quarters?|sprints?|deadlines?|timelines?|ship|launch|deliver)\b/i;

export function buildDeterministicChallenge(
  req: SocraticChallengeRequest,
): Omit<ChallengeResult, "mode"> {
  const candidates: { q: SocraticQuestion; bias?: string }[] = [];
  const assumptions = req.assumptions.filter((a) => a.statement.trim());
  const alternativeCount = req.alternatives.filter((a) => a.title.trim()).length;

  if (assumptions.length === 0) {
    candidates.push({
      q: {
        focusArea: "Assumption Rigor",
        question:
          "You have not registered any testable assumptions. What must remain true in the real world for this choice to succeed?",
        suggestedAction: "Add at least 2 assumptions with a measurable target, such as a number and a unit.",
      },
      bias: "UNEXAMINED_ASSUMPTIONS",
    });
  } else {
    const vague = assumptions.filter((a) => !a.metricTarget?.trim() && !/\d/.test(a.statement));
    if (vague.length > 0) {
      candidates.push({
        q: {
          focusArea: "Assumption Rigor",
          question: `How would you measure "${truncate(vague[0].statement.trim(), 80)}" so that reality could prove it wrong?`,
          suggestedAction:
            'Attach a number and a unit (for example "< 2 weeks" or "$500") so the replay can check it automatically.',
        },
        bias: "UNEXAMINED_ASSUMPTIONS",
      });
    }
  }

  if (TIME_WORDS.test(`${req.expectedOutcome} ${assumptions.map((a) => a.statement).join(" ")}`)) {
    candidates.push({
      q: {
        focusArea: "Assumption Rigor",
        question:
          "This plan depends on a schedule. How long did comparable work actually take in the past, and what is your estimate based on?",
        suggestedAction: "Write down the real durations of 2 or 3 similar past efforts next to this estimate.",
      },
      bias: "PLANNING_FALLACY",
    });
  }

  if (req.preMortems.length === 0) {
    candidates.push({
      q: {
        focusArea: "Pre-Mortem Blindspot",
        question:
          "Imagine you are reviewing this decision 6 months from now and it failed completely. What single vector was most responsible?",
        suggestedAction: "Record a pre-mortem failure mode so the replay can test your risk foresight.",
      },
      bias: "OPTIMISM_BIAS",
    });
  }

  if (req.confidence > 80 && alternativeCount < 2) {
    candidates.push({
      q: {
        focusArea: "Alternative Exploration",
        question: `You expressed high confidence (${req.confidence}%) having weighed only ${alternativeCount} alternatives. Is this conviction based on a comparison, or on the absence of one?`,
        suggestedAction: "List at least one counter-alternative and its trade-offs before locking.",
      },
      bias: "CONFIRMATION_BIAS",
    });
  } else if (alternativeCount === 0) {
    candidates.push({
      q: {
        focusArea: "Alternative Exploration",
        question: "No alternatives were recorded. What would you do if this option were not available?",
        suggestedAction: "List at least one alternative with its pros and cons.",
      },
    });
  }

  if (!req.decisionReason?.trim() && alternativeCount > 0) {
    candidates.push({
      q: {
        focusArea: "Alternative Exploration",
        question: "What criteria matter most to your outcome, and how do your alternatives compare on them?",
        suggestedAction: "Write the two or three criteria that decide this choice before locking.",
      },
    });
  }

  if (req.confidence >= 90) {
    candidates.push({
      q: {
        focusArea: "Confidence Calibration",
        question: `At ${req.confidence}% confidence you expect to be wrong about 1 time in ${Math.max(2, Math.round(100 / (100 - req.confidence)))} for similar decisions. Which past decision supports that track record?`,
        suggestedAction: "Look up the outcomes of 2 or 3 comparable past decisions and compare them with this confidence.",
      },
      bias: "OVERCONFIDENCE",
    });
  }

  const kept = candidates.slice(0, MAX_QUESTIONS);

  if (kept.length === 0) {
    kept.push({
      q: {
        focusArea: "Confidence Calibration",
        question: `You are locking this with ${req.confidence}% confidence. What is the fastest intermediate signal that would falsify your thesis?`,
        suggestedAction: "Set an intermediate review milestone on your timeline within 14 days.",
      },
    });
  }

  return {
    socraticQuestions: kept.map((c) => c.q),
    detectedBiases: Array.from(new Set(kept.flatMap((c) => (c.bias ? [c.bias] : [])))),
  };
}

export function buildDeterministicReplayAnalysis(
  req: PostReplayAnalysisRequest,
): Omit<ReplayAnalysisResult, "mode"> {
  const total = req.assumptions.length;
  const failed = req.assumptions.filter((a) => a.validated === false);
  const unknown = req.assumptions.filter((a) => a.validated === null || a.validated === undefined).length;
  const gap = req.outcomeScore - req.confidence; // negative = outcome below stated confidence

  let variance: string;
  if (total === 0) {
    variance = "No assumptions were recorded, so the gap cannot be traced to a specific hypothesis.";
  } else if (failed.length > 0) {
    variance = `${failed.length} of ${total} assumptions were not validated, including "${truncate(failed[0].statement, 100)}". This is one candidate explanation for the gap between the expected and the actual outcome; factors that were never listed may also have contributed.`;
  } else if (unknown === total) {
    variance = "No assumption results were recorded, so the gap cannot be traced to a specific hypothesis.";
  } else if (req.outcomeScore >= 70) {
    variance = "The outcome stayed close to the expectation, and none of the recorded assumptions was falsified.";
  } else {
    variance =
      "The outcome fell short of the expectation although no recorded assumption was falsified, which points to a factor that was not listed as an assumption.";
  }
  variance += ` Stated confidence was ${req.confidence}% and the outcome scored ${req.outcomeScore}/100.`;

  let pattern = "Accurate Calibration";
  if (failed.length > 0) pattern = "Falsified Hypothesis";
  else if (gap <= -15) pattern = "Overconfidence";
  else if (gap >= 15) pattern = "Underconfidence";

  let takeaway: string;
  if (failed.length > 0) {
    takeaway =
      "Consider adding an intermediate check for the assumption that failed, so that metric drift shows up earlier.";
  } else if (gap <= -15) {
    takeaway = "Compare your stated confidence with the outcomes of similar past decisions before locking the next one.";
  } else {
    takeaway = "Note which assumptions mattered most here, so they can serve as a checklist for similar decisions.";
  }

  const repeatability =
    req.outcomeScore >= 70 && failed.length === 0
      ? "With the same information the reasoning looks repeatable, although a single outcome is only weak evidence."
      : "This result gives limited support for repeating the choice unchanged; the failed or unmeasured assumptions would be worth re-examining first.";

  return {
    varianceExplanation: variance,
    reasoningPatternIdentified: pattern,
    socraticTakeaway: takeaway,
    repeatabilityAssessment: repeatability,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AiAnalystService {
  /**
   * Generates real-time Socratic challenger questions before a decision is locked.
   */
  public async generatePreDecisionChallenge(req: SocraticChallengeRequest): Promise<ChallengeResult> {
    if (isLiveAiEnabled()) {
      try {
        const content = await this.callLlm(PRE_DECISION_CHALLENGER_SYSTEM_PROMPT, buildPreDecisionUserPrompt(req));
        const safe = sanitizeChallenge(parseLooseJson(content));
        if (safe) return { ...safe, mode: "LIVE_LLM" };
        console.warn("[AI Analyst] Live answer rejected (bad format or guardrail violation). Using deterministic analysis.");
      } catch (err) {
        console.warn("[AI Analyst] Live provider call failed. Using deterministic analysis:", err instanceof Error ? err.message : err);
      }
    }
    return { ...buildDeterministicChallenge(req), mode: "LOCAL_MOCK" };
  }

  /**
   * Analyzes variance between initial snapshot expectation and actual outcome.
   */
  public async generatePostReplayAnalysis(req: PostReplayAnalysisRequest): Promise<ReplayAnalysisResult> {
    if (isLiveAiEnabled()) {
      try {
        const content = await this.callLlm(POST_REPLAY_ANALYST_SYSTEM_PROMPT, buildPostReplayUserPrompt(req));
        const safe = sanitizeReplayAnalysis(parseLooseJson(content));
        if (safe) return { ...safe, mode: "LIVE_LLM" };
        console.warn("[AI Analyst] Live answer rejected (bad format or guardrail violation). Using deterministic analysis.");
      } catch (err) {
        console.warn("[AI Analyst] Live post-replay call failed. Using deterministic analysis:", err instanceof Error ? err.message : err);
      }
    }
    return { ...buildDeterministicReplayAnalysis(req), mode: "LOCAL_MOCK" };
  }

  /** One chat-completion call with a timeout. Returns the raw text of the first choice. */
  private async callLlm(systemPrompt: string, userPrompt: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), aiConfig.timeoutMs);
    try {
      const response = await fetch(`${aiConfig.gatewayUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aiConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: aiConfig.model,
          temperature: aiConfig.temperature,
          max_tokens: aiConfig.maxTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`AI gateway responded with status: ${response.status}`);
      }
      const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      return json.choices?.[0]?.message?.content ?? null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const aiAnalystService = new AiAnalystService();
