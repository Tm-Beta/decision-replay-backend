// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI Analyst)
// FEATURE: AI Configuration & LLM Provider Settings
//
// TODO: [Member C]
// 1. Support OpenAI / Anthropic / Local models via standard gateway interface.
// 2. Fall back gracefully to heuristic/mock analyzer when AI_API_KEY is omitted.
// 3. Enforce maximum completion tokens and temperature constraints (temperature <= 0.4 for analytical rigor).
// ==============================================================================

export interface AiConfig {
  apiKey: string;
  model: string;
  gatewayUrl: string;
  temperature: number;
  maxTokens: number;
  isMockMode: boolean;
}

export const aiConfig: AiConfig = {
  apiKey: process.env.AI_API_KEY || "",
  model: process.env.AI_MODEL || "openai/gpt-4o",
  gatewayUrl: process.env.AI_GATEWAY_URL || "https://api.openai.com/v1",
  temperature: 0.3, // Low temperature for objective Socratic challenges
  maxTokens: 1200,
  isMockMode: !process.env.AI_API_KEY || process.env.AI_API_KEY.trim() === "",
};

export function isLiveAiEnabled(): boolean {
  return !aiConfig.isMockMode;
}
