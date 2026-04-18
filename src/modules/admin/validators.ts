import { z } from 'zod';

// ─────────────────────────────────────────────
// GET /admin/spaces — List all spaces query
// ─────────────────────────────────────────────
export const AdminListSpacesQuerySchema = z.object({
  search: z.string().max(200).optional(),
  status: z
    .enum(['draft', 'pending_review', 'active', 'paused', 'rejected', 'deleted'])
    .optional(),
  city: z.string().optional(),
  host_id: z.string().uuid('Invalid host ID').optional(),
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
});
export type AdminListSpacesQuery = z.infer<typeof AdminListSpacesQuerySchema>;

// ─────────────────────────────────────────────
// PATCH /admin/spaces/:id/reject — Reject with reason
// ─────────────────────────────────────────────
export const RejectSpaceSchema = z.object({
  reason: z
    .string({ required_error: 'Rejection reason is required' })
    .min(1, 'Rejection reason cannot be empty')
    .max(1000)
    .trim(),
});
export type RejectSpaceDto = z.infer<typeof RejectSpaceSchema>;

// ─────────────────────────────────────────────
// Route param — space
// ─────────────────────────────────────────────
export const AdminSpaceIdParamSchema = z.object({
  id: z.string().uuid('Invalid space ID'),
});
export type AdminSpaceIdParam = z.infer<typeof AdminSpaceIdParamSchema>;

// ─────────────────────────────────────────────
// Route param — transaction
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

// ─────────────────────────────────────────────
// GET /admin/payouts — List all payouts
// ─────────────────────────────────────────────
export const AdminListPayoutsQuerySchema = z.object({
  status:  z.enum(['requested', 'processing', 'completed', 'failed']).optional(),
  host_id: z.string().uuid('Invalid host ID').optional(),
  page:    z.coerce.number().min(1).optional().default(1),
  limit:   z.coerce.number().min(1).max(100).optional().default(20),
});
export type AdminListPayoutsQuery = z.infer<typeof AdminListPayoutsQuerySchema>;

// ─────────────────────────────────────────────
// Route param — :id (payout)
// ─────────────────────────────────────────────
export const AdminPayoutIdParamSchema = z.object({
  id: z.string().uuid('Invalid payout ID'),
});
export type AdminPayoutIdParam = z.infer<typeof AdminPayoutIdParamSchema>;

// ─────────────────────────────────────────────
// POST /admin/payouts/:id/process
// ─────────────────────────────────────────────
export const ProcessPayoutSchema = z.object({
  status: z.enum(['processing', 'completed', 'failed']),
  note:   z.string().max(500).optional(),
});
export type ProcessPayoutDto = z.infer<typeof ProcessPayoutSchema>;

// ─────────────────────────────────────────────
// Route param — :userId (wallet adjust)
// ─────────────────────────────────────────────
export const UserIdParamSchema = z.object({
  userId: z.string().uuid('Invalid user ID'),
});
export type UserIdParam = z.infer<typeof UserIdParamSchema>;

// ─────────────────────────────────────────────
// POST /admin/wallet/:userId/adjust
// ─────────────────────────────────────────────
export const AdminWalletAdjustSchema = z.object({
  type:   z.enum(['credit', 'debit']),
  amount: z.number().positive('Amount must be positive'),
  reason: z.string({ required_error: 'reason is required' }).min(1).max(500).trim(),
});
export type AdminWalletAdjustDto = z.infer<typeof AdminWalletAdjustSchema>;

// ─────────────────────────────────────────────
// GET /admin/users — list all users
// ─────────────────────────────────────────────
export const AdminListUsersQuerySchema = z.object({
  search: z.string().max(200).optional(),            // name / email / phone
  role:   z.enum(['user', 'host', 'admin']).optional(),
  status: z.enum(['active', 'suspended', 'deactivated']).optional(),
  page:   z.coerce.number().min(1).optional().default(1),
  limit:  z.coerce.number().min(1).max(100).optional().default(20),
});
export type AdminListUsersQuery = z.infer<typeof AdminListUsersQuerySchema>;

// ─────────────────────────────────────────────
// Route param — :id (generic user)
// ─────────────────────────────────────────────
export const AdminUserIdParamSchema = z.object({
  id: z.string().uuid('Invalid user ID'),
});
export type AdminUserIdParam = z.infer<typeof AdminUserIdParamSchema>;

// ─────────────────────────────────────────────
// PATCH /admin/users/:id/status
// ─────────────────────────────────────────────
export const AdminUpdateUserStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'deactivated']),
  reason: z.string().min(1).max(500).trim().optional(),
});
export type AdminUpdateUserStatusDto = z.infer<typeof AdminUpdateUserStatusSchema>;

// ─────────────────────────────────────────────
// PATCH /admin/users/:id/role
// ─────────────────────────────────────────────
export const AdminUpdateUserRoleSchema = z.object({
  role: z.enum(['user', 'host', 'admin']),
  reason: z.string().min(1).max(500).trim().optional(),
});
export type AdminUpdateUserRoleDto = z.infer<typeof AdminUpdateUserRoleSchema>;

// ─────────────────────────────────────────────
// Route param — :id (KYC document)
// ─────────────────────────────────────────────
export const KycIdParamSchema = z.object({
  id: z.string().uuid('Invalid KYC document ID'),
});
export type KycIdParam = z.infer<typeof KycIdParamSchema>;

// ─────────────────────────────────────────────
// PATCH /admin/kyc/:id/reject — reject with reason
// ─────────────────────────────────────────────
export const KycRejectSchema = z.object({
  reason: z.string({ required_error: 'Rejection reason is required' }).min(1).max(1000).trim(),
});
export type KycRejectDto = z.infer<typeof KycRejectSchema>;

// ─────────────────────────────────────────────
// GET /admin/kyc/pending — list query
// ─────────────────────────────────────────────
export const AdminListKycQuerySchema = z.object({
  page:  z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
});
export type AdminListKycQuery = z.infer<typeof AdminListKycQuerySchema>;

// ─────────────────────────────────────────────
// GET /admin/bookings — all bookings
// ─────────────────────────────────────────────
export const AdminListBookingsQuerySchema = z.object({
  search:   z.string().max(200).optional(),
  status:   z.enum(['pending','confirmed','active','completed','cancelled','no_show','disputed']).optional(),
  space_id: z.string().uuid().optional(),
  user_id:  z.string().uuid().optional(),
  from:     z.string().optional(),   // ISO date
  to:       z.string().optional(),   // ISO date
  page:     z.coerce.number().min(1).optional().default(1),
  limit:    z.coerce.number().min(1).max(100).optional().default(20),
});
export type AdminListBookingsQuery = z.infer<typeof AdminListBookingsQuerySchema>;

// ─────────────────────────────────────────────
// GET /admin/transactions — all transactions
// ─────────────────────────────────────────────
export const AdminListTransactionsQuerySchema = z.object({
  status: z.enum(['pending','processing','completed','failed','refunded','partially_refunded']).optional(),
  method: z.enum(['card','upi','net_banking','wallet','wallet_card_split']).optional(),
  from:   z.string().optional(),
  to:     z.string().optional(),
  page:   z.coerce.number().min(1).optional().default(1),
  limit:  z.coerce.number().min(1).max(100).optional().default(20),
});
export type AdminListTransactionsQuery = z.infer<typeof AdminListTransactionsQuerySchema>;

// ─────────────────────────────────────────────
// PATCH /admin/config — update platform config
// ─────────────────────────────────────────────
export const UpdatePlatformConfigSchema = z.object({
  updates: z.record(z.string(), z.unknown()),
});
export type UpdatePlatformConfigDto = z.infer<typeof UpdatePlatformConfigSchema>;

// ─────────────────────────────────────────────
// GET/PATCH /admin/promo-codes
// ─────────────────────────────────────────────
export const AdminListPromoCodesQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional(),
  page:   z.coerce.number().min(1).optional().default(1),
  limit:  z.coerce.number().min(1).max(100).optional().default(20),
});
export type AdminListPromoCodesQuery = z.infer<typeof AdminListPromoCodesQuerySchema>;

export const CreatePromoCodeSchema = z.object({
  code:               z.string().min(3).max(50).trim().toUpperCase(),
  discount_type:      z.enum(['percentage', 'flat']),
  discount_value:     z.number().positive(),
  max_discount:       z.number().positive().optional(),
  min_booking_amount: z.number().positive().optional(),
  usage_limit:        z.number().int().positive().optional(),
  valid_from:         z.string().datetime({ message: 'valid_from must be ISO datetime' }),
  valid_until:        z.string().datetime({ message: 'valid_until must be ISO datetime' }),
}).refine(
  (d) => new Date(d.valid_from) < new Date(d.valid_until),
  { message: 'valid_from must be before valid_until', path: ['valid_from'] }
);
export type CreatePromoCodeDto = z.infer<typeof CreatePromoCodeSchema>;

export const UpdatePromoCodeSchema = z.object({
  discount_type:      z.enum(['percentage', 'flat']).optional(),
  discount_value:     z.number().positive().optional(),
  max_discount:       z.number().positive().nullable().optional(),
  min_booking_amount: z.number().positive().nullable().optional(),
  usage_limit:        z.number().int().positive().nullable().optional(),
  valid_from:         z.string().datetime().optional(),
  valid_until:        z.string().datetime().optional(),
  active:             z.boolean().optional(),
}).refine(
  (d) => Object.keys(d).length > 0,
  { message: 'At least one field must be provided' }
);
export type UpdatePromoCodeDto = z.infer<typeof UpdatePromoCodeSchema>;

export const PromoCodeIdParamSchema = z.object({
  id: z.string().uuid('Invalid promo code ID'),
});
export type PromoCodeIdParam = z.infer<typeof PromoCodeIdParamSchema>;

// ─────────────────────────────────────────────
// POST /admin/notifications/broadcast
// ─────────────────────────────────────────────
export const BroadcastNotificationSchema = z.object({
  title:   z.string({ required_error: 'Title is required' }).min(1).max(200).trim(),
  body:    z.string({ required_error: 'Body is required' }).min(1).max(1000).trim(),
  filter:  z.object({
    role:   z.enum(['user', 'host', 'admin']).optional(),
    status: z.enum(['active', 'suspended', 'deactivated']).optional(),
  }).optional(),
  data:    z.record(z.string(), z.string()).optional(),
});
export type BroadcastNotificationDto = z.infer<typeof BroadcastNotificationSchema>;

// ─────────────────────────────────────────────
// GET /admin/audit-logs
// ─────────────────────────────────────────────
export const AuditLogQuerySchema = z.object({
  actor_id:    z.string().uuid().optional(),
  action:      z.string().max(100).optional(),
  entity_type: z.string().max(100).optional(),
  entity_id:   z.string().uuid().optional(),
  from:        z.string().optional(),
  to:          z.string().optional(),
  page:        z.coerce.number().min(1).optional().default(1),
  limit:       z.coerce.number().min(1).max(100).optional().default(20),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

// ─────────────────────────────────────────────
// GET /admin/bank-accounts — List all bank accounts
// ─────────────────────────────────────────────
export const AdminListBankAccountsQuerySchema = z.object({
  host_id:     z.string().uuid().optional(),
  is_verified: z.enum(['true', 'false']).optional(),
  page:        z.coerce.number().min(1).optional().default(1),
  limit:       z.coerce.number().min(1).max(100).optional().default(20),
});
export type AdminListBankAccountsQuery = z.infer<typeof AdminListBankAccountsQuerySchema>;

// ─────────────────────────────────────────────
// PATCH /admin/bank-accounts/:id/verify — Re-register with Razorpay X
// ─────────────────────────────────────────────
export const BankAccountIdParamSchema = z.object({
  id: z.string().uuid('Invalid bank account ID'),
});
export type BankAccountIdParam = z.infer<typeof BankAccountIdParamSchema>;

// ─────────────────────────────────────────────
// Re-export support validators used in admin routes
// ─────────────────────────────────────────────
export {
  AdminListTicketsQuerySchema,
  AdminUpdateTicketSchema,
  AdminResolveDisputeSchema,
  TicketIdParamSchema,
  DisputeIdParamSchema,
} from '../support/validators';
export type {
  AdminListTicketsQuery,
  AdminUpdateTicketDto,
  AdminResolveDisputeDto,
  TicketIdParam,
  DisputeIdParam,
} from '../support/validators';
