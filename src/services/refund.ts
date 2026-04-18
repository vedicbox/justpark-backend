import crypto from 'crypto';
import { prisma } from '../config/database';
import { stripe } from '../config/payments';
import { AppError } from '../middleware/errorHandler';
import { ErrorCode } from '../types';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
export interface RefundResult {
  refund_id:          string;
  amount:             number;
  refund_to:          'original_method' | 'wallet';
  gateway_refund_ref: string | null;
  status:             'completed' | 'pending' | 'failed';
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function creditWallet(
  userId: string,
  amount: number,
  referenceId: string,
  description: string
): Promise<void> {
  if (amount <= 0) return;

  await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.upsert({
      where:  { user_id: userId },
      create: { user_id: userId, balance: 0, currency: 'INR' },
      update: {},
    });

    const newBalance = round2(Number(wallet.balance) + amount);
    await tx.wallet.update({
      where: { id: wallet.id },
      data:  { balance: newBalance },
    });
    await tx.walletTransaction.create({
      data: {
        wallet_id:      wallet.id,
        type:           'refund',
        amount,
        reference_type: 'booking',
        reference_id:   referenceId,
        description,
        balance_after:  newBalance,
      },
    });
  });
}

// ─────────────────────────────────────────────
// initiateRefund
//
// Finds the most-recent completed transaction for the booking,
// attempts a gateway refund, then falls back to wallet credit.
// Creates a Refund record in all cases.
// ─────────────────────────────────────────────
export async function initiateRefund(params: {
  transactionId: string;
  reason:        string;
  initiatedBy:   string;   // userId
  amountOverride?: number; // for partial refunds; defaults to full amount
  refundTo?:       'original_method' | 'wallet';
}): Promise<RefundResult> {
  const { transactionId, reason, initiatedBy, refundTo = 'original_method' } = params;

  // ── Load transaction ──────────────────────────────────────────────────────
  const tx = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: {
      id:             true,
      booking_id:     true,
      user_id:        true,
      amount:         true,
      currency:       true,
      gateway:        true,
      gateway_ref:    true,
      status:         true,
    },
  });

  if (!tx) throw AppError.notFound('Transaction');

  if (!['completed', 'partially_refunded'].includes(tx.status)) {
    throw AppError.conflict(
      ErrorCode.PAYMENT_FAILED,
      `Transaction is not in a refundable state (status: ${tx.status})`
    );
  }

  // ── Determine refund amount ───────────────────────────────────────────────
  const fullAmount = round2(Number(tx.amount));
  const priorRefunds = await prisma.refund.aggregate({
    where: {
      transaction_id: transactionId,
      status:         { not: 'failed' },
    },
    _sum: { amount: true },
  });
  const alreadyRefunded = round2(Number(priorRefunds._sum.amount ?? 0));
  const remainingRefundable = round2(fullAmount - alreadyRefunded);

  if (remainingRefundable <= 0) {
    throw AppError.conflict(
      ErrorCode.PAYMENT_FAILED,
      'Transaction has already been fully refunded'
    );
  }

  const refundAmount = params.amountOverride
    ? round2(Math.min(params.amountOverride, remainingRefundable))
    : remainingRefundable;

  if (refundAmount <= 0) {
    throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Refund amount must be greater than zero');
  }

  // ── Attempt gateway refund ───────────────────────────────────────────────
  let gatewayRefundRef: string | null = null;
  let refundStatus: 'completed' | 'pending' | 'failed' = 'pending';
  let actualRefundTo: 'original_method' | 'wallet' = refundTo;

  if (refundTo === 'original_method' && tx.gateway_ref) {
    try {
      if (tx.gateway === 'stripe' && stripe && tx.gateway_ref.startsWith('pi_')) {
        // Retrieve the PaymentIntent to find the charge
        const paymentIntent = await stripe.paymentIntents.retrieve(tx.gateway_ref);
        const chargeId = paymentIntent.latest_charge as string | null;

        if (chargeId) {
          const stripeRefund = await stripe.refunds.create({
            charge: chargeId,
            amount: Math.round(refundAmount * 100), // paise
            reason: 'requested_by_customer',
            metadata: { initiated_by: initiatedBy, reason },
          });
          gatewayRefundRef = stripeRefund.id;
          refundStatus = stripeRefund.status === 'succeeded' ? 'completed' : 'pending';
        } else {
          throw new Error('No charge found on PaymentIntent');
        }
      } else if (tx.gateway === 'razorpay' && tx.gateway_ref.startsWith('pay_')) {
        // Razorpay refunds via their REST API
        // The razorpay SDK's payments.refund() returns a Razorpay refund object
        const { razorpay: rzpClient } = await import('../config/payments');
        if (rzpClient) {
          const rzpRefund = await rzpClient.payments.refund(tx.gateway_ref, {
            amount: Math.round(refundAmount * 100),
            notes:  { reason, initiated_by: initiatedBy },
          });
          gatewayRefundRef = rzpRefund.id;
          refundStatus = rzpRefund.status === 'processed' ? 'completed' : 'pending';
        }
      }
    } catch {
      // Gateway refund failed — fall back to wallet
      actualRefundTo = 'wallet';
      refundStatus   = 'pending'; // will be completed via wallet below
    }
  } else {
    // Wallet refund requested (no gateway call)
    actualRefundTo = 'wallet';
  }

  // ── Wallet fallback / direct wallet credit ────────────────────────────────
  if (actualRefundTo === 'wallet') {
    await creditWallet(
      tx.user_id,
      refundAmount,
      tx.booking_id,
      reason || 'Refund credited to wallet'
    );
    refundStatus = 'completed';
  }

  // ── Create Refund record ──────────────────────────────────────────────────
  const refundRecord = await prisma.refund.create({
    data: {
      transaction_id:     transactionId,
      amount:             refundAmount,
      reason,
      status:             refundStatus,
      refund_to:          actualRefundTo,
      gateway_refund_ref: gatewayRefundRef,
      processed_at:       refundStatus === 'completed' ? new Date() : null,
    },
  });

  // ── Update transaction status ─────────────────────────────────────────────
  const refundedAfterThisCall = round2(alreadyRefunded + refundAmount);
  const isFullRefund = refundedAfterThisCall >= fullAmount - 0.01;
  await prisma.transaction.update({
    where: { id: transactionId },
    data: {
      status: isFullRefund ? 'refunded' : 'partially_refunded',
    },
  });

  // ── Audit log ─────────────────────────────────────────────────────────────
  await prisma.auditLog.create({
    data: {
      actor_id:    initiatedBy,
      action:      'payment.refund_initiated',
      entity_type: 'transaction',
      entity_id:   transactionId,
      metadata: {
        refund_id:          refundRecord.id,
        amount:             refundAmount,
        refund_to:          actualRefundTo,
        gateway_refund_ref: gatewayRefundRef,
        reason,
      },
    },
  }).catch(() => {/* non-critical */});

  return {
    refund_id:          refundRecord.id,
    amount:             refundAmount,
    refund_to:          actualRefundTo,
    gateway_refund_ref: gatewayRefundRef,
    status:             refundStatus,
  };
}

// ─────────────────────────────────────────────
// Verify HMAC-SHA256 (used for Razorpay webhooks)
// ─────────────────────────────────────────────
export function verifyHmacSha256(
  payload: Buffer | string,
  secret:  string,
  received: string
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received, 'hex')
    );
  } catch {
    return false;
  }
}
