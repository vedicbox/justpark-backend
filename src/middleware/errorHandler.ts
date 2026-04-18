import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { logger } from '../utils/logger';
import { ApiErrorResponse, ErrorCode } from '../types';

// ─────────────────────────────────────────────
// Custom Application Error
// ─────────────────────────────────────────────
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  public readonly isOperational: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    isOperational = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(code: string, message: string, details?: Record<string, unknown>) {
    return new AppError(400, code, message, details);
  }

  static unauthorized(message = 'Authentication required') {
    return new AppError(401, ErrorCode.UNAUTHORIZED, message);
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new AppError(403, ErrorCode.FORBIDDEN, message);
  }

  static notFound(resource = 'Resource') {
    return new AppError(404, ErrorCode.NOT_FOUND, `${resource} not found`);
  }

  static conflict(code: string, message: string) {
    return new AppError(409, code, message);
  }

  static unprocessable(code: string, message: string, details?: Record<string, unknown>) {
    return new AppError(422, code, message, details);
  }

  static internal(message = 'An unexpected error occurred') {
    return new AppError(500, ErrorCode.INTERNAL_ERROR, message, undefined, false);
  }
}

// ─────────────────────────────────────────────
// Centralized Error Handler Middleware
// Must be registered LAST in Express middleware chain
// ─────────────────────────────────────────────
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  // 1. AppError — operational errors (expected, user-facing)
  if (err instanceof AppError) {
    const body: ApiErrorResponse = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      },
    };

    if (err.statusCode >= 500) {
      logger.error({ err, req: { method: req.method, url: req.url } }, err.message);
    } else {
      logger.warn({ code: err.code, url: req.url }, err.message);
    }

    res.status(err.statusCode).json(body);
    return;
  }

  // 2. Multer errors — file size exceeded or unsupported file type
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'File too large. Maximum size is 5MB.'
      : `File upload error: ${err.field ?? 'unknown field'}`;
    res.status(400).json({
      success: false,
      error: { code: ErrorCode.VALIDATION_ERROR, message },
    } satisfies ApiErrorResponse);
    return;
  }

  // 3. Zod validation errors
  if (err instanceof ZodError) {
    const details: Record<string, string[]> = {};
    err.issues.forEach((issue) => {
      const path = issue.path.join('.');
      if (!details[path]) details[path] = [];
      details[path].push(issue.message);
    });

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

  // 4. Prisma errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const body = handlePrismaError(err);
    res.status(body.status).json(body.response);
    return;
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    const body: ApiErrorResponse = {
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid data provided',
      },
    };
    res.status(400).json(body);
    return;
  }

  // 5. Unknown / programming errors — do NOT leak details in production
  logger.error(
    { err, stack: err.stack, url: req.url, method: req.method },
    'Unhandled error'
  );

  const body: ApiErrorResponse = {
    success: false,
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message:
        process.env.NODE_ENV === 'production'
          ? 'An unexpected error occurred'
          : err.message,
    },
  };

  res.status(500).json(body);
}

// ─────────────────────────────────────────────
// Prisma Error Mapper
// ─────────────────────────────────────────────
function handlePrismaError(err: Prisma.PrismaClientKnownRequestError): {
  status: number;
  response: ApiErrorResponse;
} {
  switch (err.code) {
    case 'P2002': {
      // Unique constraint violation
      const fields = (err.meta?.target as string[]) ?? [];
      return {
        status: 409,
        response: {
          success: false,
          error: {
            code: ErrorCode.ALREADY_EXISTS,
            message: `A record with this ${fields.join(', ')} already exists`,
            details: { fields },
          },
        },
      };
    }
    case 'P2025':
      // Record not found
      return {
        status: 404,
        response: {
          success: false,
          error: { code: ErrorCode.NOT_FOUND, message: 'Record not found' },
        },
      };
    case 'P2003':
      // Foreign key constraint violation
      return {
        status: 400,
        response: {
          success: false,
          error: {
            code: ErrorCode.VALIDATION_ERROR,
            message: 'Referenced record does not exist',
          },
        },
      };
    default:
      logger.error({ prismaCode: err.code, err }, 'Unhandled Prisma error');
      return {
        status: 500,
        response: {
          success: false,
          error: { code: ErrorCode.INTERNAL_ERROR, message: 'Database error' },
        },
      };
  }
}

// ─────────────────────────────────────────────
// 404 Not Found handler (for unmatched routes)
// ─────────────────────────────────────────────
export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiErrorResponse = {
    success: false,
    error: {
      code: ErrorCode.NOT_FOUND,
      message: `Route ${req.method} ${req.path} not found`,
    },
  };
  res.status(404).json(body);
}
