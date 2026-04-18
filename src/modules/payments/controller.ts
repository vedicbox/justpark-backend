import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import * as paymentService from './service';
import { AppError } from '../../middleware/errorHandler';
import type {
  CreatePaymentIntentDto,
  ConfirmPaymentDto,
  CreateRazorpayOrderDto,
  VerifyRazorpayDto,
  TransactionHistoryQuery,
  SavePaymentMethodDto,
  PaymentMethodIdParam,
  TransactionIdParam,
  AdminRefundDto,
} from './validators';

// ─────────────────────────────────────────────
// POST /payments/intent  (Stripe)
// ─────────────────────────────────────────────
export async function createPaymentIntent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await paymentService.createPaymentIntent(req.user!.sub, req.body as CreatePaymentIntentDto);
    Respond.created(res, result, 'Payment intent created');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /payments/confirm
// ─────────────────────────────────────────────
export async function confirmPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await paymentService.confirmPayment(req.user!.sub, req.body as ConfirmPaymentDto);
    Respond.ok(res, result, 'Payment confirmed');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /payments/razorpay/order
// ─────────────────────────────────────────────
export async function createRazorpayOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await paymentService.createRazorpayOrder(req.user!.sub, req.body as CreateRazorpayOrderDto);
    Respond.created(res, result, 'Razorpay order created');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /payments/razorpay/verify
// ─────────────────────────────────────────────
export async function verifyRazorpayPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await paymentService.verifyRazorpayPayment(req.user!.sub, req.body as VerifyRazorpayDto);
    Respond.ok(res, result, 'Payment verified');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /payments/webhook/stripe
// Public — signature-verified, no JWT auth
// ─────────────────────────────────────────────
export async function stripeWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      next(AppError.badRequest('PAYMENT_FAILED', 'Missing stripe-signature header'));
      return;
    }
    if (!req.rawBody) {
      next(AppError.badRequest('PAYMENT_FAILED', 'Missing raw body'));
      return;
    }

    await paymentService.handleStripeWebhook(req.rawBody, signature);
    res.status(200).json({ received: true });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /payments/webhook/razorpay
// Public — signature-verified, no JWT auth
// ─────────────────────────────────────────────
export async function razorpayWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const signature = req.headers['x-razorpay-signature'] as string;
    if (!signature) {
      next(AppError.badRequest('PAYMENT_FAILED', 'Missing x-razorpay-signature header'));
      return;
    }
    if (!req.rawBody) {
      next(AppError.badRequest('PAYMENT_FAILED', 'Missing raw body'));
      return;
    }

    await paymentService.handleRazorpayWebhook(req.rawBody, signature);
    res.status(200).json({ received: true });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /payments/history
// ─────────────────────────────────────────────
export async function getTransactionHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as TransactionHistoryQuery;
    const { transactions, meta } = await paymentService.getTransactionHistory(req.user!, query);
    Respond.ok(res, transactions, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /payments/methods
// ─────────────────────────────────────────────
export async function listPaymentMethods(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const methods = await paymentService.listPaymentMethods(req.user!.sub);
    Respond.ok(res, methods);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /payments/methods
// ─────────────────────────────────────────────
export async function savePaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const method = await paymentService.savePaymentMethod(req.user!.sub, req.body as SavePaymentMethodDto);
    Respond.created(res, method, 'Payment method saved');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// DELETE /payments/methods/:id
// ─────────────────────────────────────────────
export async function deletePaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as PaymentMethodIdParam;
    await paymentService.deletePaymentMethod(req.user!.sub, id);
    Respond.ok(res, null, 'Payment method removed');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /payments/webhook/razorpay-x
// Public — HMAC-verified, no JWT auth.
// Handles Razorpay X payout lifecycle events:
//   payout.initiated  → processing
//   payout.processed  → completed (marks earnings paid_out)
//   payout.reversed   → failed    (restores earnings to available)
//   payout.failed     → failed    (restores earnings to available)
// ─────────────────────────────────────────────
export async function razorpayXWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const signature = req.headers['x-razorpay-signature'] as string | undefined;
    if (!signature) {
      next(AppError.badRequest('PAYMENT_FAILED', 'Missing x-razorpay-signature header'));
      return;
    }
    if (!req.rawBody) {
      next(AppError.badRequest('PAYMENT_FAILED', 'Missing raw body'));
      return;
    }

    await paymentService.handleRazorpayXWebhook(req.rawBody, signature);
    // Always return 200 immediately — Razorpay retries if it receives non-2xx
    res.status(200).json({ received: true });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /admin/transactions/:id/refund
// (Mounted from admin routes — adminId is req.user!.sub)
// ─────────────────────────────────────────────
export async function adminRefund(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as TransactionIdParam;
    const result  = await paymentService.adminInitiateRefund(req.user!.sub, id, req.body as AdminRefundDto);
    Respond.ok(res, result, 'Refund initiated successfully');
  } catch (err) { next(err); }
}
