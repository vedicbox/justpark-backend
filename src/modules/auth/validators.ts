import { z } from 'zod';

// ─────────────────────────────────────────────
// Reusable field definitions
// ─────────────────────────────────────────────
const emailField = z
  .string({ required_error: 'Email is required' })
  .email('Invalid email address')
  .toLowerCase()
  .trim();

const phoneField = z
  .string()
  .regex(/^\+?[1-9]\d{7,14}$/, 'Invalid phone number. Use E.164 format (e.g. +919876543210)')
  .trim();

const passwordField = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password too long')
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    'Password must contain at least one uppercase letter, one lowercase letter, and one number'
  );

const deviceInfoField = z
  .object({
    platform: z.string().optional(),
    os: z.string().optional(),
    app_version: z.string().optional(),
    device_id: z.string().optional(),
  })
  .optional();

// ─────────────────────────────────────────────
// POST /auth/register
// ─────────────────────────────────────────────
export const RegisterSchema = z.object({
  email: emailField,
  password: passwordField,
  first_name: z
    .string({ required_error: 'First name is required' })
    .min(1)
    .max(100)
    .trim(),
  last_name: z
    .string({ required_error: 'Last name is required' })
    .min(1)
    .max(100)
    .trim(),
  phone: phoneField.optional(),
  // Users can self-register as 'user' or 'host'. Admin role is never self-assigned.
  role: z.enum(['user', 'host']).default('user'),
  device_info: deviceInfoField,
});
export type RegisterDto = z.infer<typeof RegisterSchema>;

// ─────────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────────
export const LoginSchema = z.object({
  email: emailField,
  password: z.string({ required_error: 'Password is required' }).min(1),
  device_info: deviceInfoField,
});
export type LoginDto = z.infer<typeof LoginSchema>;

// ─────────────────────────────────────────────
// POST /auth/admin/login
// ─────────────────────────────────────────────
export const AdminLoginSchema = z.object({
  email: emailField,
  password: z.string({ required_error: 'Password is required' }).min(1),
  device_info: deviceInfoField,
});
export type AdminLoginDto = z.infer<typeof AdminLoginSchema>;

// ─────────────────────────────────────────────
// POST /auth/otp/send
// ─────────────────────────────────────────────
// Phone verification moved to Firebase Auth — see /auth/firebase/verify
export const SendOtpSchema = z
  .object({
    type: z.enum(['email_verify', 'password_reset'], {
      required_error: 'OTP type is required',
    }),
    email: emailField.optional(),
  })
  .refine(
    (data) => !!data.email,
    {
      message: 'Email is required for this OTP type',
      path: ['email'],
    }
  );
export type SendOtpDto = z.infer<typeof SendOtpSchema>;

// ─────────────────────────────────────────────
// POST /auth/otp/verify
// ─────────────────────────────────────────────
// Phone verification moved to Firebase Auth — see /auth/firebase/verify
export const VerifyOtpSchema = z
  .object({
    type: z.enum(['email_verify', 'password_reset'], {
      required_error: 'OTP type is required',
    }),
    otp: z
      .string({ required_error: 'OTP is required' })
      .length(6, 'OTP must be exactly 6 digits')
      .regex(/^\d{6}$/, 'OTP must contain only digits'),
    email: emailField.optional(),
  })
  .refine(
    (data) => !!data.email,
    {
      message: 'Email is required for this OTP type',
      path: ['email'],
    }
  );
export type VerifyOtpDto = z.infer<typeof VerifyOtpSchema>;

// ─────────────────────────────────────────────
// POST /auth/firebase/verify
// ─────────────────────────────────────────────
export const FirebaseVerifySchema = z.object({
  id_token: z
    .string({ required_error: 'Firebase ID token is required' })
    .min(20, 'Firebase ID token is invalid'),
  role: z.enum(['user', 'host']).optional().default('user'),
  device_info: deviceInfoField,
});
export type FirebaseVerifyDto = z.infer<typeof FirebaseVerifySchema>;

// ─────────────────────────────────────────────
// POST /auth/social
// ─────────────────────────────────────────────
export const SocialAuthSchema = z.object({
  provider: z.enum(['google', 'apple'], {
    required_error: 'Provider is required',
  }),
  // ID token from the social provider's SDK
  token: z.string({ required_error: 'Social auth token is required' }).min(10),
  device_info: deviceInfoField,
});
export type SocialAuthDto = z.infer<typeof SocialAuthSchema>;

// ─────────────────────────────────────────────
// POST /auth/refresh
// ─────────────────────────────────────────────
export const RefreshTokenSchema = z.object({
  refresh_token: z
    .string({ required_error: 'Refresh token is required' })
    .min(1),
});
export type RefreshTokenDto = z.infer<typeof RefreshTokenSchema>;

// ─────────────────────────────────────────────
// POST /auth/password/reset
// ─────────────────────────────────────────────
export const ResetPasswordSchema = z.object({
  reset_token: z
    .string({ required_error: 'Reset token is required' })
    .min(1),
  new_password: passwordField,
});
export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>;

// ─────────────────────────────────────────────
// POST /auth/password/change
// ─────────────────────────────────────────────
export const ChangePasswordSchema = z.object({
  current_password: z.string({ required_error: 'Current password is required' }).min(1),
  new_password: passwordField,
});
export type ChangePasswordDto = z.infer<typeof ChangePasswordSchema>;


// ─────────────────────────────────────────────
// DELETE /auth/sessions/:id
// ─────────────────────────────────────────────
export const SessionIdParamSchema = z.object({
  id: z.string().uuid('Invalid session ID'),
});
export type SessionIdParam = z.infer<typeof SessionIdParamSchema>;

// ─────────────────────────────────────────────
// POST /auth/deactivate
// ─────────────────────────────────────────────
export const DeactivateSchema = z.object({
  password: z
    .string({ required_error: 'Password confirmation is required' })
    .min(1, 'Password is required to confirm account deactivation'),
});
export type DeactivateDto = z.infer<typeof DeactivateSchema>;
