import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { redis, RedisKeys } from '../../config/redis';
import { env } from '../../config/env';
import { requireStripe, requireRazorpay } from '../../config/payments';
import { isRazorpayXConfigured } from '../../services/razorpayXService';
import { AppError } from '../../middleware/errorHandler';
import { ErrorCode } from '../../types';
import { buildPaginationMeta } from '../../utils/pagination';
import { creditWallet, debitWallet, getOrCreateWallet } from '../../services/wallet';
import { logger } from '../../utils/logger';
import type {
  TopUpDto,
  TopUpConfirmDto,
  TopUpVerifyRazorpayDto,
  WalletTransactionQuery,
  WithdrawDto,
  AdminWalletAdjustDto,
} from './validators';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toPaise(amount: number): number {
  return Math.round(amount * 100);
}

// TTL for pending top-up state in Redis (2 hours)
const TOPUP_TTL_SECONDS = 7_200;

interface TopUpRedisValue {
  userId:   string;
  amount:   number;
  idemKey:  string;
  credited: boolean; // prevents double-credit
}

// ─────────────────────────────────────────────
// GET /wallet
// ─────────────────────────────────────────────
export async function getWallet(userId: string) {
  const wallet = await getOrCreateWallet(userId);
  return {
    id:               wallet.id,
    balance:          round2(Number(wallet.balance)),
    reserved_balance: round2(Number(wallet.reserved_balance)),
    currency:         wallet.currency,
    updated_at:       wallet.updated_at,
  };
}

// ─────────────────────────────────────────────
// POST /wallet/topup
// Creates a Stripe PaymentIntent or Razorpay order for the top-up amount.
// State stored in Redis; webhook or explicit confirm endpoint credits wallet.
// ─────────────────────────────────────────────
export async function createTopUpIntent(userId: string, dto: TopUpDto) {
  const { amount, gateway, idempotency_key } = dto;
  const topupAmount = round2(amount);
  const idemKey     = idempotency_key ?? crypto.randomUUID();

  if (gateway === 'stripe') {
    const stripeClient = requireStripe();

    const paymentIntent = await stripeClient.paymentIntents.create({
      amount:   toPaise(topupAmount),
      currency: 'inr',
      metadata: { purpose: 'wallet_topup', user_id: userId, idem_key: idemKey },
      automatic_payment_methods: { enabled: true },
    });

    // Store pending top-up in Redis
    const payload: TopUpRedisValue = { userId, amount: topupAmount, idemKey, credited: false };
    await redis.set(
      RedisKeys.walletTopup(paymentIntent.id),
      JSON.stringify(payload),
      'EX', TOPUP_TTL_SECONDS
    );

    return {
      topup_ref:       paymentIntent.id,
      client_secret:   paymentIntent.client_secret,
      amount:          topupAmount,
      currency:        'INR',
      gateway:         'stripe',
      idempotency_key: idemKey,
    };
  }

  // Razorpay
  const rzp = requireRazorpay();
  const order = await rzp.orders.create({
    amount:   toPaise(topupAmount),
    currency: 'INR',
    receipt:  `topup_${userId.slice(0, 8)}_${Date.now()}`,
    notes:    { purpose: 'wallet_topup', user_id: userId, idem_key: idemKey },
  });

  const payload: TopUpRedisValue = { userId, amount: topupAmount, idemKey, credited: false };
  await redis.set(
    RedisKeys.walletTopup(order.id),
    JSON.stringify(payload),
    'EX', TOPUP_TTL_SECONDS
  );

  return {
    topup_ref:         order.id,
    razorpay_order_id: order.id,
    amount:            topupAmount,
    currency:          'INR',
    gateway:           'razorpay',
    key_id:            env.RAZORPAY_KEY_ID,
    idempotency_key:   idemKey,
  };
}

// ─────────────────────────────────────────────
// Apply a pending top-up credit (shared logic for Stripe and Razorpay paths)
// Returns false if already credited (idempotent).
// ─────────────────────────────────────────────
export async function applyTopUpCredit(gatewayRef: string): Promise<{ applied: boolean; amount?: number; userId?: string }> {
  const key = RedisKeys.walletTopup(gatewayRef);
  const raw = await redis.get(key);
  if (!raw) return { applied: false };

  let payload: TopUpRedisValue;
  try {
    payload = JSON.parse(raw) as TopUpRedisValue;
  } catch {
    return { applied: false };
  }

  if (payload.credited) return { applied: false, amount: payload.amount, userId: payload.userId };

  // Mark as credited before the DB write to prevent double-credit under concurrent calls
  payload.credited = true;
  await redis.set(key, JSON.stringify(payload), 'EX', TOPUP_TTL_SECONDS);

  try {
    await creditWallet({
      userId:        payload.userId,
      amount:        payload.amount,
      type:          'top_up',
      referenceType: 'wallet_topup',
      description:   `Wallet top-up via payment gateway (ref: ${gatewayRef})`,
    });
  } catch {
    // Rollback — unmark credited flag so it can be retried
    payload.credited = false;
    await redis.set(key, JSON.stringify(payload), 'EX', TOPUP_TTL_SECONDS);
    throw AppError.badRequest(ErrorCode.INTERNAL_ERROR, 'Failed to credit wallet after payment');
  }

  // Clean up Redis key (TTL will handle it too, but explicit is cleaner)
  await redis.del(key);

  return { applied: true, amount: payload.amount, userId: payload.userId };
}

// ─────────────────────────────────────────────
// POST /wallet/topup/confirm  (Stripe — post-3DS)
// ─────────────────────────────────────────────
export async function confirmTopUpStripe(userId: string, dto: TopUpConfirmDto) {
  const piId = dto.payment_intent_id ?? dto.topup_ref;

  // Verify with Stripe that payment actually succeeded
  const stripeClient = requireStripe();
  const pi = await stripeClient.paymentIntents.retrieve(piId);

  if (pi.status !== 'succeeded') {
    throw AppError.conflict(
      ErrorCode.PAYMENT_FAILED,
      `Payment has not completed (Stripe status: ${pi.status})`
    );
  }

  // Verify the PI belongs to this user
  const meta = pi.metadata as Record<string, string>;
  if (meta.user_id !== userId) {
    throw AppError.badRequest(ErrorCode.FORBIDDEN, 'Payment intent does not belong to this user');
  }

  const result = await applyTopUpCredit(pi.id);

  if (!result.applied) {
    // Already credited — fetch current balance and return
    const wallet = await getWallet(userId);
    return { credited: false, already_credited: true, balance: wallet.balance };
  }

  const wallet = await getWallet(userId);
  return {
    credited:      true,
    amount_added:  result.amount,
    balance:       wallet.balance,
    currency:      'INR',
  };
}

// ─────────────────────────────────────────────
// POST /wallet/topup/verify  (Razorpay)
// ─────────────────────────────────────────────
export async function verifyTopUpRazorpay(userId: string, dto: TopUpVerifyRazorpayDto) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = dto;

  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    throw AppError.badRequest(ErrorCode.SERVICE_UNAVAILABLE, 'Razorpay is not configured');
  }

  // Verify HMAC-SHA256 signature
  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const isValid = crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(razorpay_signature, 'hex')
  );

  if (!isValid) {
    throw AppError.badRequest(ErrorCode.PAYMENT_FAILED, 'Invalid Razorpay payment signature');
  }

  const result = await applyTopUpCredit(razorpay_order_id);

  if (!result.applied) {
    const wallet = await getWallet(userId);
    return { credited: false, already_credited: true, balance: wallet.balance };
  }

  const wallet = await getWallet(userId);
  return {
    credited:      true,
    amount_added:  result.amount,
    balance:       wallet.balance,
    currency:      'INR',
  };
}

// ─────────────────────────────────────────────
// GET /wallet/transactions
// ─────────────────────────────────────────────
export async function getTransactionHistory(userId: string, query: WalletTransactionQuery) {
  const { type, from, to, page, limit } = query;
  const skip = (page - 1) * limit;

  // Find wallet first
  const wallet = await prisma.wallet.findUnique({
    where:  { user_id: userId },
    select: { id: true },
  });

  if (!wallet) {
    return { transactions: [], meta: buildPaginationMeta(0, page, limit) };
  }

  const where: Prisma.WalletTransactionWhereInput = { wallet_id: wallet.id };

  if (type) where.type = type;

  if (from || to) {
    where.created_at = {};
    if (from) where.created_at.gte = new Date(from);
    if (to)   where.created_at.lte = new Date(to);
  }

  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      select: {
        id:             true,
        type:           true,
        amount:         true,
        reference_type: true,
        reference_id:   true,
        description:    true,
        balance_after:  true,
        created_at:     true,
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  return { transactions, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// POST /wallet/withdraw
// Creates a payout request against a verified bank account.
//
// Safe flow (Option A — reserved_balance):
//   1. Lock wallet row (SELECT FOR UPDATE)
//   2. Check balance >= amount
//   3. Move amount: balance → reserved_balance (user can't re-spend it)
//   4. Create Payout record atomically in the same transaction
//   5. Record WalletTransaction for audit trail
//
// On payout success  → reserved_balance -= amount  (payoutProcessor.completePayout)
// On payout failure  → balance += amount, reserved_balance -= amount + refund tx
//                      (payoutProcessor.failPayout)
// ─────────────────────────────────────────────
export async function requestWithdrawal(userId: string, dto: WithdrawDto) {
  const { amount, bank_account_id } = dto;

  // Only hosts can have bank accounts per schema (bank_accounts.host_id)
  const bankAccount = await prisma.bankAccount.findFirst({
    where:  { id: bank_account_id, host_id: userId },
    select: { id: true, bank_name: true, is_verified: true, account_holder_name: true, razorpay_fund_account_id: true },
  });

  if (!bankAccount) throw AppError.notFound('Bank account');

  if (!bankAccount.is_verified) {
    throw AppError.conflict(
      ErrorCode.VALIDATION_ERROR,
      'Bank account is not verified. Please verify your bank account before requesting a withdrawal.'
    );
  }

  // Mirror the same check that requestPayout() applies — fail early rather than
  // letting the cron job discover the missing fund account ID at processing time.
  if (isRazorpayXConfigured() && !bankAccount.razorpay_fund_account_id) {
    throw AppError.conflict(
      ErrorCode.VALIDATION_ERROR,
      'Bank account has not been registered with the payout processor yet. ' +
      'Please contact support or ask an admin to re-verify the bank account.'
    );
  }

  // Prevent concurrent payouts for the same host — two in-flight payouts would
  // cause completePayout/failPayout to interfere with each other's wallet state.
  const inFlight = await prisma.payout.findFirst({
    where:  { host_id: userId, status: { in: ['requested', 'processing'] } },
    select: { id: true, status: true, amount: true },
  });
  if (inFlight) {
    throw AppError.conflict(
      ErrorCode.VALIDATION_ERROR,
      `A payout of ₹${Number(inFlight.amount).toFixed(2)} is already ${inFlight.status}. ` +
      `Wait for it to settle before requesting another withdrawal.`
    );
  }

  const withdrawAmount  = round2(amount);
  const idempotencyKey  = crypto.randomUUID();

  // Single atomic transaction: reserve balance + create payout + audit record.
  // If any step fails, the entire transaction rolls back — no money is lost.
  const payout = await prisma.$transaction(async (tx) => {
    // Lock the wallet row to prevent concurrent withdrawal races
    const wallets = await tx.$queryRaw<Array<{
      id: string;
      balance: string;
      reserved_balance: string;
    }>>`
      SELECT id, balance::text, reserved_balance::text
      FROM wallets
      WHERE user_id = ${userId}::uuid
      FOR UPDATE
    `;

    if (wallets.length === 0) {
      throw AppError.conflict(
        ErrorCode.INSUFFICIENT_WALLET_BALANCE,
        'Wallet not found. Please add funds to your wallet first.'
      );
    }

    const wallet      = wallets[0];
    const balance     = round2(Number(wallet.balance));

    if (balance < withdrawAmount) {
      throw AppError.conflict(
        ErrorCode.INSUFFICIENT_WALLET_BALANCE,
        `Insufficient balance. Available: ₹${balance.toFixed(2)}, Required: ₹${withdrawAmount.toFixed(2)}`
      );
    }

    const newBalance  = round2(balance - withdrawAmount);
    const newReserved = round2(Number(wallet.reserved_balance) + withdrawAmount);

    // Move amount from balance → reserved_balance
    await tx.wallet.update({
      where: { id: wallet.id },
      data:  { balance: newBalance, reserved_balance: newReserved },
    });

    // Create payout record inside the same transaction
    const created = await tx.payout.create({
      data: {
        host_id:         userId,
        amount:          withdrawAmount,
        bank_account_id,
        status:          'requested',
        idempotency_key: idempotencyKey,
      },
      select: {
        id:         true,
        amount:     true,
        status:     true,
        created_at: true,
        bank_account: { select: { bank_name: true, account_holder_name: true } },
      },
    });

    // Audit trail — ties wallet debit to the specific payout
    await tx.walletTransaction.create({
      data: {
        wallet_id:      wallet.id,
        type:           'withdrawal',
        amount:         withdrawAmount,
        reference_type: 'payout',
        reference_id:   created.id,
        description:    `Withdrawal to ${bankAccount.bank_name} — ${bankAccount.account_holder_name} (reserved pending transfer)`,
        balance_after:  newBalance,
      },
    });

    return created;
  });

  return {
    payout_id:  payout.id,
    amount:     withdrawAmount,
    status:     payout.status,
    bank:       payout.bank_account,
    message:    'Withdrawal request submitted. Processing within 2–3 business days.',
    created_at: payout.created_at,
  };
}

// ─────────────────────────────────────────────
// POST /admin/wallet/:userId/adjust
// ─────────────────────────────────────────────
export async function adminAdjustWallet(
  adminId:    string,
  targetUserId: string,
  dto:        AdminWalletAdjustDto
): Promise<{ balance: number; transaction_type: string; amount: number }> {
  // Verify target user exists
  const user = await prisma.user.findUnique({
    where:  { id: targetUserId },
    select: { id: true, first_name: true, last_name: true },
  });
  if (!user) throw AppError.notFound('User');

  let newBalance: number;

  if (dto.type === 'credit') {
    const result = await creditWallet({
      userId:        targetUserId,
      amount:        dto.amount,
      type:          'admin_credit',
      referenceType: 'admin',
      referenceId:   adminId,
      description:   dto.reason,
    });
    newBalance = result.newBalance;
  } else {
    const result = await debitWallet({
      userId:        targetUserId,
      amount:        dto.amount,
      type:          'admin_debit',
      referenceType: 'admin',
      referenceId:   adminId,
      description:   dto.reason,
    });
    newBalance = result.newBalance;
  }

  // Audit log
  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      `wallet.admin_${dto.type}`,
      entity_type: 'wallet',
      entity_id:   targetUserId,
      metadata: {
        amount:       dto.amount,
        reason:       dto.reason,
        new_balance:  newBalance,
        target_user:  `${user.first_name} ${user.last_name}`,
      },
    },
  }).catch((e) => logger.error(e, 'AUDIT_LOG_WRITE_FAILED'));

  return {
    balance:          newBalance,
    transaction_type: dto.type === 'credit' ? 'admin_credit' : 'admin_debit',
    amount:           dto.amount,
  };
}
