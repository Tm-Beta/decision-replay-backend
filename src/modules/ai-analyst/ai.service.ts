// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: AI Analyst Service & Socratic Challenger Orchestration
//
// TODO: [Member C]
// 1. Support live LLM inference when AI_API_KEY is configured.
// 2. Provide deterministic, high-quality heuristic fallback when operating in offline/demo mode.
// 3. Strictly validate AI response format and filter against guardrail violations.
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

export interface SocraticChallengeRequest {
  title: string;
  choice: string;
  decisionReason?: string;
  expectedOutcome: string;
  confidence: number;
  assumptions: Array<{ statement: string }>;
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

export class AiAnalystService {
  /**
   * Generates real-time Socratic challenger questions before a decision is locked.
   */
  public async generatePreDecisionChallenge(req: SocraticChallengeRequest) {
    if (!isLiveAiEnabled()) {
      return this.generateDeterministicChallenge(req);
    }

    try {
      const userPrompt = buildPreDecisionUserPrompt(req);
      const response = await fetch(`${aiConfig.gatewayUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aiConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: aiConfig.model,
          temperature: aiConfig.temperature,
          messages: [
            { role: "system", content: PRE_DECISION_CHALLENGER_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`AI gateway responded with status: ${response.status}`);
      }

      const json = await response.json();
      const content = json.choices?.[0]?.message?.content;
      return JSON.parse(content);
    } catch (err) {
      console.warn("[AI Analyst] Live provider call failed. Falling back to deterministic analysis:", err);
      return this.generateDeterministicChallenge(req);
    }
  }

  /**
   * Analyzes variance between initial snapshot expectation and actual outcome.
   */
  public async generatePostReplayAnalysis(req: PostReplayAnalysisRequest) {
    if (!isLiveAiEnabled()) {
      return this.generateDeterministicReplayAnalysis(req);
    }

    try {
      const userPrompt = buildPostReplayUserPrompt(req);
      const response = await fetch(`${aiConfig.gatewayUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aiConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: aiConfig.model,
          temperature: aiConfig.temperature,
          messages: [
            { role: "system", content: POST_REPLAY_ANALYST_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      const json = await response.json();
      const content = json.choices?.[0]?.message?.content;
      return JSON.parse(content);
    } catch (err) {
      console.warn("[AI Analyst] Live post-replay call failed. Falling back to deterministic analysis:", err);
      return this.generateDeterministicReplayAnalysis(req);
    }
  }

  /**
   * Deterministic Socratic rules for offline local demoing.
   */
  private generateDeterministicChallenge(req: SocraticChallengeRequest) {
    const questions = [];
    const biases: string[] = [];

    if (req.assumptions.length === 0) {
      questions.push({
        focusArea: "Assumption Rigor",
        question: "You have not registered any testable assumptions. What must remain true in the real world for this choice to succeed?",
        suggestedAction: "Add at least 2 quantitative assumptions with measurable verification metrics.",
      });
      biases.push("UNEXAMINED_ASSUMPTIONS");
    }

    if (req.preMortems.length === 0) {
      questions.push({
        focusArea: "Pre-Mortem Blindspot",
        question: "Imagine you are reviewing this decision 6 months from now and it failed completely. What single vector was most responsible?",
        suggestedAction: "Record a pre-mortem failure mode to test risk foresight.",
      });
      biases.push("OPTIMISM_BIAS");
    }

    if (req.confidence > 80 && req.alternatives.length < 2) {
      questions.push({
        focusArea: "Alternative Exploration",
        question: `You expressed high confidence (${req.confidence}%) having weighed only ${req.alternatives.length} alternatives. Is this true conviction or lack of competitive evaluation?`,
        suggestedAction: "List at least one radical counter-alternative and its trade-offs before locking.",
      });
      biases.push("CONFIRMATION_BIAS");
    }

    if (questions.length === 0) {
      questions.push({
        focusArea: "Confidence Calibration",
        question: `You are locking this with ${req.confidence}% confidence. What is the fastest intermediate signal that would falsify your thesis?`,
        suggestedAction: "Set an intermediate review milestone on your timeline within 14 days.",
      });
    }

    return {
      socraticQuestions: questions,
      detectedBiases: biases,
    };
  }

  /**
   * Deterministic post-replay fallback rules.
   */
  private generateDeterministicReplayAnalysis(req: PostReplayAnalysisRequest) {
    const failedAssumptions = req.assumptions.filter((a) => a.validated === false);

    return {
      varianceExplanation: failedAssumptions.length > 0
        ? `The outcome diverged from expectations primarily because assumption "${failedAssumptions[0].statement}" was falsified in production.`
        : "The outcome followed the predicted path closely, validating the core reasoning model.",
      reasoningPatternIdentified: failedAssumptions.length > 0 ? "Falsified Hypothesis" : "Accurate Calibration",
      socraticTakeaway: "Incorporate intermediate telemetry checks into future pre-mortems to catch metric drift earlier.",
      repeatabilityAssessment: req.outcomeScore >= 70
        ? "Yes — reasoning model is robust and repeatable."
        : "Course correction recommended: recalculate underlying assumptions before repeating.",
    };
  }
}

export const aiAnalystService = new AiAnalystService();
