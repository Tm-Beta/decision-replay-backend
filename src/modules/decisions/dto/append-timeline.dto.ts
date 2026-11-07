// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Append Timeline Event DTO & Validation
//
// TODO: [Member A]
// 1. Validate append-only event type: EVIDENCE_NOTE, CONTEXT_SHIFT, BLOCKER_LOG.
// 2. Disallow edits or deletions of previous timeline events.
// ==============================================================================

import { z } from "zod";

export const AppendTimelineSchema = z.object({
  eventType: z.enum(["EVIDENCE_NOTE", "CONTEXT_SHIFT", "BLOCKER_LOG", "ASSUMPTION_UPDATE"]).default("EVIDENCE_NOTE"),
  title: z.string().min(2, "Event title must be at least 2 characters"),
  detail: z.string().min(3, "Event detail note must be at least 3 characters"),
  metadataJson: z.string().optional(),
});

export type AppendTimelineDto = z.infer<typeof AppendTimelineSchema>;
