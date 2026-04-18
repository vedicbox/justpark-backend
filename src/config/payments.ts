import Stripe from 'stripe';
import Razorpay from 'razorpay';
import { env } from './env';

// ─────────────────────────────────────────────
// Stripe client (singleton)
// API version: 2026-02-25.clover (Stripe SDK v20.4.1 default)
// ─────────────────────────────────────────────
export const stripe: Stripe | null = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-02-25.clover',
    })
  : null;

// ─────────────────────────────────────────────
// Razorpay client (singleton)
// ─────────────────────────────────────────────
export const razorpay: Razorpay | null =
  env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id:     env.RAZORPAY_KEY_ID,
        key_secret: env.RAZORPAY_KEY_SECRET,
      })
    : null;

export function requireStripe(): Stripe {
  if (!stripe) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  return stripe;
}

export function requireRazorpay(): Razorpay {
  if (!razorpay) throw new Error('Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing)');
  return razorpay;
}
