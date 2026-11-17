// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI Analyst)
// FEATURE: AI Configuration & LLM Provider Settings
//
// - Works with any OpenAI-compatible gateway (OpenAI, OpenRouter, LiteLLM, local servers).
// - Values are read when used (not at import time), so dotenv load order cannot break it.
// - Without AI_API_KEY the analyst runs in deterministic mock mode.
// - Temperature is capped at 0.4 for analytical rigor.
// ==============================================================================

export interface AiConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly gatewayUrl: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly isMockMode: boolean;
}

const MAX_TEMPERATURE = 0.4;
const MAX_TOKENS_CAP = 2000;

function readNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const aiConfig: AiConfig = {
  get apiKey() {
    return (process.env.AI_API_KEY ?? "").trim();
  },
  get gatewayUrl() {
    return (process.env.AI_GATEWAY_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  },
  get model() {
    const model = process.env.AI_MODEL || "openai/gpt-4o";
    // "openai/gpt-4o" is the OpenRouter naming. The OpenAI API itself expects "gpt-4o".
    return this.gatewayUrl.includes("api.openai.com") && model.startsWith("openai/")
      ? model.slice("openai/".length)
      : model;
  },
  get temperature() {
    return Math.min(MAX_TEMPERATURE, Math.max(0, readNumber(process.env.AI_TEMPERATURE, 0.3)));
  },
  get maxTokens() {
    return Math.min(MAX_TOKENS_CAP, Math.max(100, Math.round(readNumber(process.env.AI_MAX_TOKENS, 1200))));
  },
  get timeoutMs() {
    return Math.max(1000, readNumber(process.env.AI_TIMEOUT_MS, 8000));
  },
  get isMockMode() {
    return this.apiKey === "";
  },
};

export function isLiveAiEnabled(): boolean {
  return !aiConfig.isMockMode;
}
