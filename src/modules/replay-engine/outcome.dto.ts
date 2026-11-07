// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: Outcome & Replay Data Transfer Objects
//
// TODO: [Member C]
// 1. Validate actual outcome statement, 0-100 score, reflection, wouldRepeat flag.
// 2. Validate assumption evaluations array matching `decision-replay-docs/api-contracts/replay-engine-api.md`.
// ==============================================================================

import { z } from "zod";

export const AssumptionEvaluationSchema = z.object({
  assumptionId: z.string(),
  metricActual: z.string().optional(),
  validated: z.boolean(),
});

export const RecordOutcomeSchema = z.object({
  actualOutcome: z.string().min(5, "Actual outcome description must be at least 5 characters"),
  outcomeScore: z.number().int().min(0).max(100).default(50),
  reflection: z.string().min(5, "Reflection notes must be provided"),
  wouldRepeat: z.boolean().default(true),
  unexpectedFactors: z.string().default(""),
  assumptionEvaluations: z.array(AssumptionEvaluationSchema).default([]),
});

export type RecordOutcomeDto = z.infer<typeof RecordOutcomeSchema>;
