// ==============================================================================
// RESPONSIBLE MEMBER: Member C (Backend Lead - Replay & DNA) & Member A
// FEATURE: Assumptions HTTP Controller
//
// TODO: [Member C]
// 1. Expose PATCH /api/v1/assumptions/:id/validate to update hypothesis outcome.
// ==============================================================================

import { Router, Request, Response, NextFunction } from "express";
import { assumptionsService } from "./assumptions.service";
import { z } from "zod";
import { validateBody } from "../../common/guards/validation.guard";

export const assumptionsRouter = Router();

const ValidateAssumptionSchema = z.object({
  metricActual: z.string().optional(),
  validated: z.boolean(),
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
