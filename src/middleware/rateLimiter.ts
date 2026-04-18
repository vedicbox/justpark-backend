import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import RedisStore, { type RedisReply } from 'rate-limit-redis';
import { redis } from '../config/redis';
import { env } from '../config/env';
import { ApiErrorResponse, ErrorCode } from '../types';

// ─────────────────────────────────────────────
// Shared Redis store factory
// ─────────────────────────────────────────────
function createRedisStore(prefix: string) {
  return new RedisStore({
    sendCommand: async (...args: string[]) => {
      // ioredis uses .call() for raw commands
      return redis.call(args[0], ...args.slice(1)) as unknown as RedisReply;
    },
    prefix: `rl:${prefix}:`,
  });
}

// ─────────────────────────────────────────────
// Shared error response for rate limit hits
// ─────────────────────────────────────────────
function rateLimitHandler(
  _req: import('express').Request,
  res: import('express').Response
): void {
  const body: ApiErrorResponse = {
    success: false,
    error: {
      code: ErrorCode.RATE_LIMIT_EXCEEDED,
      message: 'Too many requests. Please slow down and try again later.',
    },
  };
  res.status(429).json(body);
}

// ─────────────────────────────────────────────
// General API rate limiter: 100 req/min per IP
// ─────────────────────────────────────────────
export const apiRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: true,
  store: createRedisStore('api'),
  keyGenerator: (req) => {
    // Rate limit by user ID if authenticated, fallback to IP
    return (req as { user?: { sub?: string } }).user?.sub ?? req.ip ?? 'unknown';
  },
  handler: rateLimitHandler,
  skip: (req) => {
    // Skip health check endpoint
    return req.path === '/health';
  },
});

// ─────────────────────────────────────────────
// Auth endpoint rate limiter: 5 req/min per IP
// Stricter — protects against brute-force attacks
// ─────────────────────────────────────────────
export const authRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS, // 1 minute
  max: env.RATE_LIMIT_AUTH_MAX,        // 5 requests
  standardHeaders: true,
  legacyHeaders: true,
  store: createRedisStore('auth'),
  keyGenerator: (req) => req.ip ?? 'unknown',
  handler: rateLimitHandler,
  skipSuccessfulRequests: false,
});

// ─────────────────────────────────────────────
// OTP rate limiter: 3 sends per 10 minutes per user/IP
// ─────────────────────────────────────────────
export const otpRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 3,
  standardHeaders: true,
  legacyHeaders: true,
  store: createRedisStore('otp'),
  keyGenerator: (req) => req.ip ?? 'unknown',
  handler: rateLimitHandler,
});

// ─────────────────────────────────────────────
// Payment endpoint rate limiter: 10 req/min per user
// ─────────────────────────────────────────────
export const paymentRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: true,
  store: createRedisStore('payment'),
  keyGenerator: (req) => {
    return (req as { user?: { sub?: string } }).user?.sub ?? req.ip ?? 'unknown';
  },
  handler: rateLimitHandler,
});

// ─────────────────────────────────────────────
// File upload rate limiter: 20 req/min per user
// ─────────────────────────────────────────────
export const uploadRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: true,
  store: createRedisStore('upload'),
  keyGenerator: (req) => {
    return (req as { user?: { sub?: string } }).user?.sub ?? req.ip ?? 'unknown';
  },
  handler: rateLimitHandler,
});

// ─────────────────────────────────────────────
// OTP send rate limiter: 3 sends per 10 min keyed by identifier
// Keys on email/phone from request body — not bypassable via VPN.
// Falls back to IP if neither is present.
// ─────────────────────────────────────────────
export const otpSendRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: true,
  store: createRedisStore('otp:send'),
  keyGenerator: (req) => {
    const body = req.body as { email?: string; phone?: string };
    return body.email ?? body.phone ?? req.ip ?? 'unknown';
  },
  handler: rateLimitHandler,
});

// ─────────────────────────────────────────────
// OTP verify rate limiter: 10 attempts per 30 min per identifier
// Outer HTTP-layer guard. The tight 5-attempt lockout lives in
// service.verifyOtpToken() using Redis directly, which is not bypassable.
// ─────────────────────────────────────────────
export const otpVerifyRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 30 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: true,
  store: createRedisStore('otp:verify'),
  keyGenerator: (req) => {
    const body = req.body as { email?: string; phone?: string };
    return body.email ?? body.phone ?? req.ip ?? 'unknown';
  },
  handler: rateLimitHandler,
});
