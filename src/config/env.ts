import { z } from 'zod';
import dotenv from 'dotenv';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

dotenv.config();

// Treat blank env values as unset so placeholder entries in `.env`
// don't silently disable optional integrations like Brevo or block
// real values injected by the runtime / secret manager.
function normalizeProcessEnv(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value.trim() === '') {
      delete process.env[key];
    }
  }
}

normalizeProcessEnv();

// ─────────────────────────────────────────────
// NODE_ENV — always a direct env var, never stored in Secrets Manager.
// Computed eagerly so isDev/isProd/isTest are available before bootstrapEnv().
// ─────────────────────────────────────────────
const _nodeEnv = (process.env.NODE_ENV ?? 'development') as
  | 'development'
  | 'production'
  | 'test';

export const isDev  = _nodeEnv === 'development';
export const isProd = _nodeEnv === 'production';
export const isTest = _nodeEnv === 'test';

// ─────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────
const envSchema = z.object({
  // App
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  API_VERSION: z.string().default('v1'),
  FRONTEND_ORIGINS: z.string().default('http://localhost:3001'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Redis
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379').transform(Number),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.string().default('0').transform(Number),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  // Dedicated secret for password-reset tokens.
  // REQUIRED for production. If absent the server falls back to a derived key
  // (JWT_ACCESS_SECRET + '_RESET') and logs a deprecation warning at startup.
  JWT_RESET_SECRET: z
    .string()
    .min(32, 'JWT_RESET_SECRET must be at least 32 characters')
    .optional(),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // Encryption
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be a 64-char hex string (256-bit)'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.string().default('60000').transform(Number),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100').transform(Number),
  RATE_LIMIT_AUTH_MAX: z.string().default('5').transform(Number),

  // Cloudinary — image storage (replaces MinIO/S3)
  CLOUDINARY_CLOUD_NAME: z.string().min(1, 'CLOUDINARY_CLOUD_NAME is required'),
  CLOUDINARY_API_KEY:    z.string().min(1, 'CLOUDINARY_API_KEY is required'),
  CLOUDINARY_API_SECRET: z.string().min(1, 'CLOUDINARY_API_SECRET is required'),

  // AWS S3 / MinIO — deprecated, kept optional during migration
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  MINIO_PUBLIC_URL: z.string().optional(),
  USE_LOCAL_STORAGE: z.string().optional(),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Razorpay — Payment Gateway
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Razorpay X — Payout API (separate credentials from payment gateway)
  RAZORPAY_X_KEY_ID: z.string().optional(),
  RAZORPAY_X_KEY_SECRET: z.string().optional(),
  RAZORPAY_X_ACCOUNT_NUMBER: z.string().optional(), // source account for payouts
  RAZORPAY_X_WEBHOOK_SECRET: z.string().optional(),

  // Brevo
  BREVO_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().default('noreply@justpark.com'),
  EMAIL_FROM_NAME: z.string().default('JustPark'),

  // Support mailbox (Hostinger SMTP)
  SUPPORT_SMTP_HOST: z.string().default('smtp.hostinger.com'),
  SUPPORT_SMTP_PORT: z.string().default('587').transform(Number),
  SUPPORT_SMTP_SECURE: z.string().default('false').transform((v) => v === 'true'),
  SUPPORT_SMTP_USER: z.string().optional(),
  SUPPORT_SMTP_PASS: z.string().optional(),
  SUPPORT_EMAIL_FROM: z.string().email().default('support@justpark.in'),
  SUPPORT_EMAIL_FROM_NAME: z.string().default('JustPark Support'),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),

  // Firebase Cloud Messaging
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_PRIVATE_KEY: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),

  // Google Maps
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),   // OAuth client ID for social login
  APPLE_APP_BUNDLE_ID: z.string().optional(), // Apple bundle ID for Sign in with Apple

  // Business logic
  PLATFORM_COMMISSION_RATE: z.string().default('0.10').transform(Number),
  TAX_RATE: z.string().default('0').transform(Number),
  SLOT_LOCK_TTL_SECONDS: z.string().default('600').transform(Number),
  DISPUTE_WINDOW_HOURS: z.string().default('72').transform(Number),
  OTP_EXPIRY_MINUTES: z.string().default('10').transform(Number),
  MAX_SESSIONS_PER_USER: z.string().default('5').transform(Number),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z.string().default('false').transform((v) => v === 'true'),
});

type Env = z.infer<typeof envSchema>;

// ─────────────────────────────────────────────
// Internal state — populated by bootstrapEnv()
// ─────────────────────────────────────────────
let _env: Env | undefined;

// ─────────────────────────────────────────────
// Validate process.env against the schema.
// Called after secrets are merged in.
// ─────────────────────────────────────────────
function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌  Invalid environment variables:\n');
    result.error.issues.forEach((issue) => {
      console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }

  const data = result.data;

  // ── Cross-field: webhook secrets required when gateway is configured ───────
  // Webhook signature verification is the only protection against forged payment
  // events (e.g. a fake "payment_succeeded" from a malicious actor).  Without the
  // secret the endpoint accepts any unsigned POST, making the payment flow
  // completely bypassable.  Fail hard at startup so misconfiguration is caught
  // before the server receives real traffic.
  //
  // Enforcement: production always; other envs also validated so CI catches it
  // before a bad deploy reaches prod.
  const missing: string[] = [];

  if (data.STRIPE_SECRET_KEY && !data.STRIPE_WEBHOOK_SECRET) {
    missing.push('STRIPE_WEBHOOK_SECRET (required when STRIPE_SECRET_KEY is set)');
  }

  if (data.RAZORPAY_KEY_ID && !data.RAZORPAY_WEBHOOK_SECRET) {
    missing.push('RAZORPAY_WEBHOOK_SECRET (required when RAZORPAY_KEY_ID is set)');
  }

  if (missing.length > 0) {
    console.error('❌  Missing required webhook secrets:\n');
    missing.forEach((m) => console.error(`  • ${m}`));
    console.error(
      '\n  Webhook signature verification prevents forged payment events. ' +
      'Set the missing secrets before starting the server.'
    );
    process.exit(1);
  }

  return data;
}

// ─────────────────────────────────────────────
// AWS Secrets Manager loader
// Fetches the named secret (JSON object), merges each key into process.env.
// Keys already present in process.env are NOT overwritten — this lets you
// override individual secrets with explicit environment variables if needed.
// ─────────────────────────────────────────────
const SECRETS_NAME = 'JUSTPARK_PROD_SECRETS';

async function loadSecrets(): Promise<void> {
  const region = process.env.AWS_REGION ?? 'ap-south-1';
  const client = new SecretsManagerClient({ region });

  let secretString: string | undefined;
  try {
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: SECRETS_NAME })
    );
    secretString = response.SecretString;
  } catch (err) {
    console.error(
      '❌  Failed to fetch secrets from AWS Secrets Manager '  +
      `(secret: ${SECRETS_NAME}, region: ${region}): ${(err as Error).message}`
    );
    process.exit(1);
  }

  if (!secretString) {
    console.error(
      `❌  AWS Secrets Manager returned an empty SecretString for '${SECRETS_NAME}'`
    );
    process.exit(1);
  }

  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(secretString) as Record<string, unknown>;
  } catch {
    console.error(
      `❌  AWS Secrets Manager secret '${SECRETS_NAME}' is not valid JSON`
    );
    process.exit(1);
  }

  let merged = 0;
  for (const [key, value] of Object.entries(secrets)) {
    // Don't override values already present in process.env — explicit env vars win
    if (process.env[key] === undefined) {
      process.env[key] = String(value);
      merged++;
    }
  }

  console.log(
    `✅  AWS Secrets Manager: merged ${merged} secret(s) from '${SECRETS_NAME}'`
  );
}

// ─────────────────────────────────────────────
// bootstrapEnv — must be called once at startup before any module
// accesses env.*. server.ts calls this before dynamic-importing app code.
//
// Production: fetches JUSTPARK_PROD_SECRETS from AWS Secrets Manager,
//             merges into process.env, then runs Zod validation.
// Dev / test: runs Zod validation against process.env directly
//             (same behaviour as the previous synchronous initialisation).
// ─────────────────────────────────────────────
export async function bootstrapEnv(): Promise<void> {
  normalizeProcessEnv();
  if (isProd) {
    await loadSecrets();
  }
  _env = validateEnv();
}

// ─────────────────────────────────────────────
// env — the validated, typed environment object.
//
// Implemented as a Proxy so that:
// • In production the app crashes loudly if any module touches env.*
//   before bootstrapEnv() has completed.
// • In dev / test the first property access auto-initialises synchronously
//   from process.env — identical to the old behaviour, so tests and the
//   dev server work without any changes.
// ─────────────────────────────────────────────
export const env: Env = new Proxy({} as Env, {
  get(_target, prop) {
    if (!_env) {
      if (isProd) {
        throw new Error(
          `env.${String(prop)} was accessed before bootstrapEnv() completed. ` +
          'Ensure server.ts calls await bootstrapEnv() before importing other modules.'
        );
      }
      // Dev / test: auto-init once on first access
      _env = validateEnv();
    }
    return Reflect.get(_env, prop);
  },
});
