import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { isHost } from '../../middleware/roleGuard';
import { validate } from '../../middleware/validate';
import * as controller from './controller';
import {
  TopUpSchema,
  TopUpConfirmSchema,
  TopUpVerifyRazorpaySchema,
  WalletTransactionQuerySchema,
  WithdrawSchema,
} from './validators';

export const walletRouter = Router();

// All wallet routes require authentication.
// Individual endpoints can add stricter role guards where needed.
walletRouter.use(authenticate);

/**
 * GET /wallet
 * Get the authenticated user's own wallet balance and currency.
 * Creates wallet on first access (upsert).
 * Access: any authenticated user (user, host, admin).
 */
walletRouter.get('/', controller.getWallet);

// ─────────────────────────────────────────────
// Top-up flow
// ─────────────────────────────────────────────

/**
 * POST /wallet/topup
 * Initiate a wallet top-up for the authenticated user's own wallet via Stripe or Razorpay.
 * Returns client_secret (Stripe) or razorpay_order_id + key_id (Razorpay).
 * Actual wallet credit happens after payment success:
 *   - Webhook (automatic) OR
 *   - POST /wallet/topup/confirm (Stripe) / POST /wallet/topup/verify (Razorpay)
 * Access: any authenticated user (user, host, admin).
 */
walletRouter.post(
  '/topup',
  validate(TopUpSchema),
  controller.createTopUp
);

/**
 * POST /wallet/topup/confirm
 * Explicitly confirm a Stripe top-up for the authenticated user's own wallet after 3DS completes on the frontend.
 * Retrieves PaymentIntent from Stripe, verifies success, then credits wallet.
 * Idempotent — calling twice returns current balance without double-credit.
 * Access: any authenticated user (user, host, admin).
 */
walletRouter.post(
  '/topup/confirm',
  validate(TopUpConfirmSchema),
  controller.confirmTopUp
);

/**
 * POST /wallet/topup/verify
 * Verify a Razorpay top-up payment for the authenticated user's own wallet using HMAC-SHA256 signature.
 * Credits wallet on successful verification.
 * Idempotent — calling twice returns current balance without double-credit.
 * Access: any authenticated user (user, host, admin).
 */
walletRouter.post(
  '/topup/verify',
  validate(TopUpVerifyRazorpaySchema),
  controller.verifyTopUp
);

// ─────────────────────────────────────────────
// Transaction history
// ─────────────────────────────────────────────

/**
 * GET /wallet/transactions
 * Paginated wallet transaction history for the authenticated user's own wallet.
 * Optional: ?type=top_up|payment|refund|cashback|admin_credit|admin_debit|withdrawal
 *           &from=ISO &to=ISO &page= &limit=
 * Access: any authenticated user (user, host, admin).
 */
walletRouter.get(
  '/transactions',
  validate(WalletTransactionQuerySchema, 'query'),
  controller.getTransactions
);

// ─────────────────────────────────────────────
// Withdrawal
// ─────────────────────────────────────────────

/**
 * POST /wallet/withdraw
 * Request a withdrawal from the authenticated host's own wallet to a verified bank account.
 * Debits wallet immediately; actual bank transfer processed offline.
 * Minimum withdrawal: ₹100.
 * Access: hosts and admins acting as hosts only.
 */
walletRouter.post(
  '/withdraw',
  isHost,
  validate(WithdrawSchema),
  controller.requestWithdrawal
);
