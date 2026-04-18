import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import type { RazorpayXWebhookPayload } from '../../services/razorpayXService';
import { prisma } from '../../config/database';
import { emitBookingStatusChange } from '../../socket/handlers';
import { redis, RedisKeys } from '../../config/redis';
import { env } from '../../config/env';
import { requireStripe, requireRazorpay } from '../../config/payments';
import { AppError } from '../../middleware/errorHandler';
import { ErrorCode } from '../../types';
import { buildPaginationMeta } from '../../utils/pagination';
import { initiateRefund, verifyHmacSha256 } from '../../services/refund';
import { debitWallet } from '../../services/wallet';
import { applyTopUpCredit } from '../wallet/service';
import { notifyPaymentSuccess, notifyPaymentFailed, notifyBookingConfirmed } from '../../services/notification';
import { logger } from '../../utils/logger';
import { sendEmail, bookingConfirmationTemplate, hostNewBookingTemplate } from '../../services/emailService';
import type {
  CreatePaymentIntentDto,
  ConfirmPaymentDto,
  CreateRazorpayOrderDto,
  VerifyRazorpayDto,
  TransactionHistoryQuery,
  SavePaymentMethodDto,
  AdminRefundDto,
} from './validators';
import type { JwtPayload, PaymentMethod } from '../../types';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Convert decimal rupees to paise (Stripe/Razorpay expect smallest currency unit) */
function toPaise(amount: number): number {
  return Math.round(amount * 100);
}

async function markTransactionFailedIfTerminal(transactionId: string): Promise<void> {
  await prisma.transaction.updateMany({
    where: {
      id:     transactionId,
      status: { not: 'completed' },
    },
    data: { status: 'failed' },
  });
}

async function getReusableStripeTransaction(params: {
  userId: string;
  bookingId: string;
  paymentMethod: 'card' | 'upi' | 'net_banking' | 'wallet_card_split';
  walletAmount?: number;
}) {
  const where: Prisma.TransactionWhereInput = {
    user_id:        params.userId,
    booking_id:     params.bookingId,
    gateway:        'stripe',
    payment_method: params.paymentMethod,
    status:         { in: ['pending', 'processing'] },
  };

  if (params.paymentMethod === 'wallet_card_split' && typeof params.walletAmount === 'number') {
    where.metadata = {
      path:   ['wallet_amount'],
      equals: String(round2(params.walletAmount)),
    };
  }

  const transaction = await prisma.transaction.findFirst({
    where,
    orderBy: { created_at: 'desc' },
    select: {
      id:         true,
      booking_id: true,
      status:     true,
      gateway_ref: true,
      metadata:   true,
    },
  });

  if (!transaction?.gateway_ref) {
    return null;
  }

  const stripeClient = requireStripe();
  const paymentIntent = await stripeClient.paymentIntents.retrieve(transaction.gateway_ref);

  if (paymentIntent.status === 'succeeded') {
    await confirmBookingAfterPayment(transaction.booking_id, transaction.id, paymentIntent.id);
    return {
      transaction_id: transaction.id,
      gateway_ref:    transaction.gateway_ref,
      metadata:       transaction.metadata as Record<string, string> | null,
      payment_intent: paymentIntent,
    };
  }

  if (['requires_payment_method', 'requires_action', 'processing', 'requires_confirmation', 'requires_capture'].includes(paymentIntent.status)) {
    return {
      transaction_id: transaction.id,
      gateway_ref:    transaction.gateway_ref,
      metadata:       transaction.metadata as Record<string, string> | null,
      payment_intent: paymentIntent,
    };
  }

  if (['canceled'].includes(paymentIntent.status)) {
    await markTransactionFailedIfTerminal(transaction.id);
  }

  return null;
}

async function getReusableRazorpayTransaction(params: {
  userId: string;
  bookingId: string;
  paymentMethod: PaymentMethod;
}) {
  return prisma.transaction.findFirst({
    where: {
      user_id:        params.userId,
      booking_id:     params.bookingId,
      gateway:        'razorpay',
      payment_method: params.paymentMethod,
      status:         { in: ['pending', 'processing'] },
    },
    orderBy: { created_at: 'desc' },
    select: {
      id:       true,
      metadata: true,
    },
  });
}

// ─────────────────────────────────────────────
// Post-payment confirmation (shared)
// Updates transaction, booking state, and host earnings after a successful payment.
// ─────────────────────────────────────────────
export async function confirmBookingAfterPayment(
  bookingId:     string,
  transactionId: string,
  gatewayRef:    string
): Promise<void> {
  let shouldEmitConfirmed = false;
  let shouldRefundCancelledBooking = false;
  let shouldEmitPaymentSuccess: { userId: string, amount: number, spaceName: string } | null = null;

  await prisma.$transaction(async (tx) => {
    const [transaction, booking] = await Promise.all([
      tx.transaction.findUnique({
        where:  { id: transactionId },
        select: { status: true, user_id: true, amount: true },
      }),
      tx.booking.findUnique({
        where:  { id: bookingId },
        select: { status: true, base_price: true, total_price: true, space: { select: { host_id: true, instant_book: true, name: true } } },
      }),
    ]);

    if (!transaction) throw AppError.notFound('Transaction');
    if (!booking) throw AppError.notFound('Booking');

    // Never move a refunded transaction back to completed on duplicate webhooks.
    if (transaction.status === 'refunded' || transaction.status === 'partially_refunded') {
      await tx.transaction.update({
        where: { id: transactionId },
        data:  { gateway_ref: gatewayRef },
      });
      return;
    }

    if (transaction.status !== 'completed') {
      shouldEmitPaymentSuccess = {
        userId: transaction.user_id,
        amount: Number(transaction.amount),
        spaceName: booking.space?.name ?? 'your booked space',
      };
    }

    // Update transaction to completed
    await tx.transaction.update({
      where: { id: transactionId },
      data:  { status: 'completed', gateway_ref: gatewayRef },
    });

    // Confirm only instant-book bookings immediately after payment.
    // Approval-based bookings remain pending until the host explicitly approves
    // them, but the completed transaction still proves the booking is paid.
    if (booking.status === 'cancelled') {
      shouldRefundCancelledBooking = true;
      return;
    }

    const shouldAutoConfirm = Boolean(booking && booking.status === 'pending' && booking.space?.instant_book);
    if (shouldAutoConfirm) {
      await tx.booking.update({
        where: { id: bookingId },
        data:  { status: 'confirmed' },
      });
      shouldEmitConfirmed = true;
    }

    // Create host earnings only when the booking is actually confirmed.
    // Approval-based bookings get their earning row when the host approves.
    // Skipping for any other status (e.g. cancelled) prevents orphan earning
    // records when a late webhook fires after autoCancelUnconfirmed has run.
    if (booking && (booking.status === 'confirmed' || shouldAutoConfirm)) {
      const existingEarning = await tx.hostEarning.findUnique({ where: { booking_id: bookingId } });
      if (!existingEarning) {
        const basePrice       = Number(booking.base_price);
        const grossAmount     = round2(basePrice);
        const commissionAmount = 0; // Host receives 100% of base price
        const netAmount        = round2(basePrice);
        const availableAt      = new Date(Date.now() + env.DISPUTE_WINDOW_HOURS * 3_600_000);

        await tx.hostEarning.create({
          data: {
            host_id:           booking.space!.host_id,
            booking_id:        bookingId,
            gross_amount:      grossAmount,
            commission_amount: commissionAmount,
            net_amount:        netAmount,
            status:            'pending',
            available_at:      availableAt,
          },
        });
      }
    }
  });

  if (shouldRefundCancelledBooking) {
    await initiateRefund({
      transactionId,
      reason:      'Payment succeeded after the booking had already been cancelled',
      initiatedBy: 'system',
      refundTo:    'wallet',
    });
  }

  // Audit log (non-critical)
  await prisma.auditLog.create({
    data: {
      action:      'payment.confirmed',
      entity_type: 'transaction',
      entity_id:   transactionId,
      metadata:    { booking_id: bookingId, gateway_ref: gatewayRef },
    },
  }).catch((e) => logger.error(e, 'AUDIT_LOG_WRITE_FAILED'));

  // Real-time: only emit a booking-confirmed event when payment actually moved
  // the booking into a confirmed reservation.
  if (shouldEmitConfirmed) {
    const bookingForEmit = await prisma.booking.findUnique({
      where:  { id: bookingId },
      select: { user_id: true, space: { select: { host_id: true } } },
    }).catch(() => null);

    if (bookingForEmit) {
      emitBookingStatusChange(
        bookingForEmit.user_id,
        bookingForEmit.space!.host_id,
        bookingId,
        'confirmed',
        { gateway_ref: gatewayRef }
      );
    }
  }

  if (shouldEmitPaymentSuccess) {
    const payload = shouldEmitPaymentSuccess as { userId: string, amount: number, spaceName: string };
    notifyPaymentSuccess(payload.userId, bookingId, payload.amount).catch(() => {});
    if (shouldEmitConfirmed) {
      notifyBookingConfirmed(payload.userId, bookingId, payload.spaceName).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────
// Shared payment-failure cleanup
// Payment failures must not mutate booking status here.
// The booking-first flow keeps the booking pending until a valid user/system
// cancellation path handles it.
// ─────────────────────────────────────────────
async function failPendingBookingAfterPaymentFailure(params: {
  bookingId: string;
  failureReason: string;
  transactionId?: string;
}): Promise<void> {
  let paymentFailedUserId: string | null = null;

  if (params.transactionId) {
    const updated = await prisma.transaction.updateMany({
      where: {
        id:     params.transactionId,
        status: { not: 'completed' },
      },
      data: { status: 'failed' },
    });

    if (updated.count > 0) {
      const tx = await prisma.transaction.findUnique({
        where: { id: params.transactionId },
        select: { user_id: true }
      });
      if (tx) paymentFailedUserId = tx.user_id;
    }
  } else {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: { user_id: true }
    });
    if (booking) paymentFailedUserId = booking.user_id;
  }

  if (paymentFailedUserId) {
    notifyPaymentFailed(paymentFailedUserId, params.bookingId).catch(() => {});
  }
}

// ─────────────────────────────────────────────
// Wallet payment (no external gateway)
// ─────────────────────────────────────────────
async function processWalletPayment(userId: string, bookingId: string): Promise<{
  transaction_id: string;
  booking_id:     string;
  status:         string;
}> {
  const booking = await prisma.booking.findFirst({
    where:  { id: bookingId, user_id: userId },
    select: { id: true, base_price: true, total_price: true, status: true, space: { select: { host_id: true, instant_book: true } } },
  });
  if (!booking) throw AppError.notFound('Booking');

  if (booking.status !== 'pending') {
    throw AppError.conflict(ErrorCode.INVALID_BOOKING_STATE, `Booking cannot be paid in status '${booking.status}'`);
  }

  const totalPrice = round2(Number(booking.total_price));

  // Guard against double-charging: if a completed wallet transaction already
  // exists for this booking, return it immediately without touching the wallet.
  const existingWalletTx = await prisma.transaction.findFirst({
    where: { booking_id: bookingId, user_id: userId, payment_method: 'wallet', status: 'completed' },
    select: { id: true },
  });
  if (existingWalletTx) {
    return { transaction_id: existingWalletTx.id, booking_id: bookingId, status: 'completed' };
  }

  const idemKey    = generateScopedIdempotencyKey(userId, bookingId);

  // Check wallet balance
  const wallet = await prisma.wallet.findUnique({ where: { user_id: userId } });
  if (!wallet || Number(wallet.balance) < totalPrice) {
    await failPendingBookingAfterPaymentFailure({
      bookingId,
      failureReason: `Wallet payment failed: insufficient balance for booking ${bookingId}`,
    });
    throw AppError.conflict(
      ErrorCode.INSUFFICIENT_WALLET_BALANCE,
      `Insufficient wallet balance. Required: ₹${totalPrice}, Available: ₹${Number(wallet?.balance ?? 0)}`
    );
  }

  // Atomic: deduct wallet, create transaction, and only confirm/create earnings
  // for instant-book spaces. Approval-based spaces stay pending until host approval.
  let transactionId: string;
  await prisma.$transaction(async (tx) => {
    const newBalance = round2(Number(wallet.balance) - totalPrice);

    await tx.wallet.update({
      where: { id: wallet.id },
      data:  { balance: newBalance },
    });

    await tx.walletTransaction.create({
      data: {
        wallet_id:      wallet.id,
        type:           'payment',
        amount:         totalPrice,
        reference_type: 'booking',
        reference_id:   bookingId,
        description:    `Payment for booking ${bookingId}`,
        balance_after:  newBalance,
      },
    });

    const transaction = await tx.transaction.create({
      data: {
        booking_id:      bookingId,
        user_id:         userId,
        amount:          totalPrice,
        currency:        'INR',
        payment_method:  'wallet',
        status:          'completed',
        gateway:         'razorpay',   // label; no external gateway for wallet
        gateway_ref:     null,
        idempotency_key: idemKey,
        metadata:        { source: 'wallet' },
      },
    });
    transactionId = transaction.id;

    const shouldAutoConfirm = booking.status === 'pending' && booking.space?.instant_book;
    if (shouldAutoConfirm) {
      await tx.booking.update({
        where: { id: bookingId },
        data:  { status: 'confirmed' },
      });
    }

    if (shouldAutoConfirm || booking.status === 'confirmed') {
      const basePrice        = Number(booking.base_price);
      const grossAmount      = round2(basePrice);
      const commissionAmount = 0; // Host receives 100% of base price
      const netAmount        = round2(basePrice);

      await tx.hostEarning.upsert({
        where:  { booking_id: bookingId },
        create: {
          host_id:           booking.space!.host_id,
          booking_id:        bookingId,
          gross_amount:      grossAmount,
          commission_amount: commissionAmount,
          net_amount:        netAmount,
          status:            'pending',
          available_at:      new Date(Date.now() + env.DISPUTE_WINDOW_HOURS * 3_600_000),
        },
        update: {},
      });
    }
  });

  return { transaction_id: transactionId!, booking_id: bookingId, status: 'completed' };
}

// ─────────────────────────────────────────────
// POST /payments/intent  (Stripe)
// ─────────────────────────────────────────────
export async function createPaymentIntent(userId: string, dto: CreatePaymentIntentDto) {
  const { booking_id, payment_method, saved_method_id, idempotency_key } = dto;

  // Wallet-only payment: no Stripe involved
  if (payment_method === 'wallet') {
    return processWalletPayment(userId, booking_id);
  }

  // Verify booking ownership and state
  const booking = await prisma.booking.findFirst({
    where:  { id: booking_id, user_id: userId },
    select: { id: true, total_price: true, status: true },
  });
  if (!booking) throw AppError.notFound('Booking');

  if (booking.status !== 'pending') {
    throw AppError.conflict(ErrorCode.INVALID_BOOKING_STATE, `Booking cannot be paid in status '${booking.status}'`);
  }

  const totalPrice = round2(Number(booking.total_price));
  const idemKey    = idempotency_key ?? generateScopedIdempotencyKey(userId, booking_id);

  // ── Wallet+Card split payment ─────────────────────────────────────────────
  if (payment_method === 'wallet_card_split') {
    if (!dto.wallet_amount || dto.wallet_amount <= 0) {
      throw AppError.badRequest(
        ErrorCode.VALIDATION_ERROR,
        'wallet_amount is required and must be positive for wallet_card_split payment'
      );
    }

    const walletAmount = round2(dto.wallet_amount);
    const cardAmount   = round2(totalPrice - walletAmount);

    if (cardAmount <= 0) {
      throw AppError.badRequest(
        ErrorCode.VALIDATION_ERROR,
        'wallet_amount cannot cover the full booking amount. Use payment_method: "wallet" instead.'
      );
    }

    if (walletAmount >= totalPrice) {
      throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'wallet_amount must be less than total booking price');
    }

    const reusableTransaction = await getReusableStripeTransaction({
      userId,
      bookingId: booking_id,
      paymentMethod: 'wallet_card_split',
      walletAmount,
    });

    if (reusableTransaction) {
      const meta = reusableTransaction.metadata ?? {};
      return {
        transaction_id:   reusableTransaction.transaction_id,
        client_secret:    meta.client_secret ?? reusableTransaction.payment_intent.client_secret,
        wallet_amount:    walletAmount,
        card_amount:      cardAmount,
        total_amount:     totalPrice,
        idempotency_key:  idemKey,
        existing:         true,
      };
    }

    // IMPROVED FLOW: Create Stripe PI first, debit wallet only on success
    const stripeClient = requireStripe();
    let stripePaymentMethodId: string | undefined;
    if (saved_method_id) {
      const saved = await prisma.savedPaymentMethod.findFirst({
        where:  { id: saved_method_id, user_id: userId, gateway: 'stripe' },
        select: { token: true },
      });
      if (saved) stripePaymentMethodId = saved.token;
    }

    const piParams: Parameters<typeof stripeClient.paymentIntents.create>[0] = {
      amount:   toPaise(cardAmount),
      currency: 'inr',
      metadata: {
        booking_id:    booking_id,
        user_id:       userId,
        wallet_amount: String(walletAmount),
        card_amount:   String(cardAmount),
        total_amount:  String(totalPrice),
        split:         'true',
        idempotency_key: idemKey,
      },
      automatic_payment_methods: { enabled: true },
    };
    if (stripePaymentMethodId) {
      piParams.payment_method = stripePaymentMethodId;
    }

    // 1. Create Stripe PI first (no wallet debit yet)
    const paymentIntent = await stripeClient.paymentIntents.create(piParams);

    // 2. Store split context in Redis for atomic debit on payment success
    // This ensures wallet is only debited when payment actually succeeds
    await redis.set(
      RedisKeys.walletSplit(paymentIntent.id),
      JSON.stringify({
        userId,
        walletAmount,
        cardAmount,
        bookingId: booking_id,
        idempotencyKey: idemKey,
        createdAt: Date.now()
      }),
      'EX', 3_600 // 1 hour TTL
    );

    // 3. Create transaction record (amount = card portion only)
    const transaction = await prisma.transaction.create({
      data: {
        booking_id:      booking_id,
        user_id:         userId,
        amount:          cardAmount,
        currency:        'INR',
        payment_method:  'wallet_card_split',
        status:          'pending',
        gateway:         'stripe',
        gateway_ref:     paymentIntent.id,
        idempotency_key: idemKey,
        metadata: {
          client_secret: paymentIntent.client_secret,
          stripe_pi_id:  paymentIntent.id,
          wallet_amount: String(walletAmount),
          card_amount:   String(cardAmount),
          total_amount:  String(totalPrice),
          // Track that wallet debit is pending confirmation
          wallet_debit_pending: 'true',
        },
      },
    });

    return {
      transaction_id:   transaction.id,
      client_secret:    paymentIntent.client_secret,
      wallet_amount:    walletAmount,
      card_amount:      cardAmount,
      total_amount:     totalPrice,
      idempotency_key:  idemKey,
      existing:         false,
    };
  }

  // ── Standard card/UPI/net_banking via Stripe ──────────────────────────────
  // Idempotency check — return existing transaction if same key provided
  const existing = await prisma.transaction.findUnique({
    where: { idempotency_key: idemKey },
    select: { id: true, status: true, metadata: true, gateway_ref: true },
  });

  if (existing && existing.status !== 'failed') {
    const meta = existing.metadata as Record<string, string> | null;
    return {
      transaction_id:  existing.id,
      client_secret:   meta?.client_secret ?? null,
      idempotency_key: idemKey,
      existing:        true,
    };
  }

  const reusableTransaction = await getReusableStripeTransaction({
    userId,
    bookingId: booking_id,
    paymentMethod: payment_method,
  });

  if (reusableTransaction) {
    const meta = reusableTransaction.metadata ?? {};
    return {
      transaction_id:  reusableTransaction.transaction_id,
      client_secret:   meta.client_secret ?? reusableTransaction.payment_intent.client_secret ?? null,
      idempotency_key: idemKey,
      existing:        true,
    };
  }

  const stripeClient = requireStripe();

  // Resolve saved payment method token
  let stripePaymentMethodId: string | undefined;
  if (saved_method_id) {
    const saved = await prisma.savedPaymentMethod.findFirst({
      where:  { id: saved_method_id, user_id: userId, gateway: 'stripe' },
      select: { token: true },
    });
    if (saved) stripePaymentMethodId = saved.token;
  }

  // Create Stripe PaymentIntent
  const paymentIntentParams: Parameters<typeof stripeClient.paymentIntents.create>[0] = {
    amount:   toPaise(totalPrice),
    currency: 'inr',
    metadata: { booking_id, user_id: userId },
    automatic_payment_methods: { enabled: true },
  };

  if (stripePaymentMethodId) {
    paymentIntentParams.payment_method = stripePaymentMethodId;
    paymentIntentParams.confirm        = false;
  }

  const paymentIntent = await stripeClient.paymentIntents.create(paymentIntentParams);

  // Create transaction record
  const transaction = await prisma.transaction.create({
    data: {
      booking_id:      booking_id,
      user_id:         userId,
      amount:          totalPrice,
      currency:        'INR',
      payment_method:  payment_method,
      status:          'pending',
      gateway:         'stripe',
      gateway_ref:     paymentIntent.id,
      idempotency_key: idemKey,
      metadata:        { client_secret: paymentIntent.client_secret, stripe_pi_id: paymentIntent.id },
    },
  });

  return {
    transaction_id:   transaction.id,
    client_secret:    paymentIntent.client_secret,
    idempotency_key:  idemKey,
    existing:         false,
  };
}

// ─────────────────────────────────────────────
// POST /payments/confirm  (Stripe — post-3DS)
// ─────────────────────────────────────────────
export async function confirmPayment(userId: string, dto: ConfirmPaymentDto) {
  const transaction = await prisma.transaction.findFirst({
    where:  { id: dto.transaction_id, user_id: userId },
    select: { id: true, booking_id: true, status: true, gateway_ref: true, gateway: true },
  });
  if (!transaction) throw AppError.notFound('Transaction');

  // Already confirmed
  if (transaction.status === 'completed') {
    return { transaction_id: transaction.id, status: 'completed', already_confirmed: true };
  }

  if (transaction.status === 'failed') {
    throw AppError.conflict(ErrorCode.PAYMENT_FAILED, 'This payment has failed and cannot be confirmed');
  }

  // Reject any attempt to confirm a booking using a PI that does not belong to
  // this transaction. Without this guard, a user could pass a succeeded PI from
  // a previous (cheaper) booking to confirm a new unpaid booking.
  if (dto.payment_intent_id && transaction.gateway_ref && dto.payment_intent_id !== transaction.gateway_ref) {
    throw AppError.badRequest(
      ErrorCode.VALIDATION_ERROR,
      'payment_intent_id does not match this transaction'
    );
  }

  const piId = dto.payment_intent_id ?? transaction.gateway_ref;

  if (transaction.gateway === 'stripe' && piId) {
    const stripeClient = requireStripe();
    const pi = await stripeClient.paymentIntents.retrieve(piId);

    if (pi.status === 'succeeded') {
      await confirmBookingAfterPayment(transaction.booking_id, transaction.id, pi.id);
      const updated = await prisma.transaction.findUnique({
        where:  { id: transaction.id },
        select: { status: true },
      });
      return {
        transaction_id: transaction.id,
        status:         updated?.status ?? 'completed',
        already_confirmed: false,
      };
    }

    if (pi.status === 'requires_action' || pi.status === 'requires_payment_method') {
      return {
        transaction_id: transaction.id,
        status:         pi.status,
        client_secret:  pi.client_secret,
      };
    }

    // Payment failed on Stripe side
    await failPendingBookingAfterPaymentFailure({
      bookingId:      transaction.booking_id,
      transactionId:  transaction.id,
      failureReason:  `Stripe payment not completed (status: ${pi.status})`,
    });
    throw AppError.conflict(ErrorCode.PAYMENT_FAILED, `Payment not completed (Stripe status: ${pi.status})`);
  }

  return { transaction_id: transaction.id, status: transaction.status };
}

// ─────────────────────────────────────────────
// POST /payments/razorpay/order
// ─────────────────────────────────────────────
export async function createRazorpayOrder(userId: string, dto: CreateRazorpayOrderDto) {
  const { booking_id, payment_method, idempotency_key } = dto;

  const booking = await prisma.booking.findFirst({
    where:  { id: booking_id, user_id: userId },
    select: { id: true, total_price: true, status: true },
  });
  if (!booking) throw AppError.notFound('Booking');

  if (booking.status !== 'pending') {
    throw AppError.conflict(ErrorCode.INVALID_BOOKING_STATE, `Booking cannot be paid in status '${booking.status}'`);
  }

  const totalPrice = round2(Number(booking.total_price));
  const idemKey    = idempotency_key ?? generateScopedIdempotencyKey(userId, booking_id);

  // Idempotency check
  const existing = await prisma.transaction.findUnique({
    where: { idempotency_key: idemKey },
    select: { id: true, status: true, metadata: true },
  });

  if (existing && existing.status !== 'failed') {
    const meta = existing.metadata as Record<string, string> | null;
    return {
      transaction_id:      existing.id,
      razorpay_order_id:   meta?.razorpay_order_id ?? null,
      amount:              totalPrice,
      currency:            'INR',
      idempotency_key:     idemKey,
      key_id:              env.RAZORPAY_KEY_ID,
      existing:            true,
    };
  }

  const reusableTransaction = await getReusableRazorpayTransaction({
    userId,
    bookingId: booking_id,
    paymentMethod: payment_method,
  });

  if (reusableTransaction) {
    const meta = reusableTransaction.metadata as Record<string, string> | null;
    return {
      transaction_id:      reusableTransaction.id,
      razorpay_order_id:   meta?.razorpay_order_id ?? null,
      amount:              totalPrice,
      currency:            'INR',
      idempotency_key:     idemKey,
      key_id:              env.RAZORPAY_KEY_ID,
      existing:            true,
    };
  }

  const rzp = requireRazorpay();

  // Create Razorpay order
  const order = await rzp.orders.create({
    amount:   toPaise(totalPrice),
    currency: 'INR',
    receipt:  booking_id,
    notes:    { booking_id, user_id: userId },
  });

  const transaction = await prisma.transaction.create({
    data: {
      booking_id:      booking_id,
      user_id:         userId,
      amount:          totalPrice,
      currency:        'INR',
      payment_method:  payment_method,
      status:          'pending',
      gateway:         'razorpay',
      gateway_ref:     order.id,
      idempotency_key: idemKey,
      metadata:        { razorpay_order_id: order.id },
    },
  });

  return {
    transaction_id:    transaction.id,
    razorpay_order_id: order.id,
    amount:            totalPrice,
    currency:          'INR',
    idempotency_key:   idemKey,
    key_id:            env.RAZORPAY_KEY_ID,
    existing:          false,
  };
}

// ─────────────────────────────────────────────
// POST /payments/razorpay/verify
// ─────────────────────────────────────────────
export async function verifyRazorpayPayment(userId: string, dto: VerifyRazorpayDto) {
  const { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = dto;

  // Verify signature: HMAC-SHA256 of "order_id|payment_id"
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    throw AppError.badRequest(ErrorCode.SERVICE_UNAVAILABLE, 'Razorpay is not configured');
  }

  const expectedSig = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const isValid = crypto.timingSafeEqual(
    Buffer.from(expectedSig, 'hex'),
    Buffer.from(razorpay_signature, 'hex')
  );

  if (!isValid) {
    throw AppError.badRequest(ErrorCode.PAYMENT_FAILED, 'Invalid Razorpay payment signature');
  }

  // Find the transaction by razorpay_order_id (stored in gateway_ref)
  const transaction = await prisma.transaction.findFirst({
    where: { gateway_ref: razorpay_order_id, user_id: userId, booking_id },
    select: { id: true, booking_id: true, status: true },
  });

  if (!transaction) throw AppError.notFound('Transaction for this Razorpay order');

  if (transaction.status === 'completed') {
    return { transaction_id: transaction.id, status: 'completed', already_confirmed: true };
  }

  await confirmBookingAfterPayment(transaction.booking_id, transaction.id, razorpay_payment_id);

  const updated = await prisma.transaction.findUnique({
    where:  { id: transaction.id },
    select: { status: true },
  });

  try {
    const booking = await prisma.booking.findUnique({
      where: { id: transaction.booking_id },
      include: {
        user: true,
        space: { include: { host: true } }
      }
    });

    if (booking && booking.status === 'confirmed') {
      const { user, space } = booking;
      const host = space.host;

      // Send confirmation email to user
      try {
        console.log('Sending confirmation email to:', user.email);
        const userTemplate = bookingConfirmationTemplate({
          firstName: user.first_name,
          bookingId: booking.id,
          spaceName: space.name,
          address: (space as any).address || space.name,
          startTime: new Date(booking.start_time).toLocaleString(),
          endTime: new Date(booking.end_time).toLocaleString(),
          totalPrice: Number(booking.total_price),
          currency: 'INR'
        });
        await sendEmail({
          to: user.email,
          ...userTemplate
        });
      } catch (err) {
        logger.error({ msg: 'Failed to send user confirmation email', err, bookingId: booking.id });
      }

      // Send notification email to host
      try {
        console.log('Sending host email to:', host.email);
        const hostTemplate = hostNewBookingTemplate({ host, booking, space, user });
        await sendEmail({
          to: host.email,
          ...hostTemplate
        });
      } catch (err) {
        logger.error({ msg: 'Failed to send host notification email', err, bookingId: booking.id });
      }
    }
  } catch (err) {
    logger.error({ msg: 'Failed to fetch booking for notification emails', err });
  }

  return {
    transaction_id: transaction.id,
    status:         updated?.status ?? 'completed',
    already_confirmed: false,
  };
}

// ─────────────────────────────────────────────
// POST /payments/webhook/stripe
// ─────────────────────────────────────────────
export async function handleStripeWebhook(rawBody: Buffer, signature: string): Promise<void> {
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return; // silently ignore if not configured

  const stripeClient = requireStripe();

  let event: ReturnType<typeof stripeClient.webhooks.constructEvent>;
  try {
    event = stripeClient.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    throw AppError.badRequest(ErrorCode.PAYMENT_FAILED, 'Invalid Stripe webhook signature');
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      const meta = pi.metadata as Record<string, string>;

      // Wallet top-up payment — credit wallet via Redis state
      if (meta.purpose === 'wallet_topup') {
        await applyTopUpCredit(pi.id).catch(() => {});
        break;
      }

      const bookingId = meta.booking_id;
      if (!bookingId) break;

      const transaction = await prisma.transaction.findFirst({
        where: { gateway_ref: pi.id },
        select: { id: true, booking_id: true, status: true, metadata: true },
      });

      if (transaction && transaction.status !== 'completed') {
        // IMPROVED: Handle wallet+card split payment atomically
        const txMeta = transaction.metadata as Record<string, any> | null;
        if (txMeta?.wallet_debit_pending === 'true') {
          // Atomic wallet debit + booking confirmation in transaction
          await prisma.$transaction(async () => {
            // 1. Debit wallet (only now, after payment success)
            const walletAmount = parseFloat(meta.wallet_amount || '0');
            if (walletAmount > 0) {
              await debitWallet({
                userId: meta.user_id,
                amount: walletAmount,
                type: 'payment',
                referenceType: 'booking',
                referenceId: bookingId,
                description: `Wallet portion of split payment for booking ${bookingId}`,
              });
            }

            // 2. Confirm booking and update transaction
            await confirmBookingAfterPayment(transaction.booking_id, transaction.id, pi.id);
          });

          // 3. Clean up Redis state
          await redis.del(RedisKeys.walletSplit(pi.id));
        } else {
          // Standard payment (no wallet involved)
          await confirmBookingAfterPayment(transaction.booking_id, transaction.id, pi.id);
        }
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      const transactions = await prisma.transaction.findMany({
        where: {
          gateway_ref: pi.id,
          status:      { not: 'completed' },
        },
        select: { id: true, booking_id: true },
      });

      await Promise.all(transactions.map((transaction) => failPendingBookingAfterPaymentFailure({
        bookingId:     transaction.booking_id,
        transactionId: transaction.id,
        failureReason: `Stripe payment failed for PaymentIntent ${pi.id}`,
      })));

      // IMPROVED: No wallet reversal needed since wallet was never debited
      // Just clean up Redis state for failed split payments
      const splitRaw = await redis.get(RedisKeys.walletSplit(pi.id));
      if (splitRaw) {
        // Log for monitoring but don't reverse (wallet never debited)
        try {
          const split = JSON.parse(splitRaw) as any;
          // Could add monitoring/alerting here for failed split payments
          console.warn(`Split payment failed for booking ${split.bookingId}, wallet was not debited`);
        } catch {
          // Ignore parsing errors
        }
        await redis.del(RedisKeys.walletSplit(pi.id));
      }
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object;
      // Update refund record if gateway_refund_ref matches
      const refundObj = charge.refunds?.data?.[0];
      if (refundObj?.id) {
        await prisma.refund.updateMany({
          where: { gateway_refund_ref: refundObj.id, status: { not: 'completed' } },
          data:  { status: 'completed', processed_at: new Date() },
        });
      }
      break;
    }

    default:
      // Ignore other event types
      break;
  }
}

// ─────────────────────────────────────────────
// Fallback recovery for stuck split payments
// Call this periodically (e.g., every 5 minutes) to recover payments
// where webhook was missed or delayed
// ─────────────────────────────────────────────
export async function recoverStuckSplitPayments(): Promise<void> {
  const stripeClient = requireStripe();

  // Find all split payment transactions that are still pending
  // but were created more than 5 minutes ago (webhook should have arrived)
  const stuckTransactions = await prisma.transaction.findMany({
    where: {
      payment_method: 'wallet_card_split',
      status: 'pending',
      created_at: {
        lt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
      },
      metadata: {
        path: ['wallet_debit_pending'],
        equals: 'true',
      },
    },
    select: {
      id: true,
      gateway_ref: true,
      booking_id: true,
      metadata: true,
    },
  });

  for (const tx of stuckTransactions) {
    try {
      const meta = tx.metadata as Record<string, any>;
      const piId = meta?.stripe_pi_id;

      if (!piId) continue;

      // Check actual Stripe PI status
      const pi = await stripeClient.paymentIntents.retrieve(piId);

      if (pi.status === 'succeeded') {
        // Payment actually succeeded, process it
        await prisma.$transaction(async () => {
          const walletAmount = parseFloat(meta?.wallet_amount || '0');
          if (walletAmount > 0) {
            await debitWallet({
              userId: meta?.user_id,
              amount: walletAmount,
              type: 'payment',
              referenceType: 'booking',
              referenceId: tx.booking_id,
              description: `Wallet portion of split payment for booking ${tx.booking_id} (recovered)`,
            });
          }
          await confirmBookingAfterPayment(tx.booking_id, tx.id, piId);
        });
        await redis.del(RedisKeys.walletSplit(piId));

      } else if (['canceled', 'payment_failed'].includes(pi.status)) {
        await failPendingBookingAfterPaymentFailure({
          bookingId:     tx.booking_id,
          transactionId: tx.id,
          failureReason: `Recovered Stripe split payment failed (status: ${pi.status})`,
        });
        await redis.del(RedisKeys.walletSplit(piId));
      }
      // If still processing, leave it for next recovery run

    } catch (error) {
      // Log error but continue processing other transactions
      console.error(`Failed to recover split payment ${tx.id}:`, error);
    }
  }
}

// ─────────────────────────────────────────────
// Enhanced idempotency with user+booking scoping
// ─────────────────────────────────────────────
function generateScopedIdempotencyKey(userId: string, bookingId: string, timestamp = Date.now()): string {
  // Include user and booking to prevent cross-user conflicts
  const data = `${userId}:${bookingId}:${Math.floor(timestamp / 1000)}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ─────────────────────────────────────────────
// POST /payments/webhook/razorpay
// ─────────────────────────────────────────────
export async function handleRazorpayWebhook(rawBody: Buffer, signature: string): Promise<void> {
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) return;

  const isValid = verifyHmacSha256(rawBody, webhookSecret, signature);
  if (!isValid) {
    throw AppError.badRequest(ErrorCode.PAYMENT_FAILED, 'Invalid Razorpay webhook signature');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return;
  }

  const event   = payload.event as string;
  const payData = (payload.payload as Record<string, unknown> | undefined)?.payment as Record<string, unknown> | undefined;
  const entity  = payData?.entity as Record<string, unknown> | undefined;

  if (!entity) return;

  switch (event) {
    case 'payment.captured': {
      const paymentId = entity.id as string;
      const orderId   = entity.order_id as string;
      const notes     = entity.notes as Record<string, string> | undefined;

      // Wallet top-up payment — credit wallet via Redis state
      if (notes?.purpose === 'wallet_topup') {
        await applyTopUpCredit(orderId).catch(() => {});
        break;
      }

      const transaction = await prisma.transaction.findFirst({
        where: { gateway_ref: orderId },
        select: { id: true, booking_id: true, status: true },
      });

      if (transaction && transaction.status !== 'completed') {
        await confirmBookingAfterPayment(transaction.booking_id, transaction.id, paymentId);
        // Update gateway_ref from order_id → payment_id for refund purposes
        await prisma.transaction.update({
          where: { id: transaction.id },
          data:  { gateway_ref: paymentId },
        });
      }
      break;
    }

    case 'payment.failed': {
      const orderId = entity.order_id as string;
      const transactions = await prisma.transaction.findMany({
        where: {
          gateway_ref: orderId,
          status:      { not: 'completed' },
        },
        select: { id: true, booking_id: true },
      });

      await Promise.all(transactions.map((transaction) => failPendingBookingAfterPaymentFailure({
        bookingId:     transaction.booking_id,
        transactionId: transaction.id,
        failureReason: `Razorpay payment failed for order ${orderId}`,
      })));
      break;
    }

    case 'refund.processed': {
      const refundData   = (payload.payload as Record<string, unknown>)?.refund as Record<string, unknown> | undefined;
      const refundEntity = refundData?.entity as Record<string, unknown> | undefined;
      if (refundEntity?.id) {
        await prisma.refund.updateMany({
          where: { gateway_refund_ref: refundEntity.id as string, status: { not: 'completed' } },
          data:  { status: 'completed', processed_at: new Date() },
        });
      }
      break;
    }

    default:
      break;
  }
}

// ─────────────────────────────────────────────
// GET /payments/history
// ─────────────────────────────────────────────
export async function getTransactionHistory(actor: JwtPayload, query: TransactionHistoryQuery) {
  const { user_id, status, from, to, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.TransactionWhereInput = {};

  if (actor.role === 'admin') {
    if (user_id) {
      where.user_id = user_id;
    }
  } else {
    where.user_id = actor.sub;
  }

  if (status) where.status = status;

  if (from || to) {
    where.created_at = {};
    if (from) where.created_at.gte = new Date(from);
    if (to)   where.created_at.lte = new Date(to);
  }

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      select: {
        id:              true,
        booking_id:      true,
        amount:          true,
        currency:        true,
        payment_method:  true,
        status:          true,
        gateway:         true,
        gateway_ref:     true,
        idempotency_key: true,
        created_at:      true,
        updated_at:      true,
        booking: {
          select: {
            id:         true,
            start_time: true,
            end_time:   true,
            space: { select: { id: true, name: true, address_line1: true } },
          },
        },
        refunds: {
          select: { id: true, amount: true, status: true, refund_to: true, processed_at: true },
        },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.transaction.count({ where }),
  ]);

  return { transactions, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// GET /payments/methods
// ─────────────────────────────────────────────
export async function listPaymentMethods(userId: string) {
  return prisma.savedPaymentMethod.findMany({
    where:   { user_id: userId },
    select:  { id: true, gateway: true, card_last_four: true, card_brand: true, is_default: true, created_at: true },
    orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
  });
}

// ─────────────────────────────────────────────
// POST /payments/methods
// ─────────────────────────────────────────────
export async function savePaymentMethod(userId: string, dto: SavePaymentMethodDto) {
  return prisma.$transaction(async (tx) => {
    // If setting as default, unset existing default
    if (dto.is_default) {
      await tx.savedPaymentMethod.updateMany({
        where: { user_id: userId, is_default: true },
        data:  { is_default: false },
      });
    }

    return tx.savedPaymentMethod.create({
      data: {
        user_id:        userId,
        gateway:        dto.gateway,
        token:          dto.token,
        card_last_four: dto.card_last_four,
        card_brand:     dto.card_brand,
        is_default:     dto.is_default,
      },
      select: { id: true, gateway: true, card_last_four: true, card_brand: true, is_default: true, created_at: true },
    });
  });
}

// ─────────────────────────────────────────────
// DELETE /payments/methods/:id
// ─────────────────────────────────────────────
export async function deletePaymentMethod(userId: string, methodId: string): Promise<void> {
  const method = await prisma.savedPaymentMethod.findFirst({
    where: { id: methodId, user_id: userId },
  });
  if (!method) throw AppError.notFound('Payment method');

  await prisma.savedPaymentMethod.delete({ where: { id: methodId } });

  // If it was the default, promote the next one
  if (method.is_default) {
    const next = await prisma.savedPaymentMethod.findFirst({
      where:   { user_id: userId },
      orderBy: { created_at: 'asc' },
    });
    if (next) {
      await prisma.savedPaymentMethod.update({
        where: { id: next.id },
        data:  { is_default: true },
      });
    }
  }
}

// ─────────────────────────────────────────────
// POST /payments/webhook/razorpay-x
// Handles Razorpay X payout lifecycle events.
// completePayout / failPayout mirror the logic in payoutProcessor.ts
// but are triggered async via webhook rather than the cron path.
// ─────────────────────────────────────────────
export async function handleRazorpayXWebhook(rawBody: Buffer, signature: string): Promise<void> {
  const { verifyWebhookSignature, mapRazorpayXStatus } = await import('../../services/razorpayXService');
  const { logger }          = await import('../../utils/logger');
  const { sendNotification } = await import('../../services/notification');
  const { emitPayoutUpdate } = await import('../../socket/handlers');

  const webhookSecret = env.RAZORPAY_X_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.warn('RAZORPAY_X_WEBHOOK_SECRET not set — skipping X webhook');
    return;
  }

  const isValid = verifyWebhookSignature(rawBody, signature);
  if (!isValid) {
    throw AppError.badRequest(ErrorCode.PAYMENT_FAILED, 'Invalid Razorpay X webhook signature');
  }

  let payload: RazorpayXWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as RazorpayXWebhookPayload;
  } catch {
    return;
  }

  const event    = payload.event;
  const rzpPayout = payload.payload?.payout?.entity;
  if (!rzpPayout) return;

  const internalStatus = mapRazorpayXStatus(rzpPayout.status);

  logger.info({ msg: 'razorpay-x-webhook', event, rzpPayoutId: rzpPayout.id, internalStatus });

  // Look up our payout record by Razorpay payout ID
  const payout = await prisma.payout.findFirst({
    where:   { razorpay_payout_id: rzpPayout.id },
    include: {
      host: { select: { id: true, first_name: true, email: true } },
    },
  });

  if (!payout) {
    // Payout was just submitted and the DB hasn't been updated yet — or unknown ID.
    // Razorpay X will retry; log and return 200 (handled at controller level).
    logger.warn({ msg: 'razorpay-x-webhook:payout-not-found', rzpPayoutId: rzpPayout.id });
    return;
  }

  const amount = Number(payout.amount);

  switch (event) {
    case 'payout.initiated': {
      // Already in 'processing' state from the cron — just keep it there
      await prisma.payout.update({
        where: { id: payout.id },
        data:  { status: 'processing' },
      });
      emitPayoutUpdate(payout.host.id, payout.id, 'processing', amount);
      break;
    }

    case 'payout.processed': {
      if (payout.status === 'completed') break; // idempotent

      await prisma.$transaction(async (tx) => {
        await tx.payout.update({
          where: { id: payout.id },
          data: {
            status:       'completed',
            processed_at: new Date(),
            utr:          rzpPayout.utr ?? null,
          },
        });
        // Use payout_id filter — prevents marking earnings from a different
        // concurrent payout as paid_out (mirrors cron-path completePayout).
        await tx.hostEarning.updateMany({
          where: { payout_id: payout.id, status: 'on_hold' },
          data:  { status: 'paid_out' },
        });
        // Clear wallet reservation. Conditional WHERE is a no-op for
        // earnings-based payouts (reserved_balance = 0).
        await tx.$executeRaw`
          UPDATE wallets
          SET reserved_balance = reserved_balance - ${amount}::decimal
          WHERE user_id = ${payout.host.id}::uuid
            AND reserved_balance >= ${amount}::decimal
        `;
      });

      await sendNotification(
        payout.host.id,
        'payout_processed',
        'Payout Processed',
        `Your payout of ₹${amount.toFixed(2)} has been transferred to your bank account.` +
          (rzpPayout.utr ? ` UTR: ${rzpPayout.utr}` : ''),
        { payout_id: payout.id, amount, utr: rzpPayout.utr }
      ).catch(() => {});

      emitPayoutUpdate(payout.host.id, payout.id, 'completed', amount);
      logger.info({ msg: 'razorpay-x-webhook:payout-completed', payoutId: payout.id, utr: rzpPayout.utr });
      break;
    }

    case 'payout.reversed':
    case 'payout.failed': {
      if (payout.status === 'failed') break; // idempotent

      const reason = rzpPayout.failure_reason ?? `Payout ${event} by Razorpay X`;

      await prisma.$transaction(async (tx) => {
        await tx.payout.update({
          where: { id: payout.id },
          data: {
            status:         'failed',
            failure_reason: reason,
          },
        });
        // Restore only the earnings tied to this payout; clear the FK so they
        // can be selected for the next payout request (mirrors cron failPayout).
        await tx.hostEarning.updateMany({
          where: { payout_id: payout.id, status: 'on_hold' },
          data:  { status: 'available', payout_id: null },
        });
        // Restore wallet balance only if a reservation exists for this amount.
        // Conditional WHERE prevents a free credit for earnings-based payouts.
        const restored = await tx.$queryRaw<Array<{ id: string; new_balance: string }>>`
          UPDATE wallets
          SET balance          = balance + ${amount}::decimal,
              reserved_balance = reserved_balance - ${amount}::decimal
          WHERE user_id = ${payout.host.id}::uuid
            AND reserved_balance >= ${amount}::decimal
          RETURNING id, balance::text AS new_balance
        `;
        if (restored.length > 0) {
          await tx.walletTransaction.create({
            data: {
              wallet_id:      restored[0].id,
              type:           'refund',
              amount,
              reference_type: 'payout',
              reference_id:   payout.id,
              description:    `Withdrawal refunded — payout failed: ${reason.slice(0, 200)}`,
              balance_after:  Math.round(Number(restored[0].new_balance) * 100) / 100,
            },
          });
        }
      });

      await sendNotification(
        payout.host.id,
        'payout_processed',
        'Payout Failed',
        `Your payout of ₹${amount.toFixed(2)} could not be processed. ` +
          `Reason: ${reason}. Your earnings have been restored and you can request again.`,
        { payout_id: payout.id, amount, reason }
      ).catch(() => {});

      emitPayoutUpdate(payout.host.id, payout.id, 'failed', amount);
      logger.warn({ msg: 'razorpay-x-webhook:payout-failed', payoutId: payout.id, reason });
      break;
    }

    default:
      logger.info({ msg: 'razorpay-x-webhook:unhandled-event', event });
      break;
  }
}

// ─────────────────────────────────────────────
// POST /admin/transactions/:id/refund
// ─────────────────────────────────────────────
export async function adminInitiateRefund(adminId: string, transactionId: string, dto: AdminRefundDto) {
  const { initiateRefund } = await import('../../services/refund');

  return initiateRefund({
    transactionId,
    reason:         dto.reason,
    initiatedBy:    adminId,
    amountOverride: dto.amount,
    refundTo:       dto.refund_to,
  });
}
