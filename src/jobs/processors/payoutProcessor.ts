import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { sendNotification } from '../../services/notification';
import { emitPayoutUpdate } from '../../socket/handlers';
import {
  isRazorpayXConfigured,
  createPayout,
  mapRazorpayXStatus,
  type RazorpayXPayoutStatus,
} from '../../services/razorpayXService';

// Type for a payout row with host + bank_account relations included
type PayoutWithRelations = Prisma.PayoutGetPayload<{
  include: {
    host:         { select: { id: true; first_name: true; email: true } };
    bank_account: {
      select: {
        id:                       true;
        account_holder_name:      true;
        account_number_encrypted: true;
        ifsc_code:                true;
        bank_name:                true;
        razorpay_fund_account_id: true;
      };
    };
  };
}>;

// ─────────────────────────────────────────────
// process-payouts
// Cron: daily at 2 AM
// Picks every payout in 'requested' state and submits it to Razorpay X.
// Idempotency key guarantees no duplicate bank transfers even if the cron
// fires more than once (Razorpay X returns the existing payout for the same key).
// ─────────────────────────────────────────────
export async function processPayouts(_job: Job): Promise<void> {
  const payouts = await prisma.payout.findMany({
    where: { status: 'requested' },
    include: {
      host:         { select: { id: true, first_name: true, email: true } },
      bank_account: {
        select: {
          id:                       true,
          account_holder_name:      true,
          account_number_encrypted: true,
          ifsc_code:                true,
          bank_name:                true,
          razorpay_fund_account_id: true,
        },
      },
    },
  });

  logger.info({ msg: 'process-payouts:start', total: payouts.length });

  for (const payout of payouts) {
    try {
      // ── Mark as processing immediately so the next cron run skips it
      await prisma.payout.update({
        where: { id: payout.id },
        data:  { status: 'processing' },
      });

      if (isRazorpayXConfigured()) {
        await processWithRazorpayX(payout);
      } else {
        // ── Fallback: manual / simulated mode
        // When Razorpay X is not configured (e.g. development / staging without
        // real bank credentials), we complete the payout synchronously here.
        // In production this branch should never be reached.
        logger.warn({
          msg:      'process-payouts:razorpay-x-not-configured',
          payoutId: payout.id,
          note:     'Completing payout manually (no real bank transfer)',
        });
        await completePayout(payout.id, payout.host.id, Number(payout.amount), null, null);
      }
    } catch (err) {
      logger.error({ err, payoutId: payout.id }, 'process-payouts: unexpected error');
      await failPayout(
        payout.id,
        payout.host.id,
        Number(payout.amount),
        `Unexpected error: ${(err as Error).message}`
      ).catch(() => {});
    }
  }

  logger.info({ msg: 'process-payouts:done', total: payouts.length });
}

// ─────────────────────────────────────────────
// Razorpay X path
// ─────────────────────────────────────────────
async function processWithRazorpayX(payout: PayoutWithRelations): Promise<void> {
  const { bank_account } = payout;

  // Fund account ID must exist — set when the bank account was added / admin verified
  if (!bank_account.razorpay_fund_account_id) {
    const reason = 'Bank account is not registered with Razorpay X (missing fund_account_id). ' +
                   'Ask an admin to verify the bank account and re-trigger registration.';
    logger.error({ msg: 'process-payouts:no-fund-account-id', payoutId: payout.id });
    await failPayout(payout.id, payout.host.id, Number(payout.amount), reason);
    return;
  }

  // Determine best transfer mode based on amount:
  //   IMPS: up to ₹2,00,000 — instant, 24×7
  //   NEFT: ₹2,00,001 – ₹10,00,000 — batch, business hours
  //   RTGS: ₹10,00,001+ — high-value, same-day
  const amount = Number(payout.amount);
  let mode: 'IMPS' | 'NEFT' | 'RTGS' = 'IMPS';
  if (amount > 1_000_000) mode = 'RTGS';
  else if (amount > 200_000) mode = 'NEFT';

  try {
    const rzpPayout = await createPayout({
      fundAccountId:  bank_account.razorpay_fund_account_id,
      amountRupees:   amount,
      idempotencyKey: payout.idempotency_key,
      mode,
      narration:      `JustPark Payout ${payout.id.slice(0, 8)}`,
    });

    // Map initial Razorpay X status → our internal status.
    // Most payouts land in 'queued' or 'processing' here — the webhook will
    // fire when the bank transfer actually settles ('processed') or fails.
    const internalStatus = mapRazorpayXStatus(
      rzpPayout.status as RazorpayXPayoutStatus
    );

    if (internalStatus === 'completed') {
      // Razorpay X returned 'processed' synchronously (rare, possible in test mode)
      await completePayout(
        payout.id,
        payout.host.id,
        amount,
        rzpPayout.id,
        rzpPayout.utr ?? null
      );
    } else if (internalStatus === 'failed') {
      await failPayout(
        payout.id,
        payout.host.id,
        amount,
        rzpPayout.failure_reason ?? 'Razorpay X rejected the payout',
        rzpPayout.id
      );
    } else {
      // 'processing' — normal path. Webhook will complete/fail later.
      await prisma.payout.update({
        where: { id: payout.id },
        data: {
          razorpay_payout_id: rzpPayout.id,
          status:             'processing',
        },
      });

      emitPayoutUpdate(payout.host.id, payout.id, 'processing', amount);

      logger.info({
        msg:              'process-payouts:submitted',
        payoutId:         payout.id,
        razorpayPayoutId: rzpPayout.id,
        rzpStatus:        rzpPayout.status,
        mode,
      });
    }
  } catch (err) {
    // Razorpay X API call itself failed (network error, bad credentials, etc.)
    const reason = `Razorpay X API error: ${(err as Error).message}`;
    logger.error({ err, payoutId: payout.id }, 'process-payouts:razorpay-x-error');
    await failPayout(payout.id, payout.host.id, amount, reason);
  }
}

// ─────────────────────────────────────────────
// Shared helpers — complete and fail
// ─────────────────────────────────────────────

export async function completePayout(
  payoutId:         string,
  hostId:           string,
  amount:           number,
  razorpayPayoutId: string | null,
  utr:              string | null
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.payout.update({
      where: { id: payoutId },
      data: {
        status:             'completed',
        processed_at:       new Date(),
        ...(razorpayPayoutId ? { razorpay_payout_id: razorpayPayoutId } : {}),
        ...(utr ? { utr } : {}),
      },
    });
    // Mark only the earnings that belong to THIS payout as paid_out.
    // Filtering by payout_id prevents cross-contamination when multiple payouts
    // exist for the same host (e.g. concurrent earnings + wallet payouts).
    await tx.hostEarning.updateMany({
      where: { payout_id: payoutId, status: 'on_hold' },
      data:  { status: 'paid_out' },
    });
    // Clear the wallet reservation only if one exists for this amount.
    // The conditional WHERE (reserved_balance >= amount) is a no-op for
    // earnings-based payouts (reserved_balance = 0) so it never corrupts the
    // wallet for a host who used the earnings path instead of the wallet path.
    await tx.$executeRaw`
      UPDATE wallets
      SET reserved_balance = reserved_balance - ${amount}::decimal
      WHERE user_id = ${hostId}::uuid
        AND reserved_balance >= ${amount}::decimal
    `;
  });

  await sendNotification(
    hostId,
    'payout_processed',
    'Payout Processed',
    `Your payout of ₹${amount.toFixed(2)} has been transferred to your bank account.${utr ? ` UTR: ${utr}` : ''}`,
    { payout_id: payoutId, amount, utr }
  ).catch(() => {});

  emitPayoutUpdate(hostId, payoutId, 'completed', amount);

  logger.info({ msg: 'payout-completed', payoutId, amount, utr });
}

export async function failPayout(
  payoutId:         string,
  hostId:           string,
  amount:           number,
  reason:           string,
  razorpayPayoutId?: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.payout.update({
      where: { id: payoutId },
      data: {
        status:         'failed',
        processed_at:   new Date(),
        failure_reason: reason,
        ...(razorpayPayoutId ? { razorpay_payout_id: razorpayPayoutId } : {}),
      },
    });
    // Restore only the earnings that belong to THIS payout; clear the FK so they
    // are no longer associated with any payout and can be selected again.
    await tx.hostEarning.updateMany({
      where: { payout_id: payoutId, status: 'on_hold' },
      data:  { status: 'available', payout_id: null },
    });
    // Restore the wallet reservation only if one exists for this amount.
    // The conditional WHERE (reserved_balance >= amount) means this UPDATE is a
    // no-op for earnings-based payouts (reserved_balance = 0), preventing an
    // accidental free credit to a host who never used the wallet withdrawal path.
    const updated = await tx.$queryRaw<Array<{ id: string; new_balance: string }>>`
      UPDATE wallets
      SET balance          = balance + ${amount}::decimal,
          reserved_balance = reserved_balance - ${amount}::decimal
      WHERE user_id = ${hostId}::uuid
        AND reserved_balance >= ${amount}::decimal
      RETURNING id, balance::text AS new_balance
    `;
    if (updated.length > 0) {
      // Create a refund wallet transaction so the user sees the money come back
      await tx.walletTransaction.create({
        data: {
          wallet_id:      updated[0].id,
          type:           'refund',
          amount,
          reference_type: 'payout',
          reference_id:   payoutId,
          description:    `Withdrawal refunded — payout failed: ${reason.slice(0, 200)}`,
          balance_after:  Math.round(Number(updated[0].new_balance) * 100) / 100,
        },
      });
    }
  });

  await sendNotification(
    hostId,
    'payout_processed',
    'Payout Failed',
    `Your payout of ₹${amount.toFixed(2)} could not be processed. ` +
    `Reason: ${reason}. Your earnings have been restored and you can request again.`,
    { payout_id: payoutId, amount, reason }
  ).catch(() => {});

  emitPayoutUpdate(hostId, payoutId, 'failed', amount);

  logger.warn({ msg: 'payout-failed', payoutId, amount, reason });
}

// ─────────────────────────────────────────────
// release-held-earnings
// Cron: daily
// Moves host_earnings from pending → available once the dispute window passes.
// ─────────────────────────────────────────────
export async function releaseHeldEarnings(_job: Job): Promise<void> {
  const now = new Date();

  const result = await prisma.hostEarning.updateMany({
    where: {
      status:       'pending',
      available_at: { lt: now, not: null },
    },
    data: { status: 'available' },
  });

  logger.info({ msg: 'release-held-earnings', released: result.count });
}

// ─────────────────────────────────────────────
// Job dispatcher
// ─────────────────────────────────────────────
export async function payoutJobDispatcher(job: Job): Promise<void> {
  switch (job.name) {
    case 'process-payouts':       return processPayouts(job);
    case 'release-held-earnings': return releaseHeldEarnings(job);
    default:
      logger.warn({ msg: 'Unknown payout job type', name: job.name });
  }
}
