import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { idempotency } from '../../middleware/idempotency';
import * as controller from './controller';
import {
  CreatePaymentIntentSchema,
  ConfirmPaymentSchema,
  CreateRazorpayOrderSchema,
  VerifyRazorpaySchema,
  TransactionHistoryQuerySchema,
  SavePaymentMethodSchema,
  PaymentMethodIdParamSchema,
} from './validators';

export const paymentsRouter = Router();

// ─────────────────────────────────────────────
// Webhook routes — PUBLIC (no JWT); signature-verified inside handler.
// Must be registered BEFORE authenticated routes so the router doesn't
// apply the later authenticate middleware to these paths.
// ─────────────────────────────────────────────

/**
 * POST /payments/webhook/stripe
 * Stripe sends payment_intent.succeeded, payment_intent.payment_failed,
 * and charge.refunded events here.
 * Verifies signature using STRIPE_WEBHOOK_SECRET.
 */
paymentsRouter.post('/webhook/stripe', controller.stripeWebhook);

/**
 * POST /payments/webhook/razorpay
 * Razorpay sends payment.captured, payment.failed, and refund.processed
 * events here.
 * Verifies signature using RAZORPAY_WEBHOOK_SECRET.
 */
paymentsRouter.post('/webhook/razorpay', controller.razorpayWebhook);

/**
 * POST /payments/webhook/razorpay-x
 * Razorpay X sends payout lifecycle events here:
 *   payout.initiated  → processing
 *   payout.processed  → completed (marks earnings paid_out)
 *   payout.reversed   → failed    (restores earnings to available)
 *   payout.failed     → failed    (restores earnings to available)
 * Verifies signature using RAZORPAY_X_WEBHOOK_SECRET (HMAC-SHA256).
 */
paymentsRouter.post('/webhook/razorpay-x', controller.razorpayXWebhook);

// ─────────────────────────────────────────────
// Authenticated payment routes (user + host + admin)
// ─────────────────────────────────────────────
paymentsRouter.use(authenticate);

// ─────────────────────────────────────────────
// Stripe flow
// ─────────────────────────────────────────────

/**
 * POST /payments/intent
 * Create a Stripe PaymentIntent for an authenticated actor's booking/workflow.
 * For wallet payments (payment_method: 'wallet'), processes inline without Stripe.
 * Returns client_secret for frontend to complete 3D Secure.
 * Idempotency key prevents double-charges.
 */
paymentsRouter.post(
  '/intent',
  idempotency(),
  validate(CreatePaymentIntentSchema),
  controller.createPaymentIntent
);

/**
 * POST /payments/confirm
 * Confirm payment after 3DS completes on the frontend for any authenticated role.
 * Retrieves PaymentIntent from Stripe to verify status, then
 * confirms booking and creates host earnings.
 * Idempotency key prevents double-confirmation of the same payment.
 */
paymentsRouter.post(
  '/confirm',
  idempotency(),
  validate(ConfirmPaymentSchema),
  controller.confirmPayment
);

// ─────────────────────────────────────────────
// Razorpay flow
// ─────────────────────────────────────────────

/**
 * POST /payments/razorpay/order
 * Create a Razorpay Order for an authenticated actor's booking/workflow.
 * Frontend uses the returned order_id + key_id to open Razorpay checkout.
 * Idempotency key prevents duplicate order creation on network retries.
 */
paymentsRouter.post(
  '/razorpay/order',
  idempotency(),
  validate(CreateRazorpayOrderSchema),
  controller.createRazorpayOrder
);

/**
 * POST /payments/razorpay/verify
 * Verify Razorpay payment signature after frontend checkout completes.
 * HMAC-SHA256(order_id|payment_id) verified server-side.
 * Confirms booking and creates host earnings on success.
 * Idempotency key prevents double-confirmation on retries.
 */
paymentsRouter.post(
  '/razorpay/verify',
  idempotency(),
  validate(VerifyRazorpaySchema),
  controller.verifyRazorpayPayment
);

// ─────────────────────────────────────────────
// Transaction history
// ─────────────────────────────────────────────

/**
 * GET /payments/history
 * Paginated transaction history for the authenticated actor.
 * Regular users/hosts see only their own payments.
 * Admins can see all payments and may filter by ?user_id=UUID.
 * Optional: ?status=, ?from=ISO, ?to=ISO, ?page=, ?limit=
 */
paymentsRouter.get(
  '/history',
  validate(TransactionHistoryQuerySchema, 'query'),
  controller.getTransactionHistory
);

// ─────────────────────────────────────────────
// Saved payment methods
// ─────────────────────────────────────────────

/**
 * GET /payments/methods
 * List saved tokenized payment methods.
 */
paymentsRouter.get('/methods', controller.listPaymentMethods);

/**
 * POST /payments/methods
 * Save a tokenized payment method (Stripe or Razorpay token).
 * Never stores raw card data.
 */
paymentsRouter.post(
  '/methods',
  validate(SavePaymentMethodSchema),
  controller.savePaymentMethod
);

/**
 * DELETE /payments/methods/:id
 * Remove a saved payment method.
 * If it was the default, promotes the next one.
 */
paymentsRouter.delete(
  '/methods/:id',
  validate(PaymentMethodIdParamSchema, 'params'),
  controller.deletePaymentMethod
);
