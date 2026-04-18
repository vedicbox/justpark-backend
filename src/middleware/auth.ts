import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { redis, RedisKeys } from '../config/redis';
import { AppError } from './errorHandler';
import { JwtPayload, ErrorCode } from '../types';

// ─────────────────────────────────────────────
// authenticate — required auth (throws 401 if missing/invalid)
// ─────────────────────────────────────────────
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractBearerToken(req);

    if (!token) {
      throw AppError.unauthorized('No authentication token provided');
    }

    const payload = verifyAccessToken(token);

    // Check 1: JTI blacklist (logout / one-time token revocation)
    if (payload.jti) {
      const blacklisted = await redis.exists(RedisKeys.tokenBlacklist(payload.jti));
      if (blacklisted) {
        throw AppError.unauthorized('Token has been revoked. Please log in again.');
      }
    }

    // Check 2: Per-session revocation (remote session kill, session-cap eviction)
    if (payload.sessionId) {
      const revoked = await redis.exists(RedisKeys.sessionRevoked(payload.sessionId));
      if (revoked) {
        throw AppError.unauthorized('Session has been revoked. Please log in again.');
      }
    }

    // Check 3: User-level revocation timestamp (password reset, deactivation)
    // Rejects any access token issued before the revocation was recorded
    if (payload.iat) {
      const revokedAtStr = await redis.get(RedisKeys.userRevokedAt(payload.sub));
      if (revokedAtStr) {
        const revokedAt = parseInt(revokedAtStr, 10);
        if (payload.iat < revokedAt) {
          throw AppError.unauthorized('Session invalidated. Please log in again.');
        }
      }
    }

    req.user = payload;
    next();
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// optionalAuthenticate — attaches user if valid token present,
// silently skips if missing/invalid (for public routes that enrich
// response when authenticated, e.g. space listing with favorites)
// ─────────────────────────────────────────────
export async function optionalAuthenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractBearerToken(req);
    if (!token) return next();

    const payload = verifyAccessToken(token);

    if (payload.jti) {
      const blacklisted = await redis.exists(RedisKeys.tokenBlacklist(payload.jti));
      if (blacklisted) return next();
    }

    if (payload.sessionId) {
      const revoked = await redis.exists(RedisKeys.sessionRevoked(payload.sessionId));
      if (revoked) return next();
    }

    if (payload.iat) {
      const revokedAtStr = await redis.get(RedisKeys.userRevokedAt(payload.sub));
      if (revokedAtStr) {
        const revokedAt = parseInt(revokedAtStr, 10);
        if (payload.iat < revokedAt) return next();
      }
    }

    req.user = payload;
    next();
  } catch {
    // Ignore any token errors — just continue without user
    next();
  }
}

// ─────────────────────────────────────────────
// JWT helpers
// ─────────────────────────────────────────────

// Warn once at startup (module load) if the dedicated reset secret is absent.
// Per-request console.warn would spam logs; a single module-level check is enough.
if (!env.JWT_RESET_SECRET) {
  console.warn(
    '[SECURITY] JWT_RESET_SECRET is not set. Falling back to a derived reset secret. ' +
    'Set JWT_RESET_SECRET (min 32 chars) in your environment to remove this warning.',
  );
}

/**
 * Returns the secret used to sign and verify password-reset tokens.
 *
 * Preference order:
 *   1. env.JWT_RESET_SECRET  — dedicated, independent secret (required for production)
 *   2. env.JWT_ACCESS_SECRET + '_RESET'  — legacy derived fallback (deprecated)
 *
 * The fallback keeps existing deployments working during rollout without
 * requiring a coordinated secret rotation.  Remove it once all environments
 * have JWT_RESET_SECRET configured.
 */
function getResetSecret(): string {
  return env.JWT_RESET_SECRET ?? (env.JWT_ACCESS_SECRET + '_RESET');
}

export function verifyAccessToken(token: string): JwtPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
    return decoded;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(401, ErrorCode.TOKEN_EXPIRED, 'Access token has expired');
    }
    throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Invalid access token');
  }
}

function parseExpiresInToSeconds(str: string): number {
  const unit = str.slice(-1);
  const val = parseInt(str, 10);
  if (unit === 'm') return val * 60;
  if (unit === 'h') return val * 3600;
  if (unit === 'd') return val * 86400;
  return val;
}

export function generateAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const jti = crypto.randomUUID();
  return jwt.sign(
    { ...payload, jti },
    env.JWT_ACCESS_SECRET,
    {
      expiresIn: parseExpiresInToSeconds(env.JWT_ACCESS_EXPIRES_IN),
      issuer: 'justpark-api',
      audience: 'justpark-client',
    }
  );
}

export function generateResetToken(userId: string): string {
  return jwt.sign(
    { sub: userId, purpose: 'password_reset' },
    getResetSecret(),
    {
      expiresIn: '15m',
      issuer: 'justpark-api',
      // Scoped audience prevents a reset token from being accepted
      // anywhere an access token is expected (token-substitution attack).
      audience: 'justpark-reset',
    }
  );
}

export function verifyResetToken(token: string): { sub: string } {
  try {
    const decoded = jwt.verify(
      token,
      getResetSecret(),
      { issuer: 'justpark-api', audience: 'justpark-reset' }
    ) as { sub: string; purpose: string };

    if (decoded.purpose !== 'password_reset') {
      throw AppError.badRequest(ErrorCode.TOKEN_INVALID, 'Invalid reset token');
    }
    return { sub: decoded.sub };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(400, ErrorCode.TOKEN_EXPIRED, 'Password reset token has expired. Please request a new one.');
    }
    throw new AppError(400, ErrorCode.TOKEN_INVALID, 'Invalid password reset token');
  }
}

/**
 * Blacklist a token JTI in Redis so it cannot be reused even before expiry.
 * TTL is set to the remaining lifetime of the token (from exp claim).
 */
export async function blacklistToken(jti: string, expSeconds: number): Promise<void> {
  const ttl = Math.max(1, expSeconds - Math.floor(Date.now() / 1000));
  await redis.set(RedisKeys.tokenBlacklist(jti), '1', 'EX', ttl);
}

// ─────────────────────────────────────────────
// Session & user revocation helpers
// ─────────────────────────────────────────────

/**
 * Mark a specific session as revoked in Redis.
 * TTL of 24 h safely outlives the maximum remaining access-token lifetime (default 15 m).
 * Used by: revokeSession(), createSession() eviction.
 */
export async function markSessionRevoked(sessionId: string): Promise<void> {
  await redis.set(RedisKeys.sessionRevoked(sessionId), '1', 'EX', 86_400);
}

/**
 * Record the current epoch second as the revocation timestamp for a user.
 * Any access token with iat < this value is rejected by authenticate().
 * Used by: resetPassword(), deactivateAccount(), refresh-token reuse detection.
 * TTL of 24 h — sufficient to outlive every in-flight access token.
 */
export async function setUserRevokedAt(userId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await redis.set(RedisKeys.userRevokedAt(userId), String(now), 'EX', 86_400);
}

// ─────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}
