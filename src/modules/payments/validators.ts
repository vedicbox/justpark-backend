import { z } from 'zod';

// ─────────────────────────────────────────────
// POST /payments/intent  (Stripe)
// ─────────────────────────────────────────────
export const CreatePaymentIntentSchema = z.object({
  booking_id:       z.string({ required_error: 'booking_id is required' }).uuid('Invalid booking ID'),
  payment_method:   z.enum(['card', 'upi', 'net_banking', 'wallet', 'wallet_card_split']).default('card'),
  saved_method_id:  z.string().uuid('Invalid saved_method_id').optional(),
  idempotency_key:  z.string().min(1).max(100).optional(),
  // For wallet_card_split: amount to deduct from wallet (remainder charged to card)
  wallet_amount:    z.number().positive().optional(),
});
export type CreatePaymentIntentDto = z.infer<typeof CreatePaymentIntentSchema>;

// ─────────────────────────────────────────────
// POST /payments/confirm  (Stripe — post-3DS)
// ─────────────────────────────────────────────
export const ConfirmPaymentSchema = z.object({
  transaction_id:    z.string({ required_error: 'transaction_id is required' }).uuid('Invalid transaction ID'),
  payment_intent_id: z.string().min(1).optional(), // pi_... from Stripe SDK
});
export type ConfirmPaymentDto = z.infer<typeof ConfirmPaymentSchema>;

// ─────────────────────────────────────────────
// POST /payments/razorpay/order
// ─────────────────────────────────────────────
export const CreateRazorpayOrderSchema = z.object({
  booking_id:      z.string({ required_error: 'booking_id is required' }).uuid('Invalid booking ID'),
  payment_method:  z.enum(['card', 'upi', 'net_banking', 'wallet_card_split']).default('card'),
  saved_method_id: z.string().uuid().optional(),
  idempotency_key: z.string().min(1).max(100).optional(),
});
export type CreateRazorpayOrderDto = z.infer<typeof CreateRazorpayOrderSchema>;

// ─────────────────────────────────────────────
// POST /payments/razorpay/verify
// ─────────────────────────────────────────────
export const VerifyRazorpaySchema = z.object({
  booking_id:           z.string({ required_error: 'booking_id is required' }).uuid('Invalid booking ID'),
  razorpay_order_id:    z.string({ required_error: 'razorpay_order_id is required' }).min(1),
  razorpay_payment_id:  z.string({ required_error: 'razorpay_payment_id is required' }).min(1),
  razorpay_signature:   z.string({ required_error: 'razorpay_signature is required' }).min(1),
});
export type VerifyRazorpayDto = z.infer<typeof VerifyRazorpaySchema>;

// ─────────────────────────────────────────────
// GET /payments/history
// ─────────────────────────────────────────────
export const TransactionHistoryQuerySchema = z.object({
  user_id: z.string().uuid('user_id must be a valid UUID').optional(),
  status: z
    .enum(['pending', 'processing', 'completed', 'failed', 'refunded', 'partially_refunded'])
    .optional(),
  from:  z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'from must be a valid ISO date' }),
  to:    z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'to must be a valid ISO date' }),
  page:  z.string().optional().transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit: z.string().optional().transform((v) => Math.min(100, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type TransactionHistoryQuery = z.infer<typeof TransactionHistoryQuerySchema>;

// ─────────────────────────────────────────────
// POST /payments/methods — save tokenized method
// ─────────────────────────────────────────────
export const SavePaymentMethodSchema = z.object({
  gateway:        z.enum(['stripe', 'razorpay']),
  token:          z.string({ required_error: 'token is required' }).min(1).max(255),
  card_last_four: z.string().length(4).regex(/^\d{4}$/, 'card_last_four must be 4 digits').optional(),
  card_brand:     z.string().max(50).optional(),
  is_default:     z.boolean().default(false),
});
export type SavePaymentMethodDto = z.infer<typeof SavePaymentMethodSchema>;

// ─────────────────────────────────────────────
// Route param — :id (payment method)
// ─────────────────────────────────────────────
export const PaymentMethodIdParamSchema = z.object({
  id: z.string().uuid('Invalid payment method ID'),
});
export type PaymentMethodIdParam = z.infer<typeof PaymentMethodIdParamSchema>;

// ─────────────────────────────────────────────
// Route param — :id (transaction)
// ─────────────────────────────────────────────
export const TransactionIdParamSchema = z.object({
  id: z.string().uuid('Invalid transaction ID'),
});
export type TransactionIdParam = z.infer<typeof TransactionIdParamSchema>;

// ─────────────────────────────────────────────
// POST /admin/transactions/:id/refund
// ─────────────────────────────────────────────
export const AdminRefundSchema = z.object({
  reason:    z.string({ required_error: 'reason is required' }).min(1).max(500).trim(),
  amount:    z.number().positive('Amount must be positive').optional(),
  refund_to: z.enum(['original_method', 'wallet']).default('original_method'),
});
export type AdminRefundDto = z.infer<typeof AdminRefundSchema>;
