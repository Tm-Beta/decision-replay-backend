// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Zod Schema Validation Middleware
//
// TODO: [Member A]
// 1. Validate request body, query params, and route parameters using Zod schemas.
// 2. Return clean RFC 7807 validation error payloads when schema check fails.
// ==============================================================================

import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message: "Request validation failed",
          errors: error.errors.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        });
        return;
      }
      next(error);
    }
  };
}
