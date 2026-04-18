import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { env } from '../config/env';

const BCRYPT_SALT_ROUNDS = 12;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

// ─────────────────────────────────────────────
// Password Hashing (bcrypt)
// ─────────────────────────────────────────────
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ─────────────────────────────────────────────
// OTP Hashing (SHA-256 — faster than bcrypt for short-lived tokens)
// ─────────────────────────────────────────────
export function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

export function verifyOtp(otp: string, hash: string): boolean {
  const otpHash = hashOtp(otp);
  return crypto.timingSafeEqual(Buffer.from(otpHash), Buffer.from(hash));
}

export function generateOtp(length = 6): string {
  const digits = '0123456789';
  let otp = '';
  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    otp += digits[randomBytes[i] % 10];
  }
  return otp;
}

// ─────────────────────────────────────────────
// Refresh Token Generation
// ─────────────────────────────────────────────
export function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─────────────────────────────────────────────
// Idempotency Key Generation
// ─────────────────────────────────────────────
export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

// ─────────────────────────────────────────────
// AES-256-GCM Encryption (for bank account numbers, etc.)
// ─────────────────────────────────────────────
function getEncryptionKey(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(encryptedData: string): string {
  const key = getEncryptionKey();
  const parts = encryptedData.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');

  const [ivHex, tagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}

// ─────────────────────────────────────────────
// Webhook Signature Verification
// ─────────────────────────────────────────────
export function verifyHmacSignature(
  payload: string | Buffer,
  secret: string,
  signature: string,
  algorithm = 'sha256'
): boolean {
  const expectedSig = crypto
    .createHmac(algorithm, secret)
    .update(payload)
    .digest('hex');
  const sigBuffer = Buffer.from(signature.replace(/^sha\d+=/, ''), 'hex');
  const expectedBuffer = Buffer.from(expectedSig, 'hex');
  if (sigBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}

// ─────────────────────────────────────────────
// Mask sensitive data for logging
// ─────────────────────────────────────────────
export function maskCardNumber(last4: string): string {
  return `**** **** **** ${last4}`;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  const masked = local.slice(0, 2) + '***';
  return `${masked}@${domain}`;
}

export function maskPhone(phone: string): string {
  return phone.slice(0, 3) + '****' + phone.slice(-3);
}
