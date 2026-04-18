import { Request, Response, NextFunction } from 'express';
import { redis, RedisKeys } from '../config/redis';
import { AppError } from './errorHandler';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const IDEMPOTENCY_TTL_SECONDS = 3_600; // cached response lives for 1 hour
const PROCESSING_SENTINEL     = '__PROCESSING__';
const PROCESSING_TTL_SECONDS  = 30;   // sentinel expires if handler hangs / crashes

// Shape stored in Redis for a completed request
interface CachedEntry {
  status: number;
  body:   unknown;
}

// ─────────────────────────────────────────────
// idempotency() middleware factory
//
// Behaviour:
//   1. Requires X-Idempotency-Key header — 400 if absent.
//   2. Cache HIT  → replay exact status + body; add X-Idempotent-Replayed: true.
//   3. In-flight  → 409; client should wait and retry.
//   4. Cache MISS → set a short-lived sentinel (SET NX EX 30) to guard against
//                   concurrent duplicate requests, then proceed to the handler.
//
// Response interception:
//   res.json is monkey-patched to capture status + body just before they are sent.
//   - 2xx  → write entry to Redis with 1-hour TTL (replaces sentinel).
//   - non-2xx → delete sentinel so the client can retry with the same key after
//               fixing the underlying problem (e.g. validation error on the body).
//
// Placement: must come AFTER authenticate (needs req.user) and BEFORE validate /
// controller so that cache hits short-circuit without re-running validation.
// ─────────────────────────────────────────────
export function idempotency() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // ── 1. Require the header ──────────────────────────────────────────────────
    const rawHeader = req.headers['x-idempotency-key'];
    if (!rawHeader || typeof rawHeader !== 'string' || !rawHeader.trim()) {
      next(AppError.badRequest(
        'MISSING_IDEMPOTENCY_KEY',
        'X-Idempotency-Key header is required for this endpoint',
      ));
      return;
    }

    const userId   = req.user!.sub;
    const redisKey = RedisKeys.idempotency(userId, rawHeader.trim());

    // ── 2. Check Redis ─────────────────────────────────────────────────────────
    let cached: string | null;
    try {
      cached = await redis.get(redisKey);
    } catch (e) {
      // Redis unavailable — fail open so the request proceeds without idempotency
      // protection rather than returning 503. Log and continue.
      console.warn(`[idempotency] Redis GET failed for key "${redisKey}": ${(e as Error).message}`);
      next();
      return;
    }

    if (cached === PROCESSING_SENTINEL) {
      next(AppError.conflict(
        'IDEMPOTENCY_IN_FLIGHT',
        'A request with this idempotency key is already in progress. Retry after a moment.',
      ));
      return;
    }

    if (cached !== null) {
      // Replay the stored response verbatim
      const entry = JSON.parse(cached) as CachedEntry;
      res.setHeader('X-Idempotent-Replayed', 'true');
      res.status(entry.status).json(entry.body);
      return;
    }

    // ── 3. Claim the key with a processing sentinel (SET NX) ──────────────────
    let acquired: string | null;
    try {
      acquired = await redis.set(redisKey, PROCESSING_SENTINEL, 'EX', PROCESSING_TTL_SECONDS, 'NX');
    } catch (e) {
      // Redis unavailable — fail open
      console.warn(`[idempotency] Redis SET NX failed for key "${redisKey}": ${(e as Error).message}`);
      next();
      return;
    }

    if (!acquired) {
      // Another request raced to claim the same key
      next(AppError.conflict(
        'IDEMPOTENCY_IN_FLIGHT',
        'A request with this idempotency key is already in progress. Retry after a moment.',
      ));
      return;
    }

    // ── 4. Intercept res.json to cache the response before it is sent ──────────
    const originalJson = res.json.bind(res) as (body: unknown) => Response;
    res.json = function (body: unknown): Response {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Success — store for future replays, replacing the sentinel
        const entry: CachedEntry = { status: res.statusCode, body };
        redis
          .set(redisKey, JSON.stringify(entry), 'EX', IDEMPOTENCY_TTL_SECONDS)
          .catch((e: Error) =>
            console.warn(`[idempotency] cache write failed for key "${redisKey}": ${e.message}`)
          );
      } else {
        // Error — remove sentinel so the client can retry with the same key
        redis.del(redisKey).catch(() => { /* best-effort */ });
      }
      return originalJson(body);
    };

    next();
  };
}
