// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay, DNA & AI)
// FEATURE: Outcome & Replay Data Transfer Objects
//
// Changes vs. the first draft (all backward compatible):
// - assumptionEvaluations[].validated is now OPTIONAL. If omitted, the service
//   compares metricTarget with metricActual automatically.
// - NEW optional preMortemEvaluations: which pre-mortem failures really happened.
// ==============================================================================

import { z } from "zod";

export const AssumptionEvaluationSchema = z
  .object({
    assumptionId: z.string(),
    metricActual: z.string().optional(),
    validated: z.boolean().optional(),
  })
  .refine((e) => e.validated !== undefined || !!e.metricActual, {
    message: "Provide `validated`, or `metricActual` so it can be compared with the target",
  });

export const PreMortemEvaluationSchema = z.object({
  preMortemId: z.string(),
  occurredInReality: z.boolean(),
});

export const RecordOutcomeSchema = z.object({
  actualOutcome: z.string().min(5, "Actual outcome description must be at least 5 characters"),
  outcomeScore: z.number().int().min(0).max(100).default(50),
  reflection: z.string().min(5, "Reflection notes must be provided"),
  wouldRepeat: z.boolean().default(true),
  unexpectedFactors: z.string().default(""),
  assumptionEvaluations: z.array(AssumptionEvaluationSchema).default([]),
  preMortemEvaluations: z.array(PreMortemEvaluationSchema).default([]),
});

export type RecordOutcomeDto = z.infer<typeof RecordOutcomeSchema>;
