import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import { AppError } from '../../middleware/errorHandler';
import { isProd } from '../../config/env';
import * as authService from './service';
import type {
  RegisterDto,
  LoginDto,
  AdminLoginDto,
  SendOtpDto,
  VerifyOtpDto,
  FirebaseVerifyDto,
  SocialAuthDto,
  ResetPasswordDto,
  ChangePasswordDto,
  DeactivateDto,
  SessionIdParam,
} from './validators';

// ─────────────────────────────────────────────
// Refresh-token cookie helpers
// ─────────────────────────────────────────────
const REFRESH_COOKIE_NAME    = 'jp_refresh';
const REFRESH_COOKIE_PATH    = '/api/v1/auth';
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1_000; // 30 days in ms

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure:   isProd,       // HTTPS-only in production; plain HTTP allowed in dev
    sameSite: 'strict',    // never sent on cross-site requests — CSRF protection
    path:     REFRESH_COOKIE_PATH,
    maxAge:   REFRESH_COOKIE_MAX_AGE,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

// ─────────────────────────────────────────────
// POST /auth/register
// ─────────────────────────────────────────────
export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as RegisterDto;
    const result = await authService.register(dto, req.body.device_info, req.ip);
    const { refresh_token, ...tokens } = result.tokens;
    setRefreshCookie(res, refresh_token);
    Respond.created(res, { user: result.user, tokens }, 'Account created successfully');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────────
export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as LoginDto;
    const result = await authService.login(dto, dto.device_info, req.ip);
    const { refresh_token, ...tokens } = result.tokens;
    setRefreshCookie(res, refresh_token);
    Respond.ok(res, { user: result.user, tokens }, 'Login successful');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/admin/login
// ─────────────────────────────────────────────
export async function adminLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as AdminLoginDto;
    const result = await authService.adminLogin(dto, dto.device_info, req.ip);
    const { refresh_token, ...tokens } = result.tokens;
    setRefreshCookie(res, refresh_token);
    Respond.ok(res, { user: result.user, tokens }, 'Admin login successful');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/otp/send
// ─────────────────────────────────────────────
export async function sendOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as SendOtpDto;
    await authService.sendOtp(dto);
    // Always return 200 regardless of whether account exists (prevents email enumeration)
    Respond.ok(res, null, 'If an account exists, an OTP has been sent');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/otp/verify
// ─────────────────────────────────────────────
export async function verifyOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as VerifyOtpDto;
    const result = await authService.verifyOtpToken(dto);
    Respond.ok(res, result, 'OTP verified successfully');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/firebase/verify
// ─────────────────────────────────────────────
export async function verifyFirebaseToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as FirebaseVerifyDto;
    const result = await authService.verifyFirebasePhoneAuth(dto, req.ip);
    const { refresh_token, ...tokens } = result.tokens;
    setRefreshCookie(res, refresh_token);
    Respond.ok(res, { user: result.user, tokens }, 'Login successful');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/social
// ─────────────────────────────────────────────
export async function socialAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as SocialAuthDto;
    const result = await authService.socialAuth(dto, dto.device_info, req.ip);

    const { refresh_token, ...tokens } = result.tokens;
    setRefreshCookie(res, refresh_token);

    const statusCode = result.is_new_user ? 201 : 200;
    const message    = result.is_new_user ? 'Account created successfully' : 'Login successful';

    res.status(statusCode).json({
      success: true,
      data: { user: result.user, tokens, is_new_user: result.is_new_user },
      message,
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/refresh
// ─────────────────────────────────────────────
// Refresh token arrives via HttpOnly cookie (jp_refresh), not the request body.
// On success: set a new cookie (token rotation) and return only the access token.
export async function refreshToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cookieToken: string | undefined = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!cookieToken) {
      next(AppError.unauthorized('Refresh token cookie is missing. Please log in again.'));
      return;
    }

    const newTokens = await authService.refreshTokens({ refresh_token: cookieToken }, undefined, req.ip);
    const { refresh_token, ...tokens } = newTokens;
    setRefreshCookie(res, refresh_token);
    Respond.ok(res, tokens, 'Tokens refreshed');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/password/reset
// ─────────────────────────────────────────────
export async function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as ResetPasswordDto;
    await authService.resetPassword(dto);
    Respond.ok(res, null, 'Password reset successfully. Please log in with your new password.');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/password/change
// ─────────────────────────────────────────────
export async function changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as ChangePasswordDto;
    await authService.changePassword(req.user!.sub, dto);
    Respond.ok(res, null, 'Password changed successfully.');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/logout   (requires auth)
// ─────────────────────────────────────────────
export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await authService.logout(
      req.user!.sub,
      req.user!.sessionId,
      req.user!.jti,
      req.user!.exp
    );
    clearRefreshCookie(res);
    Respond.ok(res, null, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// GET /auth/sessions   (requires auth)
// ─────────────────────────────────────────────
export async function getSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessions = await authService.getSessions(req.user!.sub);
    Respond.ok(res, sessions);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// DELETE /auth/sessions/:id   (requires auth)
// ─────────────────────────────────────────────
export async function revokeSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SessionIdParam;
    await authService.revokeSession(req.user!.sub, id);
    Respond.ok(res, null, 'Session revoked');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/deactivate   (requires auth)
// ─────────────────────────────────────────────
export async function deactivateAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as DeactivateDto;
    await authService.deactivateAccount(
      req.user!.sub,
      dto,
      req.user!.jti,
      req.user!.exp
    );
    Respond.ok(res, null, 'Account deactivated. We\'re sorry to see you go.');
  } catch (err) {
    next(err);
  }
}
