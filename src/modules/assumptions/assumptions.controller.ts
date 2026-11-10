// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay & DNA) & Member A
// FEATURE: Assumptions HTTP Controller
//
// PATCH /api/v1/assumptions/:id/validate
// Body: { metricActual?: string, validated?: boolean }  (at least one is required;
// the service returns 422 if both are missing)
// ==============================================================================

import { Router, Request, Response, NextFunction } from "express";
import { assumptionsService } from "./assumptions.service";
import { z } from "zod";
import { validateBody } from "../../common/guards/validation.guard";

export const assumptionsRouter = Router();

const ValidateAssumptionSchema = z.object({
  metricActual: z.string().optional(),
  validated: z.boolean().optional(), // omitted => compared automatically with metricTarget
});

// PATCH /api/v1/assumptions/:id/validate
assumptionsRouter.patch(
  "/:id/validate",
  validateBody(ValidateAssumptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await assumptionsService.validateAssumption(req.params.id, req.body);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);
