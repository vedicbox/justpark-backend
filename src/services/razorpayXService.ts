/**
 * Razorpay X — Payout API Service
 *
 * Razorpay X is a separate product from the Razorpay payment gateway.
 * It uses its own API credentials (RAZORPAY_X_KEY_ID / RAZORPAY_X_KEY_SECRET)
 * and a source account number (RAZORPAY_X_ACCOUNT_NUMBER) from which payouts
 * are debited.
 *
 * Flow:
 *   1. addBankAccount   → createContact() + createFundAccount()
 *   2. requestPayout    → payout record created with idempotency_key
 *   3. cron (process-payouts) → createPayout() → status: processing
 *   4. webhook          → payout.processed / payout.failed / payout.reversed
 *
 * API reference: https://razorpay.com/docs/x/payouts/
 */

import https from 'node:https';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// Types — Razorpay X API shapes
// ─────────────────────────────────────────────

export interface RazorpayXContact {
  id:           string;   // "cont_xxx"
  entity:       string;   // "contact"
  name:         string;
  email?:       string;
  contact?:     string;
  type:         string;   // "vendor"
  reference_id?: string;
  active:       boolean;
  created_at:   number;
}

export interface RazorpayXFundAccount {
  id:           string;   // "fa_xxx"
  entity:       string;   // "fund_account"
  contact_id:   string;
  account_type: string;   // "bank_account"
  bank_account: {
    name:           string;
    ifsc:           string;
    bank_name:      string;
    branch:         string;
    account_number: string;
  };
  active:     boolean;
  created_at: number;
}

export type RazorpayXPayoutStatus =
  | 'queued'
  | 'pending'
  | 'rejected'
  | 'processing'
  | 'processed'
  | 'cancelled'
  | 'reversed'
  | 'failed';

export interface RazorpayXPayout {
  id:              string;   // "pout_xxx"
  entity:          string;   // "payout"
  fund_account_id: string;
  fund_account:    RazorpayXFundAccount;
  amount:          number;   // in paise
  currency:        string;
  mode:            string;   // "IMPS" | "NEFT" | "RTGS" | "UPI"
  purpose:         string;
  status:          RazorpayXPayoutStatus;
  utr?:            string;   // bank reference — set when processed
  failure_reason?: string;   // set when failed/reversed
  narration:       string;
  created_at:      number;
  processed_at?:   number;
}

export interface RazorpayXWebhookPayload {
  entity:   string;  // "event"
  event:    string;  // "payout.processed" | "payout.failed" | etc.
  contains: string[];
  payload:  {
    payout: {
      entity: RazorpayXPayout;
    };
  };
  created_at: number;
}

// ─────────────────────────────────────────────
// Configuration guard
// ─────────────────────────────────────────────

export function isRazorpayXConfigured(): boolean {
  return !!(
    env.RAZORPAY_X_KEY_ID &&
    env.RAZORPAY_X_KEY_SECRET &&
    env.RAZORPAY_X_ACCOUNT_NUMBER
  );
}

// ─────────────────────────────────────────────
// HTTP helper — raw HTTPS requests to Razorpay X
// (No SDK: the razorpay npm package targets the payment gateway, not X)
// ─────────────────────────────────────────────

interface RazorpayXRequestOptions {
  method:   'GET' | 'POST' | 'PATCH';
  path:     string;
  body?:    Record<string, unknown>;
  /** Optional: X-Payout-Idempotency header value */
  idempotencyKey?: string;
}

async function razorpayXRequest<T>(options: RazorpayXRequestOptions): Promise<T> {
  const { method, path, body, idempotencyKey } = options;

  if (!env.RAZORPAY_X_KEY_ID || !env.RAZORPAY_X_KEY_SECRET) {
    throw new Error('Razorpay X credentials are not configured');
  }

  const credentials = Buffer.from(
    `${env.RAZORPAY_X_KEY_ID}:${env.RAZORPAY_X_KEY_SECRET}`
  ).toString('base64');

  const bodyStr = body ? JSON.stringify(body) : undefined;

  const headers: Record<string, string> = {
    'Authorization': `Basic ${credentials}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
  if (idempotencyKey) {
    headers['X-Payout-Idempotency'] = idempotencyKey;
  }
  if (bodyStr) {
    headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
  }

  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.razorpay.com',
        port:     443,
        path:     `/v1${path}`,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }

          if (res.statusCode && res.statusCode >= 400) {
            const errBody = parsed as Record<string, unknown>;
            const errMsg  = (errBody?.error as Record<string, string> | undefined)?.description
              ?? `Razorpay X API error ${res.statusCode}`;
            reject(new Error(`[RazorpayX] ${errMsg} (${res.statusCode}): ${raw}`));
            return;
          }

          resolve(parsed as T);
        });
      }
    );

    req.on('error', (err) => reject(new Error(`[RazorpayX] Network error: ${err.message}`)));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─────────────────────────────────────────────
// 1. Create Contact
//    One contact per host. Store razorpay_contact_id on BankAccount.
// ─────────────────────────────────────────────

export interface CreateContactParams {
  hostId:    string;
  name:      string;
  email?:    string;
  phone?:    string;
}

export async function createContact(params: CreateContactParams): Promise<RazorpayXContact> {
  const { hostId, name, email, phone } = params;

  logger.info({ msg: 'razorpay-x:create-contact', hostId });

  const contact = await razorpayXRequest<RazorpayXContact>({
    method: 'POST',
    path:   '/contacts',
    body: {
      name,
      ...(email ? { email } : {}),
      ...(phone ? { contact: phone.replace(/^\+/, '') } : {}), // strip leading +
      type:         'vendor',
      reference_id: hostId,
    },
  });

  logger.info({
    msg:       'razorpay-x:contact-created',
    hostId,
    contactId: contact.id,
  });

  return contact;
}

// ─────────────────────────────────────────────
// 2. Create Fund Account
//    Links bank account details to a Razorpay contact.
//    Store razorpay_fund_account_id on BankAccount.
// ─────────────────────────────────────────────

export interface CreateFundAccountParams {
  contactId:         string;
  accountHolderName: string;
  accountNumber:     string;   // plain text (decrypted before calling)
  ifscCode:          string;
}

export async function createFundAccount(
  params: CreateFundAccountParams
): Promise<RazorpayXFundAccount> {
  const { contactId, accountHolderName, accountNumber, ifscCode } = params;

  logger.info({ msg: 'razorpay-x:create-fund-account', contactId });

  const fa = await razorpayXRequest<RazorpayXFundAccount>({
    method: 'POST',
    path:   '/fund_accounts',
    body: {
      contact_id:   contactId,
      account_type: 'bank_account',
      bank_account: {
        name:           accountHolderName,
        ifsc:           ifscCode,
        account_number: accountNumber,
      },
    },
  });

  logger.info({
    msg:           'razorpay-x:fund-account-created',
    contactId,
    fundAccountId: fa.id,
  });

  return fa;
}

// ─────────────────────────────────────────────
// 3. Create Payout
//    Transfers money to the host's bank account.
//    Uses X-Payout-Idempotency to prevent duplicates.
// ─────────────────────────────────────────────

export type PayoutMode = 'IMPS' | 'NEFT' | 'RTGS';

export interface CreatePayoutParams {
  fundAccountId:  string;
  amountRupees:   number;   // will convert to paise internally
  idempotencyKey: string;   // stored on Payout row — passed as header
  mode?:          PayoutMode;
  narration?:     string;
}

export async function createPayout(params: CreatePayoutParams): Promise<RazorpayXPayout> {
  const {
    fundAccountId,
    amountRupees,
    idempotencyKey,
    mode      = 'IMPS',
    narration = 'JustPark Host Payout',
  } = params;

  if (!env.RAZORPAY_X_ACCOUNT_NUMBER) {
    throw new Error('RAZORPAY_X_ACCOUNT_NUMBER is not configured');
  }

  // Razorpay X expects amount in paise (₹1 = 100 paise)
  const amountPaise = Math.round(amountRupees * 100);

  logger.info({
    msg:           'razorpay-x:create-payout',
    fundAccountId,
    amountRupees,
    amountPaise,
    idempotencyKey,
    mode,
  });

  const payout = await razorpayXRequest<RazorpayXPayout>({
    method: 'POST',
    path:   '/payouts',
    body: {
      account_number:        env.RAZORPAY_X_ACCOUNT_NUMBER,
      fund_account_id:       fundAccountId,
      amount:                amountPaise,
      currency:              'INR',
      mode,
      purpose:               'payout',
      queue_if_low_balance:  true,
      narration,
    },
    idempotencyKey,
  });

  logger.info({
    msg:           'razorpay-x:payout-initiated',
    razorpayPayoutId: payout.id,
    status:        payout.status,
    fundAccountId,
  });

  return payout;
}

// ─────────────────────────────────────────────
// 4. Fetch Payout Status
//    Used by admin or background reconciliation to check current status.
// ─────────────────────────────────────────────

export async function getPayoutStatus(razorpayPayoutId: string): Promise<RazorpayXPayout> {
  return razorpayXRequest<RazorpayXPayout>({
    method: 'GET',
    path:   `/payouts/${razorpayPayoutId}`,
  });
}

// ─────────────────────────────────────────────
// 5. Activate / Deactivate Fund Account
//    Razorpay X allows disabling a fund account without deleting it.
// ─────────────────────────────────────────────

export async function setFundAccountActive(
  fundAccountId: string,
  active: boolean
): Promise<void> {
  await razorpayXRequest({
    method: 'PATCH',
    path:   `/fund_accounts/${fundAccountId}`,
    body:   { active },
  });
  logger.info({ msg: 'razorpay-x:fund-account-updated', fundAccountId, active });
}

// ─────────────────────────────────────────────
// 6. Webhook Signature Verification
//    Razorpay X signs webhooks with HMAC-SHA256 using RAZORPAY_X_WEBHOOK_SECRET.
//    Header: X-Razorpay-Signature
// ─────────────────────────────────────────────

export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signature: string
): boolean {
  if (!env.RAZORPAY_X_WEBHOOK_SECRET) {
    logger.warn('RAZORPAY_X_WEBHOOK_SECRET not set — skipping signature verification');
    return false;
  }

  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_X_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected,  'hex')
    );
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// 7. Map Razorpay X status → internal PayoutStatus
// ─────────────────────────────────────────────

export function mapRazorpayXStatus(
  rzpStatus: RazorpayXPayoutStatus
): 'requested' | 'processing' | 'completed' | 'failed' {
  switch (rzpStatus) {
    case 'queued':
    case 'pending':
    case 'processing':
      return 'processing';
    case 'processed':
      return 'completed';
    case 'cancelled':
    case 'rejected':
    case 'reversed':
    case 'failed':
      return 'failed';
    default:
      return 'processing';
  }
}
