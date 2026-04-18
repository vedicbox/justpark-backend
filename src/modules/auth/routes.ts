import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { authRateLimiter, otpSendRateLimiter, otpVerifyRateLimiter } from '../../middleware/rateLimiter';
import * as controller from './controller';
import {
  RegisterSchema,
  LoginSchema,
  AdminLoginSchema,
  SendOtpSchema,
  VerifyOtpSchema,
  FirebaseVerifySchema,
  SocialAuthSchema,
  ResetPasswordSchema,
  ChangePasswordSchema,
  DeactivateSchema,
  SessionIdParamSchema,
} from './validators';

export const authRouter = Router();

// ─────────────────────────────────────────────
// Public routes (no JWT required)
// All auth routes get the strict authRateLimiter (5 req/min per IP)
// ─────────────────────────────────────────────

/**
 * POST /auth/register
 * Create a new user or host account.
 * Auto-sends email verification OTP on success.
 */
authRouter.post(
  '/register',
  authRateLimiter,
  validate(RegisterSchema),
  controller.register
);

/**
 * POST /auth/login
 * Email + password login. Returns access + refresh tokens.
 */
authRouter.post(
  '/login',
  authRateLimiter,
  validate(LoginSchema),
  controller.login
);

/**
 * POST /auth/admin/login
 * Email + password login for admins only.
 */
authRouter.post(
  '/admin/login',
  authRateLimiter,
  validate(AdminLoginSchema),
  controller.adminLogin
);

/**
 * POST /auth/otp/send
 * Send OTP for: email_verify | phone_verify | password_reset
 * Responds 200 regardless of whether account exists (prevents email enumeration).
 */
authRouter.post(
  '/otp/send',
  otpSendRateLimiter,     // keyed by email/phone — not bypassable via VPN
  validate(SendOtpSchema),
  controller.sendOtp
);

/**
 * POST /auth/otp/verify
 * Verify OTP. For password_reset type, returns { reset_token }.
 * Tight per-identifier lockout (5 attempts / 30 min) enforced inside the service.
 */
authRouter.post(
  '/otp/verify',
  otpVerifyRateLimiter,   // outer HTTP guard — identifier-keyed, 10/30 min
  validate(VerifyOtpSchema),
  controller.verifyOtp
);

/**
 * POST /auth/firebase/verify
 * Verify a Firebase Phone Auth ID token, find/create the user, and return JustPark tokens.
 */
authRouter.post(
  '/firebase/verify',
  authRateLimiter,
  validate(FirebaseVerifySchema),
  controller.verifyFirebaseToken
);

/**
 * POST /auth/social
 * Exchange a Google or Apple ID token for JustPark tokens.
 * Creates account if none exists, links provider if email matches.
 */
authRouter.post(
  '/social',
  authRateLimiter,
  validate(SocialAuthSchema),
  controller.socialAuth
);

/**
 * POST /auth/refresh
 * Rotate refresh token — old token is invalidated, new pair issued.
 * Refresh token is read from the HttpOnly jp_refresh cookie (not the request body).
 * Returns the new access token in the response body; new cookie is set automatically.
 */
authRouter.post(
  '/refresh',
  controller.refreshToken
);

/**
 * POST /auth/password/reset
 * Reset password using the reset_token returned by /otp/verify.
 * Invalidates all sessions on success.
 */
authRouter.post(
  '/password/reset',
  authRateLimiter,
  validate(ResetPasswordSchema),
  controller.resetPassword
);

/**
 * POST /auth/password/change
 * Authenticated path to change an existing password using the current password.
 */
authRouter.post(
  '/password/change',
  authenticate,
  authRateLimiter,
  validate(ChangePasswordSchema),
  controller.changePassword
);

// ─────────────────────────────────────────────
// Protected routes (valid JWT required)
// ─────────────────────────────────────────────

/**
 * POST /auth/logout
 * Invalidates the current session and blacklists the access token.
 */
authRouter.post(
  '/logout',
  authenticate,
  controller.logout
);

/**
 * GET /auth/sessions
 * List all active sessions (device info, IP, created_at).
 */
authRouter.get(
  '/sessions',
  authenticate,
  controller.getSessions
);

/**
 * DELETE /auth/sessions/:id
 * Revoke a specific session (remote logout from another device).
 */
authRouter.delete(
  '/sessions/:id',
  authenticate,
  validate(SessionIdParamSchema, 'params'),
  controller.revokeSession
);

/**
 * POST /auth/deactivate
 * Soft-delete account: anonymize PII, terminate all sessions.
 * Requires password confirmation.
 */
authRouter.post(
  '/deactivate',
  authenticate,
  authRateLimiter,
  validate(DeactivateSchema),
  controller.deactivateAccount
);
