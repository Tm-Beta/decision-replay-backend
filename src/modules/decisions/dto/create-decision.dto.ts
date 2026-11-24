// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Decision Creation Data Transfer Object & Zod Validation
//
// TODO: [Member A]
// 1. Validate required fields: title, choice, expectedOutcome, confidence, reviewDate.
// 2. Validate assumptions, alternatives, and preMortems nested arrays.
// ==============================================================================

import { z } from "zod";

export const CreateAssumptionSchema = z.object({
  statement: z.string().min(3, "Assumption statement must be at least 3 characters"),
  metricTarget: z.string().optional(),
  confidence: z.number().int().min(1).max(100).default(50),
});

export const CreateAlternativeSchema = z.object({
  title: z.string().min(2, "Alternative title must be at least 2 characters"),
  pros: z.string().default(""),
  cons: z.string().default(""),
});

export const CreatePreMortemSchema = z.object({
  failureScenario: z.string().min(5, "Failure scenario must be at least 5 characters"),
  preventiveAction: z.string().default(""),
  severityScore: z.number().int().min(1).max(100).default(50),
});

export const CreateDecisionSchema = z.object({
  decidedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  outcomeKnown: z.boolean().optional(),
  influences: z.array(z.string()).default([]),
  projectId: z.string().min(1).optional(),
  parentId: z.string().optional(),
  planId: z.string().optional(),
  title: z.string().trim().min(1),
  category: z.string().default("GENERAL"),
  choice: z.string().trim().min(1),
  context: z.string().default(""),
  decisionReason: z.string().default(""),
  beliefRationale: z.string().default(""),
  expectedOutcome: z.string().default(""),
  confidence: z.number().int().min(1).max(100).nullable().optional(),
  reviewDate: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
  assumptions: z.array(CreateAssumptionSchema).default([]),
  alternatives: z.array(CreateAlternativeSchema).default([]),
  preMortems: z.array(CreatePreMortemSchema).default([]),
});

export type CreateDecisionDto = z.infer<typeof CreateDecisionSchema>;
