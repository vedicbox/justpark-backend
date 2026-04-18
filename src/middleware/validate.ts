import { Request, Response, NextFunction } from 'express';
import { ZodType, ZodTypeDef, ZodError } from 'zod';
import { ApiErrorResponse, ErrorCode } from '../types';

type ValidationTarget = 'body' | 'query' | 'params';

/**
 * Generic Zod validation middleware factory.
 *
 * Usage:
 *   router.post('/register', validate(RegisterSchema), controller.register)
 *   router.get('/search',    validate(SearchSchema, 'query'), controller.search)
 *
 * On success:  the parsed + coerced data is written back to req[target],
 *              so downstream handlers receive typed, transformed values.
 * On failure:  returns 400 with per-field error details.
 */
// Accept schemas with any input type (covers ZodEffects from .transform())
export function validate<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  target: ValidationTarget = 'body'
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      const details = formatZodErrors(result.error);
      const body: ApiErrorResponse = {
        success: false,
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Validation failed',
          details,
        },
      };
      res.status(400).json(body);
      return;
    }

    // Write the coerced/transformed data back so the controller gets clean types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any)[target] = result.data;
    next();
  };
}

// ─────────────────────────────────────────────
// Validate multiple targets at once
// ─────────────────────────────────────────────
export function validateAll(schemas: {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const targets: ValidationTarget[] = ['body', 'query', 'params'];
    const allDetails: Record<string, string[]> = {};

    for (const target of targets) {
      const schema = schemas[target];
      if (!schema) continue;

      const result = schema.safeParse(req[target]);
      if (!result.success) {
        Object.assign(allDetails, formatZodErrors(result.error));
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any)[target] = result.data;
      }
    }

    if (Object.keys(allDetails).length > 0) {
      const body: ApiErrorResponse = {
        success: false,
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Validation failed',
          details: allDetails,
        },
      };
      res.status(400).json(body);
      return;
    }

    next();
  };
}

// ─────────────────────────────────────────────
// Helper: flatten Zod issues into { field: [messages] }
// ─────────────────────────────────────────────
function formatZodErrors(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  error.issues.forEach((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_root';
    if (!details[path]) details[path] = [];
    details[path].push(issue.message);
  });
  return details;
}
