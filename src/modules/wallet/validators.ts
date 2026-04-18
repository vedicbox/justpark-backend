import { z } from 'zod';

// ─────────────────────────────────────────────
// POST /wallet/topup
// ─────────────────────────────────────────────
export const TopUpSchema = z.object({
  amount:          z
    .number({ required_error: 'amount is required' })
    .positive('Amount must be positive')
    .max(100_000, 'Maximum top-up amount is ₹1,00,000'),
  gateway:         z.enum(['stripe', 'razorpay']).default('razorpay'),
  payment_method:  z.enum(['card', 'upi', 'net_banking']).default('card'),
  idempotency_key: z.string().min(1).max(100).optional(),
});
export type TopUpDto = z.infer<typeof TopUpSchema>;

// ─────────────────────────────────────────────
// POST /wallet/topup/confirm  (Stripe — post-3DS)
// ─────────────────────────────────────────────
export const TopUpConfirmSchema = z.object({
  topup_ref:         z.string({ required_error: 'topup_ref is required' }).min(1),
  payment_intent_id: z.string().min(1).optional(),
});
export type TopUpConfirmDto = z.infer<typeof TopUpConfirmSchema>;

// ─────────────────────────────────────────────
// POST /wallet/topup/verify  (Razorpay)
// ─────────────────────────────────────────────
export const TopUpVerifyRazorpaySchema = z.object({
  razorpay_order_id:   z.string({ required_error: 'razorpay_order_id is required' }).min(1),
  razorpay_payment_id: z.string({ required_error: 'razorpay_payment_id is required' }).min(1),
  razorpay_signature:  z.string({ required_error: 'razorpay_signature is required' }).min(1),
});
export type TopUpVerifyRazorpayDto = z.infer<typeof TopUpVerifyRazorpaySchema>;

// ─────────────────────────────────────────────
// GET /wallet/transactions
// ─────────────────────────────────────────────
export const WalletTransactionQuerySchema = z.object({
  type: z
    .enum(['top_up', 'payment', 'refund', 'cashback', 'admin_credit', 'admin_debit', 'withdrawal'])
    .optional(),
  from:  z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'from must be a valid ISO date' }),
  to:    z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'to must be a valid ISO date' }),
  page:  z.string().optional().transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit: z.string().optional().transform((v) => Math.min(100, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type WalletTransactionQuery = z.infer<typeof WalletTransactionQuerySchema>;

// ─────────────────────────────────────────────
// POST /wallet/withdraw
// ─────────────────────────────────────────────
export const WithdrawSchema = z.object({
  amount:          z
    .number({ required_error: 'amount is required' })
    .positive('Amount must be positive')
    .min(100, 'Minimum withdrawal amount is ₹100'),
  bank_account_id: z.string({ required_error: 'bank_account_id is required' }).uuid('Invalid bank account ID'),
});
export type WithdrawDto = z.infer<typeof WithdrawSchema>;

// ─────────────────────────────────────────────
// POST /admin/wallet/:userId/adjust
// ─────────────────────────────────────────────
export const AdminWalletAdjustSchema = z.object({
  type:   z.enum(['credit', 'debit']),
  amount: z.number({ required_error: 'amount is required' }).positive('Amount must be positive'),
  reason: z.string({ required_error: 'reason is required' }).min(1).max(500).trim(),
});
export type AdminWalletAdjustDto = z.infer<typeof AdminWalletAdjustSchema>;

// ─────────────────────────────────────────────
// Route params
// ─────────────────────────────────────────────
export const UserIdParamSchema = z.object({
  userId: z.string().uuid('Invalid user ID'),
});
export type UserIdParam = z.infer<typeof UserIdParamSchema>;
