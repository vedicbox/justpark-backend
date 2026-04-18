import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { isAdmin } from '../../middleware/roleGuard';
import { validate } from '../../middleware/validate';
import * as controller from './controller';
import * as reviewController from '../reviews/controller';
import * as supportController from '../support/controller';
import { ReviewIdParamSchema, ListFlaggedReviewsQuerySchema } from '../reviews/validators';
import {
  BankAccountIdParamSchema,
  AdminListBankAccountsQuerySchema,
  AdminListSpacesQuerySchema,
  RejectSpaceSchema,
  AdminSpaceIdParamSchema,
  TransactionIdParamSchema,
  AdminRefundSchema,
  UserIdParamSchema,
  AdminWalletAdjustSchema,
  AdminListPayoutsQuerySchema,
  AdminPayoutIdParamSchema,
  ProcessPayoutSchema,
  AdminListTicketsQuerySchema,
  AdminUpdateTicketSchema,
  AdminResolveDisputeSchema,
  TicketIdParamSchema,
  DisputeIdParamSchema,
  AdminListUsersQuerySchema,
  AdminUserIdParamSchema,
  AdminUpdateUserStatusSchema,
  AdminUpdateUserRoleSchema,
  AdminListKycQuerySchema,
  KycIdParamSchema,
  KycRejectSchema,
  AdminListBookingsQuerySchema,
  AdminListTransactionsQuerySchema,
  UpdatePlatformConfigSchema,
  AdminListPromoCodesQuerySchema,
  CreatePromoCodeSchema,
  UpdatePromoCodeSchema,
  PromoCodeIdParamSchema,
  BroadcastNotificationSchema,
  AuditLogQuerySchema,
} from './validators';

export const adminRouter = Router();

// All admin routes require authentication and admin role
adminRouter.use(authenticate, isAdmin);

// ─────────────────────────────────────────────
// Space moderation
// ─────────────────────────────────────────────

/**
 * GET /admin/spaces
 * List all spaces across all hosts. Filter by status, city, host_id.
 * Default shows all statuses; use ?status=pending_review to see pending.
 */
adminRouter.get(
  '/spaces',
  validate(AdminListSpacesQuerySchema, 'query'),
  controller.listAllSpaces
);

/**
 * GET /admin/spaces/:id
 * Get full details of any space regardless of status.
 */
adminRouter.get(
  '/spaces/:id',
  validate(AdminSpaceIdParamSchema, 'params'),
  controller.getSpaceDetail
);

/**
 * PATCH /admin/spaces/:id/approve
 * Approve a pending_review listing → status: 'active'.
 * Creates an audit log entry.
 */
adminRouter.patch(
  '/spaces/:id/approve',
  validate(AdminSpaceIdParamSchema, 'params'),
  controller.approveSpace
);

/**
 * PATCH /admin/spaces/:id/reject
 * Reject a pending_review listing → status: 'rejected'.
 * Reason is stored in the audit log.
 */
adminRouter.patch(
  '/spaces/:id/reject',
  validate(AdminSpaceIdParamSchema, 'params'),
  validate(RejectSpaceSchema),
  controller.rejectSpace
);

// ─────────────────────────────────────────────
// Transaction management
// ─────────────────────────────────────────────

/**
 * POST /admin/transactions/:id/refund
 * Admin-initiated refund on any transaction.
 * Attempts gateway refund first; falls back to wallet credit.
 * Optional: amount (for partial refund), refund_to ('original_method' | 'wallet').
 */
adminRouter.post(
  '/transactions/:id/refund',
  validate(TransactionIdParamSchema, 'params'),
  validate(AdminRefundSchema),
  controller.adminRefund
);

// ─────────────────────────────────────────────
// Wallet management
// ─────────────────────────────────────────────

/**
 * POST /admin/wallet/:userId/adjust
 * Credit or debit a user's wallet.
 * Creates an audit log entry.
 */
adminRouter.post(
  '/wallet/:userId/adjust',
  validate(UserIdParamSchema, 'params'),
  validate(AdminWalletAdjustSchema),
  controller.adminWalletAdjust
);

// ─────────────────────────────────────────────
// Bank account — Razorpay X registration
// ─────────────────────────────────────────────

/**
 * GET /admin/bank-accounts
 * List all bank accounts with host info and verification status.
 * Filter by ?host_id=, ?is_verified=true|false, ?page=, ?limit=
 */
adminRouter.get(
  '/bank-accounts',
  validate(AdminListBankAccountsQuerySchema, 'query'),
  controller.listBankAccounts
);

/**
 * PATCH /admin/bank-accounts/:id/verify
 * Re-triggers Razorpay X Contact + Fund Account creation for a bank account.
 * Use when the async background registration in addBankAccount() silently failed.
 * Decrypts the stored account number, calls Razorpay X, persists the IDs, and
 * sets is_verified = true on success.
 * Requires Razorpay X to be configured — throws SERVICE_UNAVAILABLE otherwise.
 */
adminRouter.patch(
  '/bank-accounts/:id/verify',
  validate(BankAccountIdParamSchema, 'params'),
  controller.verifyBankAccount
);

/**
 * PATCH /admin/bank-accounts/:id/mark-verified
 * Dev/staging fallback: manually marks a bank account as verified without
 * calling Razorpay X. Only available when Razorpay X is NOT configured.
 * Throws VALIDATION_ERROR in production to prevent bypassing fund-account registration.
 */
adminRouter.patch(
  '/bank-accounts/:id/mark-verified',
  validate(BankAccountIdParamSchema, 'params'),
  controller.markBankAccountVerified
);

// ─────────────────────────────────────────────
// Payout management
// ─────────────────────────────────────────────

/**
 * GET /admin/payouts
 * List all payout requests. Filter by ?status= and/or ?host_id=
 */
adminRouter.get(
  '/payouts',
  validate(AdminListPayoutsQuerySchema, 'query'),
  controller.listAllPayouts
);

/**
 * POST /admin/payouts/:id/process
 * Update payout status to processing, completed, or failed.
 * On completed → host earnings marked as paid_out.
 * On failed    → host earnings reverted to available.
 */
adminRouter.post(
  '/payouts/:id/process',
  validate(AdminPayoutIdParamSchema, 'params'),
  validate(ProcessPayoutSchema),
  controller.processPayoutRequest
);

// ─────────────────────────────────────────────
// Review moderation
// ─────────────────────────────────────────────

/**
 * GET /admin/reviews/flagged
 * List all reviews flagged for moderation (reported or auto-flagged for profanity).
 */
adminRouter.get(
  '/reviews/flagged',
  validate(ListFlaggedReviewsQuerySchema, 'query'),
  reviewController.listFlaggedReviews
);

/**
 * DELETE /admin/reviews/:id
 * Remove a review — sets status to 'removed' and refreshes space rating.
 */
adminRouter.delete(
  '/reviews/:id',
  validate(ReviewIdParamSchema, 'params'),
  reviewController.adminRemoveReview
);

// ─────────────────────────────────────────────
// Support ticket management
// ─────────────────────────────────────────────

/**
 * GET /admin/tickets
 * List all support tickets. Filter by status, priority, assigned_to.
 * SLA breach flag included on each ticket.
 */
adminRouter.get(
  '/tickets',
  validate(AdminListTicketsQuerySchema, 'query'),
  supportController.adminListTickets
);

/**
 * PATCH /admin/tickets/:id
 * Assign ticket to an admin, update status or priority, or add a note to the thread.
 */
adminRouter.patch(
  '/tickets/:id',
  validate(TicketIdParamSchema, 'params'),
  validate(AdminUpdateTicketSchema),
  supportController.adminUpdateTicket
);

// ─────────────────────────────────────────────
// Dispute management
// ─────────────────────────────────────────────

/**
 * GET /admin/disputes
 * List all disputes. Filter by ?status=open|resolved
 */
adminRouter.get('/disputes', supportController.adminListDisputes);

/**
 * PATCH /admin/disputes/:id/resolve
 * Resolve a dispute: full_refund | partial_refund | no_action | credit.
 * Handles refund/wallet credit and releases host earnings.
 */
adminRouter.patch(
  '/disputes/:id/resolve',
  validate(DisputeIdParamSchema, 'params'),
  validate(AdminResolveDisputeSchema),
  supportController.adminResolveDispute
);

// ─────────────────────────────────────────────
// User management
// ─────────────────────────────────────────────

/**
 * GET /admin/users
 * List all users. Search by name/email/phone; filter by role/status.
 */
adminRouter.get(
  '/users',
  validate(AdminListUsersQuerySchema, 'query'),
  controller.listAllUsers
);

/**
 * GET /admin/users/:id
 * Full user detail: profile, booking count, KYC documents, wallet balance.
 */
adminRouter.get(
  '/users/:id',
  validate(AdminUserIdParamSchema, 'params'),
  controller.getUserDetail
);

/**
 * PATCH /admin/users/:id/status
 * Change status to active / suspended / deactivated.
 * On suspend/deactivate: cancels active bookings with full wallet refund.
 */
adminRouter.patch(
  '/users/:id/status',
  validate(AdminUserIdParamSchema, 'params'),
  validate(AdminUpdateUserStatusSchema),
  controller.updateUserStatus
);

/**
 * PATCH /admin/users/:id/role
 * Promote or demote a user's role (user | host | admin).
 * Admins cannot change their own role. All changes are audit-logged.
 */
adminRouter.patch(
  '/users/:id/role',
  validate(AdminUserIdParamSchema, 'params'),
  validate(AdminUpdateUserRoleSchema),
  controller.updateUserRole
);

// ─────────────────────────────────────────────
// KYC management
// ─────────────────────────────────────────────

/**
 * GET /admin/kyc/pending
 * List all KYC submissions awaiting review.
 */
adminRouter.get(
  '/kyc/pending',
  validate(AdminListKycQuerySchema, 'query'),
  controller.listPendingKyc
);

/**
 * PATCH /admin/kyc/:id/approve
 * Approve a KYC document → status: 'approved'. Notifies the user.
 */
adminRouter.patch(
  '/kyc/:id/approve',
  validate(KycIdParamSchema, 'params'),
  controller.approveKyc
);

/**
 * PATCH /admin/kyc/:id/reject
 * Reject a KYC document with reason. Notifies the user.
 */
adminRouter.patch(
  '/kyc/:id/reject',
  validate(KycIdParamSchema, 'params'),
  validate(KycRejectSchema),
  controller.rejectKyc
);

// ─────────────────────────────────────────────
// Booking oversight
// ─────────────────────────────────────────────

/**
 * GET /admin/bookings
 * All bookings across all users and spaces.
 * Filter: status, space_id, user_id, from, to (date range).
 */
adminRouter.get(
  '/bookings',
  validate(AdminListBookingsQuerySchema, 'query'),
  controller.listAllBookings
);

/**
 * POST /admin/bookings/:id/cancel
 * Force cancel a booking.
 */
adminRouter.post('/bookings/:id/cancel', controller.adminCancelBooking);

/**
 * POST /admin/bookings/:id/refund
 * Force issue a refund.
 */
adminRouter.post('/bookings/:id/refund', controller.adminRefundBooking);

// ─────────────────────────────────────────────
// Transaction management
// ─────────────────────────────────────────────

/**
 * GET /admin/transactions
 * All payment transactions. Filter: status, method, date range.
 */
adminRouter.get(
  '/transactions',
  validate(AdminListTransactionsQuerySchema, 'query'),
  controller.listAllTransactions
);

// ─────────────────────────────────────────────
// Platform config
// ─────────────────────────────────────────────

/**
 * GET /admin/config
 * Get all platform config (commission rates, tax, feature flags, etc.).
 */
adminRouter.get('/config', controller.getPlatformConfig);

/**
 * PATCH /admin/config
 * Update one or more config keys. Body: { updates: { key: value } }
 */
adminRouter.patch(
  '/config',
  validate(UpdatePlatformConfigSchema),
  controller.updatePlatformConfig
);

// ─────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────

/**
 * GET /admin/analytics
 * Dashboard metrics: users, bookings, revenue, growth, top spaces.
 */
adminRouter.get('/analytics', controller.getAnalytics);

// ─────────────────────────────────────────────
// Promo codes
// ─────────────────────────────────────────────

/**
 * GET /admin/promo-codes
 * List all promo codes. Filter: ?active=true|false
 */
adminRouter.get(
  '/promo-codes',
  validate(AdminListPromoCodesQuerySchema, 'query'),
  controller.listPromoCodes
);

/**
 * POST /admin/promo-codes
 * Create a new promo code.
 */
adminRouter.post(
  '/promo-codes',
  validate(CreatePromoCodeSchema),
  controller.createPromoCode
);

/**
 * PATCH /admin/promo-codes/:id
 * Update an existing promo code.
 */
adminRouter.patch(
  '/promo-codes/:id',
  validate(PromoCodeIdParamSchema, 'params'),
  validate(UpdatePromoCodeSchema),
  controller.updatePromoCode
);

/**
 * DELETE /admin/promo-codes/:id
 * Deactivate a promo code (soft delete — sets active: false).
 */
adminRouter.delete(
  '/promo-codes/:id',
  validate(PromoCodeIdParamSchema, 'params'),
  controller.deactivatePromoCode
);

// ─────────────────────────────────────────────
// Broadcast notification
// ─────────────────────────────────────────────

/**
 * POST /admin/notifications/broadcast
 * Send in-app + push notification to all users or a filtered subset.
 * Optional filter: { role, status }
 */
adminRouter.post(
  '/notifications/broadcast',
  validate(BroadcastNotificationSchema),
  controller.broadcastNotification
);

// ─────────────────────────────────────────────
// Audit logs
// ─────────────────────────────────────────────

/**
 * GET /admin/audit-logs
 * Query audit log. Filter: actor_id, action, entity_type, entity_id, date range.
 */
adminRouter.get(
  '/audit-logs',
  validate(AuditLogQuerySchema, 'query'),
  controller.listAuditLogs
);
