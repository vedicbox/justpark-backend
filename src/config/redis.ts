import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// Slot lock TTL
// ─────────────────────────────────────────────
// All slot lock keys (lock:slot:*) MUST be written with this TTL so that
// volatile-lru eviction can reclaim them under memory pressure. If a slot
// lock key were set without EX the policy would never touch it, causing
// phantom locks that block slots indefinitely.
export const SLOT_LOCK_TTL_SECONDS = 600; // 10 minutes

// ─────────────────────────────────────────────
// Memory alerting thresholds
// ─────────────────────────────────────────────
const MEMORY_WARN_PCT     = 75; // warn at 75 %
const MEMORY_CRITICAL_PCT = 90; // error at 90 %

// ─────────────────────────────────────────────
// Primary Redis client (commands, caching, slot locks)
// ─────────────────────────────────────────────
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
  connectTimeout: 10_000,
  retryStrategy: (times: number) => {
    if (times > 5) {
      console.error('❌  Redis: max retry attempts reached');
      return null; // stop retrying
    }
    return Math.min(times * 200, 2000);
  },
});

redis.on('connect', () => console.log('✅  Redis connected'));
redis.on('error', (err: Error) => console.error('❌  Redis error:', err.message));
redis.on('close', () => console.warn('⚠️   Redis connection closed'));

// ─────────────────────────────────────────────
// Subscriber client (for Pub/Sub — separate connection required by Redis protocol)
// ─────────────────────────────────────────────
export const redisSub = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // subscriber should always retry
  lazyConnect: true,
});

// ─────────────────────────────────────────────
// Redis key namespacing helpers
// ─────────────────────────────────────────────
export const RedisKeys = {
  // Legacy space-level lock (kept for backward compat): lock:{spaceId}:{start}:{end}
  slotLock: (spaceId: string, start: string, end: string) =>
    `lock:${spaceId}:${start}:${end}`,

  // Slot-level lock: lock:slot:{slotId}:{startISO}:{endISO}
  // Key structure: 10-char prefix "lock:slot:" + 36-char UUID + ":" + 20-char startISO + ":" + 20-char endISO
  slotLockById: (slotId: string, start: string, end: string) =>
    `lock:slot:${slotId}:${start}:${end}`,

  // User session rate limiter
  rateLimitUser: (userId: string) => `rl:user:${userId}`,

  // IP rate limiter
  rateLimitIp: (ip: string) => `rl:ip:${ip}`,

  // OTP attempt counter (brute-force protection)
  otpAttempts: (userId: string) => `otp:attempts:${userId}`,

  // Token blacklist (for logout / revoked tokens)
  tokenBlacklist: (jti: string) => `blacklist:${jti}`,

  // Space availability cache (short TTL)
  spaceAvailability: (spaceId: string, date: string) =>
    `avail:${spaceId}:${date}`,

  // User online status (Socket.IO)
  userSocket: (userId: string) => `socket:user:${userId}`,

  // Wallet top-up pending state (gateway_ref → top-up context)
  walletTopup: (gatewayRef: string) => `wallet:topup:${gatewayRef}`,

  // Split payment wallet debit context (pi_id / order_id → reversal info)
  walletSplit: (gatewayRef: string) => `wallet:split:${gatewayRef}`,

  // FCM/APNs device tokens per user (Redis set)
  deviceTokens: (userId: string) => `device:tokens:${userId}`,

  // OTP verify attempt counter per identifier (email or phone) — VPN-bypass-proof
  otpVerifyAttempts: (identifier: string) => `otp:verify:attempts:${identifier}`,

  // OTP verify lockout flag per identifier — set when max attempts reached
  otpVerifyLock: (identifier: string) => `otp:verify:lock:${identifier}`,

  // Per-session revocation marker — enables immediate access-token invalidation
  // when a session is remotely revoked or evicted by the session-cap enforcement
  sessionRevoked: (sessionId: string) => `sess:revoked:${sessionId}`,

  // User-level revocation timestamp (epoch seconds) — any access token with
  // iat < this value is rejected; covers password reset and account deactivation
  userRevokedAt: (userId: string) => `user:revoked_at:${userId}`,

  // Retired refresh token hash → userId — detects reuse of already-rotated tokens
  // (possible indicator of token theft); TTL 30 days (matches refresh token lifetime)
  rtokRetired: (tokenHash: string) => `rtok:retired:${tokenHash}`,

  // Idempotency cache — stores serialised { status, body } for a completed request.
  // Keyed by userId + client-supplied X-Idempotency-Key header. TTL 1 hour.
  idempotency: (userId: string, key: string) => `idempotency:${userId}:${key}`,
} as const;

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
export async function connectRedis(): Promise<void> {
  if (redis.status === 'wait') {
    await redis.connect();
  }

  if (redisSub.status === 'wait') {
    await redisSub.connect();
  }

  console.log('✅  Redis ready');
}

export async function disconnectRedis(): Promise<void> {
  if (redis.status !== 'end') {
    await redis.quit();
  }

  if (redisSub.status !== 'end') {
    await redisSub.quit();
  }

  console.log('🔌  Redis disconnected');
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const reply = await redis.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Memory alerting
// ─────────────────────────────────────────────
// Parses INFO memory to compute used/max ratio and logs a structured
// warning or error when thresholds are crossed.  Returns the raw stats
// so callers (e.g. health endpoints, maintenance jobs) can surface them.
//
// maxmemory == 0 means no limit is configured; we skip the percentage
// check in that case because the ratio would be meaningless.
export interface RedisMemoryStats {
  usedBytes:    number;
  maxBytes:     number;
  usagePct:     number; // 0–100, or 0 when maxmemory is unset
}

export async function checkRedisMemory(): Promise<RedisMemoryStats> {
  const info = await redis.info('memory');

  const parseField = (field: string): number => {
    const m = info.match(new RegExp(`^${field}:(\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };

  const usedBytes = parseField('used_memory');
  const maxBytes  = parseField('maxmemory');
  const usagePct  = maxBytes > 0 ? Math.round((usedBytes / maxBytes) * 100) : 0;

  if (maxBytes > 0) {
    if (usagePct >= MEMORY_CRITICAL_PCT) {
      logger.error(
        { usedBytes, maxBytes, usagePct },
        `Redis memory CRITICAL: ${usagePct}% used (threshold ${MEMORY_CRITICAL_PCT}%)`
      );
    } else if (usagePct >= MEMORY_WARN_PCT) {
      logger.warn(
        { usedBytes, maxBytes, usagePct },
        `Redis memory WARNING: ${usagePct}% used (threshold ${MEMORY_WARN_PCT}%)`
      );
    } else {
      logger.debug({ usedBytes, maxBytes, usagePct }, 'Redis memory OK');
    }
  }

  return { usedBytes, maxBytes, usagePct };
}
