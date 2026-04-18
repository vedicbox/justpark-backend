import { Response } from 'express';
import { ApiSuccessResponse, ApiErrorResponse, PaginationMeta, ErrorCodeType } from '../types';

// ─────────────────────────────────────────────
// Success Response Builder
// ─────────────────────────────────────────────
export function successResponse<T>(
  res: Response,
  data: T,
  message?: string,
  statusCode = 200,
  meta?: PaginationMeta
): Response {
  const body: ApiSuccessResponse<T> = {
    success: true,
    data,
    ...(message && { message }),
    ...(meta && { meta }),
  };
  return res.status(statusCode).json(body);
}

// ─────────────────────────────────────────────
// Error Response Builder
// ─────────────────────────────────────────────
export function errorResponse(
  res: Response,
  statusCode: number,
  code: ErrorCodeType | string,
  message: string,
  details?: Record<string, unknown>
): Response {
  const body: ApiErrorResponse = {
    success: false,
    error: {
      code,
      message,
      ...(details && { details }),
    },
  };
  return res.status(statusCode).json(body);
}

// ─────────────────────────────────────────────
// Common shorthand helpers
// ─────────────────────────────────────────────
export const Respond = {
  ok: <T>(res: Response, data: T, message?: string, meta?: PaginationMeta) =>
    successResponse(res, data, message, 200, meta),

  created: <T>(res: Response, data: T, message?: string) =>
    successResponse(res, data, message, 201),

  noContent: (res: Response) => res.status(204).send(),

  badRequest: (res: Response, code: string, message: string, details?: Record<string, unknown>) =>
    errorResponse(res, 400, code, message, details),

  unauthorized: (res: Response, message = 'Authentication required') =>
    errorResponse(res, 401, 'UNAUTHORIZED', message),

  forbidden: (res: Response, message = 'You do not have permission to perform this action') =>
    errorResponse(res, 403, 'FORBIDDEN', message),

  notFound: (res: Response, resource = 'Resource') =>
    errorResponse(res, 404, 'NOT_FOUND', `${resource} not found`),

  conflict: (res: Response, code: string, message: string) =>
    errorResponse(res, 409, code, message),

  unprocessable: (res: Response, code: string, message: string, details?: Record<string, unknown>) =>
    errorResponse(res, 422, code, message, details),

  tooManyRequests: (res: Response) =>
    errorResponse(res, 429, 'RATE_LIMIT_EXCEEDED', 'Too many requests. Please try again later.'),

  internalError: (res: Response, message = 'An unexpected error occurred') =>
    errorResponse(res, 500, 'INTERNAL_ERROR', message),
};
