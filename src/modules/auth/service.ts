import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../../config/database';
import { redis, RedisKeys } from '../../config/redis';
import { env } from '../../config/env';
import { verifyFirebaseIdToken } from '../../config/firebaseAdmin';
import { AppError } from '../../middleware/errorHandler';
import {
  generateAccessToken,
  generateResetToken,
  verifyResetToken,
  blacklistToken,
  markSessionRevoked,
  setUserRevokedAt,
} from '../../middleware/auth';
import {
  hashPassword,
  verifyPassword,
  hashOtp,
  verifyOtp,
  generateOtp,
  generateRefreshToken,
  hashRefreshToken,
} from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { futureMinutes, futureDays } from '../../utils/date';
import { ErrorCode, UserRole } from '../../types';
import type {
  RegisterDto,
  LoginDto,
  AdminLoginDto,
  SendOtpDto,
  VerifyOtpDto,
  FirebaseVerifyDto,
  SocialAuthDto,
  RefreshTokenDto,
  ResetPasswordDto,
  ChangePasswordDto,
  DeactivateDto,
} from './validators';

// ─────────────────────────────────────────────
// Return shapes
// ─────────────────────────────────────────────
export interface SafeUser {
  id: string;
  email: string;
  phone: string | null;
  first_name: string;
  last_name: string;
  role: string;
  avatar_url: string | null;
  email_verified: boolean;
  phone_verified: boolean;
  status: string;
  created_at: Date;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number; // seconds until access token expiry
}

export interface AuthResult {
  user: SafeUser;
  tokens: AuthTokens;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
const googleOAuthClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

/** Strip password_hash and return safe user object */
function toSafeUser(user: {
  id: string;
  email: string;
  phone: string | null;
  first_name: string;
  last_name: string;
  role: string;
  avatar_url: string | null;
  email_verified: boolean;
  phone_verified: boolean;
  status: string;
  created_at: Date;
}): SafeUser {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    first_name: user.first_name,
    last_name: user.last_name,
    role: user.role,
    avatar_url: user.avatar_url,
    email_verified: user.email_verified,
    phone_verified: user.phone_verified,
    status: user.status,
    created_at: user.created_at,
  };
}

/** Parse JWT_ACCESS_EXPIRES_IN ("15m", "1h", "30d") → seconds */
function parseExpiresIn(str: string): number {
  const unit = str.slice(-1);
  const value = parseInt(str.slice(0, -1), 10);
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default:  return 900; // fallback 15 minutes
  }
}

function buildPhonePlaceholderEmail(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `phone.${digits}@justpark.local`;
}

/**
 * Create a session record + return raw refresh token.
 * Enforces MAX_SESSIONS_PER_USER: evicts the oldest session(s) when at the cap,
 * immediately marking them revoked in Redis so any live access tokens become invalid.
 */
async function createSession(
  userId: string,
  deviceInfo?: object,
  ipAddress?: string
): Promise<string> {
  // Enforce session cap before creating a new session
  const activeSessions = await prisma.session.findMany({
    where:   { user_id: userId, expires_at: { gt: new Date() } },
    orderBy: { created_at: 'asc' },   // oldest first
    select:  { id: true },
  });

  if (activeSessions.length >= env.MAX_SESSIONS_PER_USER) {
    // Evict enough oldest sessions to make room for exactly one new one
    const toEvict = activeSessions.slice(0, activeSessions.length - env.MAX_SESSIONS_PER_USER + 1);
    for (const s of toEvict) {
      await prisma.session.delete({ where: { id: s.id } });
      await markSessionRevoked(s.id); // invalidate live access tokens for evicted session
    }
  }

  const rawRefreshToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const expiresAt = futureDays(30);

  await prisma.session.create({
    data: {
      user_id:            userId,
      refresh_token_hash: tokenHash,
      device_info:        deviceInfo ?? {},
      ip_address:         ipAddress ?? null,
      expires_at:         expiresAt,
    },
  });

  return rawRefreshToken;
}

/**
 * Build the complete AuthResult (tokens + safe user) for a given user.
 */
async function buildAuthResult(
  user: Parameters<typeof toSafeUser>[0] & { id: string; role: string },
  deviceInfo?: object,
  ipAddress?: string
): Promise<AuthResult> {
  // Create DB session to track refresh token
  const rawRefreshToken = await createSession(user.id, deviceInfo, ipAddress);

  // Find the session we just created so we have its ID for the access token
  const session = await prisma.session.findFirst({
    where: { user_id: user.id, refresh_token_hash: hashRefreshToken(rawRefreshToken) },
    select: { id: true },
  });

  const expiresIn = parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN);

  const accessToken = generateAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role as UserRole,
    sessionId: session?.id,
  });

  return {
    user: toSafeUser(user),
    tokens: {
      access_token: accessToken,
      refresh_token: rawRefreshToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
    },
  };
}

async function findOrCreatePhoneUser(phone: string) {
  const existingUser = await prisma.user.findUnique({
    where: { phone },
  });

  if (existingUser) {
    return existingUser;
  }

  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email: buildPhonePlaceholderEmail(phone),
        phone,
        password_hash: null,
        first_name: 'Just',
        last_name: 'Park',
        role: 'user',
        status: 'active',
        email_verified: false,
        phone_verified: false,
      },
    });

    await tx.wallet.create({
      data: {
        user_id: newUser.id,
        balance: 0,
        currency: 'INR',
      },
    });

    return newUser;
  });

  logger.info({ userId: user.id, phone }, 'Created phone-auth user during OTP flow');
  return user;
}

function isPhonePlaceholderUser(user: {
  email: string;
  password_hash: string | null;
  first_name: string;
  last_name: string;
  phone: string | null;
}): boolean {
  return Boolean(
    user.phone &&
    user.email === buildPhonePlaceholderEmail(user.phone) &&
    user.password_hash === null &&
    user.first_name === 'Just' &&
    user.last_name === 'Park'
  );
}

async function consumeOtpToken(
  dto: VerifyOtpDto
): Promise<{ user: { id: string; email: string }; identifier: string }> {
  const identifier = dto.email!;

  // Lockout check — reject immediately if too many previous failures
  const lockKey = RedisKeys.otpVerifyLock(identifier);
  const isLocked = await redis.exists(lockKey);
  if (isLocked) {
    throw new AppError(
      429,
      ErrorCode.RATE_LIMIT_EXCEEDED,
      'Too many incorrect OTP attempts. Please wait 30 minutes before trying again.'
    );
  }

  const user = await prisma.user.findUnique({
    where: { email: identifier },
    select: { id: true, email: true },
  });

  if (!user) {
    throw new AppError(400, ErrorCode.INVALID_OTP, 'Invalid OTP or account not found');
  }

  // Use transaction to atomically verify and consume OTP (prevents race conditions)
  const result = await prisma.$transaction(async (tx) => {
    // Find the latest unexpired, unused OTP of this type
    const otpRecord = await tx.otpToken.findFirst({
      where: {
        user_id:    user.id,
        type:       dto.type,
        used:       false,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
      select: { id: true, otp_hash: true },
    });

    if (!otpRecord) {
      throw new AppError(400, ErrorCode.OTP_EXPIRED, 'OTP has expired or does not exist. Please request a new one.');
    }

    const isValid = verifyOtp(dto.otp, otpRecord.otp_hash);

    if (!isValid) {
      return { success: false, otpRecord: null };
    }

    // Mark OTP as used atomically within transaction
    await tx.otpToken.update({
      where: { id: otpRecord.id },
      data: { used: true },
    });

    return { success: true, otpRecord };
  });

  if (!result.success) {
    // Handle invalid OTP outside transaction to avoid long-running transactions
    // Increment per-identifier failure counter (atomic — safe against concurrent requests)
    const attemptsKey = RedisKeys.otpVerifyAttempts(identifier);
    const attempts = await redis.incr(attemptsKey);
    if (attempts === 1) {
      // First failure — begin 30-minute sliding window
      await redis.expire(attemptsKey, OTP_VERIFY_LOCK_TTL);
    }

    if (attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
      // Threshold reached — apply lockout and clean up counter
      await redis.set(lockKey, '1', 'EX', OTP_VERIFY_LOCK_TTL);
      await redis.del(attemptsKey);
      throw new AppError(
        429,
        ErrorCode.RATE_LIMIT_EXCEEDED,
        'Too many incorrect OTP attempts. Your account is locked for 30 minutes.'
      );
    }

    throw new AppError(400, ErrorCode.INVALID_OTP, 'Incorrect OTP');
  }

  // Success — clear attempt counter (lock key auto-expires if set)
  await redis.del(RedisKeys.otpVerifyAttempts(identifier));

  return { user, identifier };
}

// ─────────────────────────────────────────────
// 1. REGISTER
// ─────────────────────────────────────────────
/**
 * Register a new user or host, or upgrade a Firebase-created placeholder
 * phone user into a full JustPark account with email/password details.
 */
export async function register(
  dto: RegisterDto,
  deviceInfo?: object,
  ipAddress?: string
): Promise<AuthResult> {
  // Check uniqueness
  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { email: dto.email },
        ...(dto.phone ? [{ phone: dto.phone }] : []),
      ],
    },
  });

  if (existing) {
    const canUpgradePlaceholder =
      dto.phone &&
      existing.phone === dto.phone &&
      isPhonePlaceholderUser(existing);

    if (!canUpgradePlaceholder) {
      if (existing.email === dto.email) {
        throw AppError.conflict(ErrorCode.ALREADY_EXISTS, 'An account with this email already exists');
      }
      throw AppError.conflict(ErrorCode.ALREADY_EXISTS, 'An account with this phone number already exists');
    }
  }

  const passwordHash = await hashPassword(dto.password);

  // Create user + wallet in a transaction, or upgrade a placeholder phone-auth user.
  const user = await prisma.$transaction(async (tx) => {
    if (existing && dto.phone && existing.phone === dto.phone && isPhonePlaceholderUser(existing)) {
      // Whitelist allowed self-registration roles — never trust dto.role blindly
      const allowedRole = dto.role === 'host' ? 'host' : 'user';
      return tx.user.update({
        where: { id: existing.id },
        data: {
          email: dto.email,
          password_hash: passwordHash,
          first_name: dto.first_name,
          last_name: dto.last_name,
          role: allowedRole,
          status: 'active',
          email_verified: false,
          phone_verified: true,
        },
      });
    }

    // Whitelist allowed self-registration roles — 'admin' can never be self-assigned
    const allowedRole = dto.role === 'host' ? 'host' : 'user';
    const newUser = await tx.user.create({
      data: {
        email: dto.email,
        phone: dto.phone ?? null,
        password_hash: passwordHash,
        first_name: dto.first_name,
        last_name: dto.last_name,
        role: allowedRole,
        status: 'active',
        email_verified: false,
        phone_verified: false,
      },
    });

    // Auto-create wallet for every new user
    await tx.wallet.create({
      data: {
        user_id: newUser.id,
        balance: 0,
        currency: 'INR',
      },
    });

    return newUser;
  });

  logger.info({ userId: user.id, role: user.role }, 'New user registered');

  // After registration, trigger email verification OTP (fire-and-forget)
  void triggerEmailVerificationOtp(user.id, user.email);

  return buildAuthResult(user, deviceInfo, ipAddress);
}

// ─────────────────────────────────────────────
// 2. LOGIN
// ─────────────────────────────────────────────
/**
 * Authenticate a traditional email/password user and issue a new session
 * plus JustPark access/refresh tokens.
 */
export async function login(
  dto: LoginDto,
  deviceInfo?: object,
  ipAddress?: string
): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email: dto.email },
  });

  // Always run bcrypt compare to prevent timing attacks, even if user not found
  const dummyHash = '$2b$12$invalidhashpadding..............................';
  const passwordMatch = user
    ? await verifyPassword(dto.password, user.password_hash ?? dummyHash)
    : await verifyPassword(dto.password, dummyHash).then(() => false);

  if (!user || !passwordMatch) {
    throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password');
  }

  if (user.status === 'suspended') {
    throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'Your account has been suspended. Please contact support.');
  }

  if (user.status === 'deactivated') {
    throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account has been deactivated');
  }

  if (!user.password_hash) {
    // Account was created via social auth — no password set
    throw new AppError(
      401,
      ErrorCode.INVALID_CREDENTIALS,
      'This account uses social login. Please sign in with Google or Apple.'
    );
  }

  logger.info({ userId: user.id }, 'User logged in');
  return buildAuthResult(user, deviceInfo, ipAddress);
}

/**
 * Authenticate an admin with email/password and issue a new session
 * plus JustPark access/refresh tokens. Non-admin users are rejected.
 */
export async function adminLogin(
  dto: AdminLoginDto,
  deviceInfo?: object,
  ipAddress?: string
): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email: dto.email },
  });

  const dummyHash = '$2b$12$invalidhashpadding..............................';
  const passwordMatch = user
    ? await verifyPassword(dto.password, user.password_hash ?? dummyHash)
    : await verifyPassword(dto.password, dummyHash).then(() => false);

  if (!user || !passwordMatch) {
    throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password');
  }

  if (user.role !== 'admin') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Not authorized as admin');
  }

  if (user.status === 'suspended') {
    throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'Your account has been suspended. Please contact support.');
  }

  if (user.status === 'deactivated') {
    throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account has been deactivated');
  }

  if (!user.password_hash) {
    throw new AppError(
      401,
      ErrorCode.INVALID_CREDENTIALS,
      'This admin account does not have a password configured.'
    );
  }

  logger.info({ userId: user.id }, 'Admin logged in');
  return buildAuthResult(user, deviceInfo, ipAddress);
}

// ─────────────────────────────────────────────
// 3. SEND OTP
// ─────────────────────────────────────────────
/**
 * Send a server-generated OTP for email verification or password reset.
 * Phone verification is intentionally rejected here because phone auth
 * is handled by Firebase on the frontend and exchanged via /auth/firebase/verify.
 */
export async function sendOtp(dto: SendOtpDto): Promise<void> {
  // Defensive guard for stale callers that still attempt the retired phone OTP flow.
  if ((dto as SendOtpDto & { phone?: string }).phone) {
    throw AppError.badRequest(
      ErrorCode.INVALID_INPUT,
      'Phone verification is handled via Firebase. Use /auth/firebase/verify instead.'
    );
  }

  const identifier = dto.email!;

  const user = await prisma.user.findUnique({
    where: { email: identifier },
    select: { id: true, email: true, phone: true, status: true },
  });

  if (!user) {
    // Don't reveal whether the account exists — return silently
    logger.warn({ type: dto.type, identifier }, 'OTP send: user not found (silent)');
    return;
  }

  if (user.status === 'suspended' || user.status === 'deactivated') {
    return; // Silent — don't reveal status
  }

  // Rate limit: max 5 OTPs per 10 min per user (in addition to express-rate-limit on route)
  const attemptKey = RedisKeys.otpAttempts(user.id);
  const attempts = await redis.incr(attemptKey);
  if (attempts === 1) {
    await redis.expire(attemptKey, 10 * 60); // 10-min window
  }
  if (attempts > 5) {
    throw new AppError(429, ErrorCode.RATE_LIMIT_EXCEEDED, 'Too many OTP requests. Please wait 10 minutes.');
  }

  // Invalidate any previous unused OTPs of the same type
  await prisma.otpToken.updateMany({
    where: { user_id: user.id, type: dto.type, used: false },
    data: { used: true },
  });

  // Generate + store OTP
  const otp = generateOtp(6);
  const otpHash = hashOtp(otp);
  const expiresAt = futureMinutes(env.OTP_EXPIRY_MINUTES);

  await prisma.otpToken.create({
    data: {
      user_id: user.id,
      otp_hash: otpHash,
      type: dto.type,
      expires_at: expiresAt,
      used: false,
    },
  });

  // Deliver OTP (notification service — implemented in Phase 13)
  await deliverOtp(user, dto.type, otp, identifier);
}

// ─────────────────────────────────────────────
// 4. VERIFY OTP
// Returns reset_token for password_reset type, otherwise void.
// Per-identifier attempt tracking + 30-min lockout after 5 failures.
// Identifier-based locking is VPN-bypass-proof (unlike IP-based rate limiting).
// ─────────────────────────────────────────────

const OTP_MAX_VERIFY_ATTEMPTS = 5;
const OTP_VERIFY_LOCK_TTL     = 30 * 60; // 30 minutes in seconds

/**
 * Verify a server-generated OTP for email verification or password reset.
 * On password reset, this returns a short-lived reset token for the next step.
 */
export async function verifyOtpToken(
  dto: VerifyOtpDto
): Promise<{ verified: true; reset_token?: string }> {
  const { user } = await consumeOtpToken(dto);

  // Update verified flag on user
  if (dto.type === 'email_verify') {
    await prisma.user.update({
      where: { id: user.id },
      data:  { email_verified: true },
    });
    return { verified: true };
  }

  // password_reset — issue a short-lived reset token (15 min)
  // Stored in Redis for one-time use enforcement
  const resetToken = generateResetToken(user.id);
  const resetKey   = `pwd_reset:${user.id}`;
  await redis.set(resetKey, resetToken, 'EX', 15 * 60);

  return { verified: true, reset_token: resetToken };
}

/**
 * Verify a Firebase Phone Auth ID token, find or create the matching user,
 * mark the phone as verified, and issue a JustPark session/token pair.
 *
 * Outcomes:
 * - Valid token + existing user: return JustPark JWTs + user
 * - Valid token + new phone number: auto-create placeholder user + wallet, return JWTs + user
 * - Invalid or expired Firebase token: throw 401
 */
export async function verifyFirebasePhoneAuth(
  dto: FirebaseVerifyDto,
  ipAddress?: string
): Promise<AuthResult> {
  let decodedToken;
  try {
    decodedToken = await verifyFirebaseIdToken(dto.id_token);
  } catch (err) {
    logger.warn({ err }, 'Firebase ID token verification failed');
    if (err instanceof Error && err.message === 'Firebase Admin is not configured') {
      throw AppError.internal('Firebase Admin is not configured on the backend');
    }

    throw new AppError(
      401,
      ErrorCode.TOKEN_INVALID,
      'Firebase ID token verification failed. Make sure frontend and backend use the same Firebase project.'
    );
  }

  const phoneNumber = decodedToken.phone_number;
  if (!phoneNumber) {
    throw AppError.badRequest(ErrorCode.INVALID_INPUT, 'Firebase token does not include a phone number');
  }

  const phoneUser = await findOrCreatePhoneUser(phoneNumber);
  const updatedUser = phoneUser.phone_verified
    ? phoneUser
    : await prisma.user.update({
      where: { id: phoneUser.id },
      data: { phone_verified: true },
    });

  const roleAdjustedUser = updatedUser.role === 'user' && dto.role === 'host'
    ? await prisma.user.update({
      where: { id: updatedUser.id },
      data: { role: 'host' },
    })
    : updatedUser;

  return buildAuthResult(roleAdjustedUser, dto.device_info, ipAddress);
}

// ─────────────────────────────────────────────
// 5. SOCIAL AUTH (Google / Apple)
// ─────────────────────────────────────────────
/**
 * Exchange a verified Google or Apple identity token for a JustPark account
 * and session, linking to an existing user when possible.
 */
export async function socialAuth(
  dto: SocialAuthDto,
  deviceInfo?: object,
  ipAddress?: string
): Promise<AuthResult & { is_new_user: boolean }> {
  const profile =
    dto.provider === 'google'
      ? await verifyGoogleToken(dto.token)
      : await verifyAppleToken(dto.token);

  // Check if this social provider account already exists
  const existingProvider = await prisma.socialAuthProvider.findUnique({
    where: {
      provider_provider_user_id: {
        provider: dto.provider,
        provider_user_id: profile.providerUserId,
      },
    },
    include: { user: true },
  });

  if (existingProvider) {
    // Existing user — check status
    if (existingProvider.user.status === 'suspended') {
      throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'Your account has been suspended.');
    }
    if (existingProvider.user.status === 'deactivated') {
      throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account has been deactivated.');
    }

    logger.info({ userId: existingProvider.user.id, provider: dto.provider }, 'Social login');
    const result = await buildAuthResult(existingProvider.user, deviceInfo, ipAddress);
    return { ...result, is_new_user: false };
  }

  // No existing provider link — find by email or create new user
  let user = profile.email
    ? await prisma.user.findUnique({ where: { email: profile.email } })
    : null;

  let isNewUser = false;

  if (user) {
    // Link this social provider to existing account
    await prisma.socialAuthProvider.create({
      data: {
        user_id: user.id,
        provider: dto.provider,
        provider_user_id: profile.providerUserId,
      },
    });
    logger.info({ userId: user.id, provider: dto.provider }, 'Social provider linked to existing account');
  } else {
    // Create brand new user + wallet
    user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: profile.email ?? `social_${profile.providerUserId}@justpark.com`,
          first_name: profile.firstName ?? 'User',
          last_name: profile.lastName ?? '',
          role: 'user',
          status: 'active',
          email_verified: !!profile.email, // Email from social provider is considered verified
          phone_verified: false,
          password_hash: null, // Social auth users have no password
        },
      });

      await tx.wallet.create({
        data: { user_id: newUser.id, balance: 0, currency: 'INR' },
      });

      await tx.socialAuthProvider.create({
        data: {
          user_id: newUser.id,
          provider: dto.provider,
          provider_user_id: profile.providerUserId,
        },
      });

      return newUser;
    });

    isNewUser = true;
    logger.info({ userId: user.id, provider: dto.provider }, 'New user created via social auth');
  }

  const result = await buildAuthResult(user, deviceInfo, ipAddress);
  return { ...result, is_new_user: isNewUser };
}

// ─────────────────────────────────────────────
// 6. REFRESH TOKENS (with rotation + reuse detection)
// ─────────────────────────────────────────────
/**
 * Rotate a refresh token, detect reuse, and issue a fresh access/refresh pair.
 * If reuse is detected, all sessions for that user are revoked.
 */
export async function refreshTokens(
  dto: RefreshTokenDto,
  deviceInfo?: object,
  ipAddress?: string
): Promise<AuthTokens> {
  const tokenHash = hashRefreshToken(dto.refresh_token);

  // ── Reuse detection ───────────────────────────────────────────────────────
  // A previously-rotated token hash is stored in Redis (key = hash, value = userId).
  // If a retired hash is presented again, it strongly indicates token theft:
  // the attacker used the stolen refresh token after the legitimate client already
  // rotated it. Response: revoke ALL sessions for the user immediately.
  const retiredKey    = RedisKeys.rtokRetired(tokenHash);
  const retiredUserId = await redis.get(retiredKey);
  if (retiredUserId) {
    // Security incident — find and mark all sessions before deleting them
    const sessions = await prisma.session.findMany({
      where:  { user_id: retiredUserId },
      select: { id: true },
    });
    await prisma.session.deleteMany({ where: { user_id: retiredUserId } });
    for (const s of sessions) {
      await markSessionRevoked(s.id);
    }
    await setUserRevokedAt(retiredUserId);
    logger.warn({ userId: retiredUserId }, 'Security incident: refresh token reuse detected — all sessions revoked');
    throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Refresh token has already been used. Please log in again.');
  }

  // ── Normal path ───────────────────────────────────────────────────────────
  const session = await prisma.session.findFirst({
    where: {
      refresh_token_hash: tokenHash,
      expires_at:         { gt: new Date() },
    },
    include: {
      user: { select: { id: true, email: true, role: true, status: true } },
    },
  });

  if (!session) {
    throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Invalid or expired refresh token. Please log in again.');
  }

  if (session.user.status === 'suspended' || session.user.status === 'deactivated') {
    await prisma.session.delete({ where: { id: session.id } });
    throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'Account is no longer active.');
  }

  // Rotate: delete old session first.
  // Guard against a race where two concurrent requests arrive with the same token —
  // the second delete would throw P2025 (record already gone). Treat that as invalid,
  // not a 500, because there is no longer a valid session to rotate.
  try {
    await prisma.session.delete({ where: { id: session.id } });
  } catch (err: unknown) {
    const isAlreadyDeleted =
      err instanceof Error &&
      (err as any).code === 'P2025';
    if (isAlreadyDeleted) {
      throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Invalid or expired refresh token. Please log in again.');
    }
    throw err;
  }

  // Retire the old hash so any replay is detected (value = userId for incident response).
  // TTL matches the refresh token lifetime so stolen tokens are always caught within their
  // validity window — a 24 h TTL would leave a 29-day blind spot on 30-day tokens.
  const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
  await redis.set(retiredKey, session.user.id, 'EX', REFRESH_TOKEN_TTL_SECONDS);

  // Create new session with a fresh token
  const newRawToken  = generateRefreshToken();
  const newTokenHash = hashRefreshToken(newRawToken);
  const expiresAt    = futureDays(30);

  const newSession = await prisma.session.create({
    data: {
      user_id:            session.user.id,
      refresh_token_hash: newTokenHash,
      device_info:        deviceInfo ?? session.device_info ?? {},
      ip_address:         ipAddress  ?? session.ip_address,
      expires_at:         expiresAt,
    },
  });

  const expiresIn   = parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN);
  const accessToken = generateAccessToken({
    sub:       session.user.id,
    email:     session.user.email,
    role:      session.user.role as UserRole,
    sessionId: newSession.id,
  });

  return {
    access_token:  accessToken,
    refresh_token: newRawToken,
    token_type:    'Bearer',
    expires_in:    expiresIn,
  };
}

// ─────────────────────────────────────────────
// 7. RESET PASSWORD
// ─────────────────────────────────────────────
/**
 * Reset a user's password using a one-time reset token produced by the
 * password-reset OTP flow, then revoke all existing sessions.
 */
export async function resetPassword(dto: ResetPasswordDto): Promise<void> {
  // Verify the reset token (JWT signed with reset-specific secret)
  const { sub: userId } = verifyResetToken(dto.reset_token);

  // Also verify it's still in Redis (one-time use)
  const resetKey = `pwd_reset:${userId}`;
  const storedToken = await redis.get(resetKey);
  if (!storedToken || storedToken !== dto.reset_token) {
    throw new AppError(400, ErrorCode.TOKEN_INVALID, 'Password reset token has already been used or expired.');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, password_hash: true },
  });
  if (!user) throw AppError.notFound('User');

  // Prevent reusing the same password
  if (user.password_hash) {
    const isSame = await verifyPassword(dto.new_password, user.password_hash);
    if (isSame) {
      throw AppError.badRequest(ErrorCode.INVALID_INPUT, 'New password must be different from the current password');
    }
  }

  const newHash = await hashPassword(dto.new_password);

  await prisma.$transaction(async (tx) => {
    // Update password
    await tx.user.update({ where: { id: userId }, data: { password_hash: newHash } });
    // Invalidate ALL sessions (force re-login everywhere after password reset)
    await tx.session.deleteMany({ where: { user_id: userId } });
  });

  // Consume the reset token
  await redis.del(resetKey);

  // Invalidate all access tokens that were issued before this moment.
  // All sessions were deleted above; this ensures in-flight tokens are also rejected.
  await setUserRevokedAt(userId);

  logger.info({ userId }, 'Password reset successfully');
}

// ─────────────────────────────────────────────
// 7b. CHANGE PASSWORD (AUTHENTICATED)
// ─────────────────────────────────────────────
/**
 * Change a user's password using their current password for verification.
 * Does NOT revoke sessions (unlike resetPassword).
 */
export async function changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, password_hash: true },
  });

  if (!user) throw AppError.notFound('User');

  if (!user.password_hash) {
    throw AppError.badRequest(
      ErrorCode.INVALID_INPUT,
      'Your account does not have a password configured (created via social auth).'
    );
  }

  const isOldValid = await verifyPassword(dto.current_password, user.password_hash);
  if (!isOldValid) {
    throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Incorrect current password');
  }

  const isSame = await verifyPassword(dto.new_password, user.password_hash);
  if (isSame) {
    throw AppError.badRequest(ErrorCode.INVALID_INPUT, 'New password must be different from the current password');
  }

  const newHash = await hashPassword(dto.new_password);
  
  await prisma.user.update({
    where: { id: userId },
    data: { password_hash: newHash },
  });

  logger.info({ userId }, 'Password changed successfully');
}

// ─────────────────────────────────────────────
// 8. LOGOUT
// ─────────────────────────────────────────────
/**
 * Log out the current authenticated session and blacklist the access token
 * until it expires naturally.
 */
export async function logout(
  userId: string,
  sessionId: string | undefined,
  accessTokenJti: string | undefined,
  accessTokenExp: number | undefined
): Promise<void> {
  // Delete session from DB
  if (sessionId) {
    await prisma.session.deleteMany({
      where: { id: sessionId, user_id: userId },
    });
  }

  // Blacklist the access token so it can't be reused until it naturally expires
  if (accessTokenJti && accessTokenExp) {
    await blacklistToken(accessTokenJti, accessTokenExp);
  }

  logger.info({ userId, sessionId }, 'User logged out');
}

// ─────────────────────────────────────────────
// 9. LIST SESSIONS
// ─────────────────────────────────────────────
/**
 * List all active sessions for the authenticated user.
 */
export async function getSessions(userId: string) {
  const sessions = await prisma.session.findMany({
    where: {
      user_id: userId,
      expires_at: { gt: new Date() },
    },
    select: {
      id: true,
      device_info: true,
      ip_address: true,
      created_at: true,
      expires_at: true,
    },
    orderBy: { created_at: 'desc' },
  });

  return sessions;
}

// ─────────────────────────────────────────────
// 10. REVOKE SESSION
// ─────────────────────────────────────────────
/**
 * Revoke a specific active session belonging to the authenticated user.
 */
export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, user_id: userId },
  });

  if (!session) {
    throw AppError.notFound('Session');
  }

  await prisma.session.delete({ where: { id: sessionId } });
  // Mark the session revoked in Redis so any live access tokens for it are
  // rejected immediately — without waiting for their natural 15-min expiry
  await markSessionRevoked(sessionId);
  logger.info({ userId, sessionId }, 'Session revoked');
}

// ─────────────────────────────────────────────
// 11. DEACTIVATE ACCOUNT
// Soft delete — anonymize PII, terminate all sessions
// ─────────────────────────────────────────────
/**
 * Soft-delete a user account by anonymizing PII, deleting active sessions,
 * and revoking all outstanding access tokens.
 */
export async function deactivateAccount(
  userId: string,
  dto: DeactivateDto,
  accessTokenJti: string | undefined,
  accessTokenExp: number | undefined
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, password_hash: true, status: true },
  });

  if (!user) throw AppError.notFound('User');

  // Must confirm with password (unless social-only account)
  if (user.password_hash) {
    const valid = await verifyPassword(dto.password, user.password_hash);
    if (!valid) {
      throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Incorrect password');
    }
  }

  await prisma.$transaction(async (tx) => {
    // Anonymize PII
    await tx.user.update({
      where: { id: userId },
      data: {
        status: 'deactivated',
        email: `deleted_${userId}@justpark.com`,
        phone: null,
        first_name: 'Deleted',
        last_name: 'User',
        avatar_url: null,
        password_hash: null,
      },
    });

    // Terminate all sessions
    await tx.session.deleteMany({ where: { user_id: userId } });
  });

  // Blacklist current access token
  if (accessTokenJti && accessTokenExp) {
    await blacklistToken(accessTokenJti, accessTokenExp);
  }

  // Revoke all previously-issued access tokens for this user (catches other devices)
  await setUserRevokedAt(userId);

  logger.info({ userId }, 'Account deactivated');
}

// ─────────────────────────────────────────────
// Social provider token verification
// ─────────────────────────────────────────────
interface SocialProfile {
  providerUserId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

async function verifyGoogleToken(token: string): Promise<SocialProfile> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, 'Google authentication is not configured');
  }

  try {
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: token,
      audience: env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.sub) {
      throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Invalid Google ID token');
    }

    const nameParts = (payload.name ?? '').split(' ');
    return {
      providerUserId: payload.sub,
      email: payload.email,
      firstName: nameParts[0] ?? payload.given_name,
      lastName: nameParts.slice(1).join(' ') || payload.family_name,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.warn({ err }, 'Google token verification failed');
    throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Failed to verify Google token');
  }
}

async function verifyAppleToken(token: string): Promise<SocialProfile> {
  if (!env.APPLE_APP_BUNDLE_ID) {
    throw new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, 'Apple authentication is not configured');
  }

  try {
    // Fetch Apple's public keys
    const jwksResponse = await fetch('https://appleid.apple.com/auth/keys');
    if (!jwksResponse.ok) {
      throw new Error('Failed to fetch Apple JWKS');
    }
    const jwks = await jwksResponse.json() as { keys: AppleJwk[] };

    // Decode token header to get kid
    const headerB64 = token.split('.')[0];
    if (!headerB64) throw new Error('Invalid token format');
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString()) as { kid: string; alg: string };

    // Find matching key
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error('No matching Apple public key found');

    // Import the JWK as a crypto key and verify the JWT manually
    const { createPublicKey } = await import('crypto');
    const { default: jwt } = await import('jsonwebtoken');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const publicKey = createPublicKey({ key: jwk as any, format: 'jwk' });
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'https://appleid.apple.com',
      audience: env.APPLE_APP_BUNDLE_ID,
    }) as { sub: string; email?: string };

    const nameParts = (decoded as { name?: string }).name?.split(' ') ?? [];
    return {
      providerUserId: decoded.sub,
      email: decoded.email,
      firstName: nameParts[0],
      lastName: nameParts.slice(1).join(' ') || undefined,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.warn({ err }, 'Apple token verification failed');
    throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Failed to verify Apple token');
  }
}

interface AppleJwk {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n: string;
  e: string;
}

// ─────────────────────────────────────────────
// OTP Delivery (stub — Phase 13 wires real email/SMS)
// ─────────────────────────────────────────────
async function deliverOtp(
  user: { id: string; email: string; phone: string | null },
  type: SendOtpDto['type'],
  otp: string,
  _identifier: string
): Promise<void> {
  // In production, this calls emailService / smsService (Phase 13)
  // For now, log in development so it can be tested without email setup
  if (env.NODE_ENV !== 'production') {
    logger.info({ userId: user.id, type, otp }, `[DEV] OTP generated — use this to verify`);
    return;
  }

  logger.info('OTP delivery handled by Firebase on frontend');
  return;
}

/** Trigger email verification OTP after registration (fire-and-forget) */
async function triggerEmailVerificationOtp(userId: string, email: string): Promise<void> {
  try {
    await sendOtp({ type: 'email_verify', email });
  } catch (err) {
    // Non-fatal — user can manually request verification
    logger.warn({ userId, err }, 'Failed to send post-registration email verification OTP');
  }
}
