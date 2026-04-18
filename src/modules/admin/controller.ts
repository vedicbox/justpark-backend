import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import { buildPaginationMeta } from '../../utils/pagination';
import * as adminService from './service';
import { adminInitiateRefund } from '../payments/service';
import { adminAdjustWallet } from '../wallet/service';

import {
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
} from './validators';

// ─────────────────────────────────────────────
// GET /admin/spaces
// ─────────────────────────────────────────────
export async function listAllSpaces(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = AdminListSpacesQuerySchema.parse(req.query);
    const { spaces, total, page, limit } = await adminService.listAllSpaces(query);
    Respond.ok(res, spaces, undefined, buildPaginationMeta(total, page, limit));
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /admin/spaces/:id
// ─────────────────────────────────────────────
export async function getSpaceDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = AdminSpaceIdParamSchema.parse(req.params);
    const space = await adminService.getSpaceById(id);
    Respond.ok(res, space);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /admin/spaces/:id/approve
// ─────────────────────────────────────────────
export async function approveSpace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = AdminSpaceIdParamSchema.parse(req.params);
    const space = await adminService.approveSpace(id, req.user!.sub);
    Respond.ok(res, space, 'Space approved and is now active');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /admin/spaces/:id/reject
// ─────────────────────────────────────────────
export async function rejectSpace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = AdminSpaceIdParamSchema.parse(req.params);
    const body = RejectSpaceSchema.parse(req.body);
    const space = await adminService.rejectSpace(id, req.user!.sub, body);
    Respond.ok(res, space, 'Space rejected');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /admin/transactions/:id/refund
// ─────────────────────────────────────────────
export async function adminRefund(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = TransactionIdParamSchema.parse(req.params);
    const body = AdminRefundSchema.parse(req.body);
    const result  = await adminInitiateRefund(req.user!.sub, id, body);
    Respond.ok(res, result, 'Refund initiated successfully');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /admin/wallet/:userId/adjust
// ─────────────────────────────────────────────
export async function adminWalletAdjust(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = UserIdParamSchema.parse(req.params);
    const body = AdminWalletAdjustSchema.parse(req.body);
    const result = await adminAdjustWallet(req.user!.sub, userId, body);
    Respond.ok(res, result, `Wallet ${body.type === 'credit' ? 'credited' : 'debited'} successfully`);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /admin/payouts
// ─────────────────────────────────────────────
export async function listAllPayouts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = AdminListPayoutsQuerySchema.parse(req.query);
    const { payouts, meta } = await adminService.listAllPayouts(query);
    Respond.ok(res, payouts, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /admin/payouts/:id/process
// ─────────────────────────────────────────────
export async function processPayoutRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = AdminPayoutIdParamSchema.parse(req.params);
    const body = ProcessPayoutSchema.parse(req.body);
    const result  = await adminService.processPayout(id, req.user!.sub, body);
    Respond.ok(res, result, `Payout marked as ${body.status}`);
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// USER MANAGEMENT
// ═════════════════════════════════════════════

import {
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
  AdminListBankAccountsQuerySchema,
  BankAccountIdParamSchema,
} from './validators';

export async function listAllUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = AdminListUsersQuerySchema.parse(req.query);
    const { users, meta } = await adminService.listAllUsers(query);
    Respond.ok(res, users, undefined, meta);
  } catch (err) { next(err); }
}

export async function getUserDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = AdminUserIdParamSchema.parse(req.params);
    const user = await adminService.getUserDetail(id);
    Respond.ok(res, user);
  } catch (err) { next(err); }
}

export async function updateUserStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = AdminUserIdParamSchema.parse(req.params);
    const body = AdminUpdateUserStatusSchema.parse(req.body);
    const result = await adminService.updateUserStatus(id, req.user!.sub, body);
    Respond.ok(res, result, `User status updated to ${body.status}`);
  } catch (err) { next(err); }
}

export async function updateUserRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = AdminUserIdParamSchema.parse(req.params);
    const body = AdminUpdateUserRoleSchema.parse(req.body);
    const result = await adminService.updateUserRole(id, req.user!.sub, body);
    Respond.ok(res, result, `User role updated to ${body.role}`);
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// KYC MANAGEMENT
// ═════════════════════════════════════════════

export async function listPendingKyc(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = AdminListKycQuerySchema.parse(req.query);
    const { docs, meta } = await adminService.listPendingKyc(query);
    Respond.ok(res, docs, undefined, meta);
  } catch (err) { next(err); }
}

export async function approveKyc(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = KycIdParamSchema.parse(req.params);
    const result = await adminService.approveKyc(id, req.user!.sub);
    Respond.ok(res, result, 'KYC approved');
  } catch (err) { next(err); }
}

export async function rejectKyc(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = KycIdParamSchema.parse(req.params);
    const body = KycRejectSchema.parse(req.body);
    const result = await adminService.rejectKyc(id, req.user!.sub, body);
    Respond.ok(res, result, 'KYC rejected');
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// BOOKING OVERSIGHT
// ═════════════════════════════════════════════

export async function listAllBookings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = AdminListBookingsQuerySchema.parse(req.query);
    const { bookings, meta } = await adminService.listAllBookings(query);
    Respond.ok(res, bookings, undefined, meta);
  } catch (err) { next(err); }
}

export async function adminCancelBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const bookingId = req.params.id;
    const { reason } = req.body;
    const booking = await adminService.adminCancelBooking(bookingId, reason);
    Respond.ok(res, booking, 'Booking cancelled successfully');
  } catch (err) { next(err); }
}

export async function adminRefundBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const bookingId = req.params.id;
    const { amount } = req.body;
    const result = await adminService.adminRefundBooking(bookingId, amount ? Number(amount) : undefined, req.user!.sub);
    Respond.ok(res, result, 'Refund issued successfully');
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// TRANSACTION MANAGEMENT
// ═════════════════════════════════════════════

export async function listAllTransactions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = AdminListTransactionsQuerySchema.parse(req.query);
    const { transactions, meta } = await adminService.listAllTransactions(query);
    Respond.ok(res, transactions, undefined, meta);
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// PLATFORM CONFIG
// ═════════════════════════════════════════════

export async function getPlatformConfig(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const config = await adminService.getPlatformConfig();
    Respond.ok(res, config);
  } catch (err) { next(err); }
}

export async function updatePlatformConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = UpdatePlatformConfigSchema.parse(req.body);
    const config = await adminService.updatePlatformConfig(req.user!.sub, body);
    Respond.ok(res, config, 'Platform config updated');
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// ANALYTICS
// ═════════════════════════════════════════════

export async function getAnalytics(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const analytics = await adminService.getAnalytics();
    Respond.ok(res, analytics);
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// PROMO CODES
// ═════════════════════════════════════════════

export async function listPromoCodes(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = AdminListPromoCodesQuerySchema.parse(req.query);
    const { codes, meta } = await adminService.listPromoCodes(query);
    Respond.ok(res, codes, undefined, meta);
  } catch (err) { next(err); }
}

export async function createPromoCode(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = CreatePromoCodeSchema.parse(req.body);
    const code = await adminService.createPromoCode(req.user!.sub, body);
    Respond.created(res, code, 'Promo code created');
  } catch (err) { next(err); }
}

export async function updatePromoCode(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = PromoCodeIdParamSchema.parse(req.params);
    const body = UpdatePromoCodeSchema.parse(req.body);
    const code = await adminService.updatePromoCode(req.user!.sub, id, body);
    Respond.ok(res, code, 'Promo code updated');
  } catch (err) { next(err); }
}

export async function deactivatePromoCode(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = PromoCodeIdParamSchema.parse(req.params);
    const code = await adminService.deactivatePromoCode(req.user!.sub, id);
    Respond.ok(res, code, 'Promo code deactivated');
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// BROADCAST NOTIFICATION
// ═════════════════════════════════════════════

export async function broadcastNotification(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = BroadcastNotificationSchema.parse(req.body);
    const result = await adminService.broadcastNotification(req.user!.sub, body);
    Respond.ok(res, result, `Notification dispatched to ${result.dispatched} users`);
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// BANK ACCOUNT — RAZORPAY X REGISTRATION
// ═════════════════════════════════════════════

export async function listBankAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = AdminListBankAccountsQuerySchema.parse(req.query);
    const { accounts, total, page, limit } = await adminService.listBankAccounts(query);
    Respond.ok(res, accounts, undefined, buildPaginationMeta(total, page, limit));
  } catch (err) { next(err); }
}

export async function verifyBankAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = BankAccountIdParamSchema.parse(req.params);
    const result = await adminService.adminRegisterBankAccountWithRazorpayX(id, req.user!.sub);
    Respond.ok(res, result, 'Bank account registered with Razorpay X');
  } catch (err) { next(err); }
}

export async function markBankAccountVerified(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = BankAccountIdParamSchema.parse(req.params);
    const result = await adminService.adminMarkBankAccountVerified(id, req.user!.sub);
    Respond.ok(res, result, 'Bank account marked as verified');
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// AUDIT LOGS
// ═════════════════════════════════════════════

export async function listAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = AuditLogQuerySchema.parse(req.query);
    const { logs, meta } = await adminService.listAuditLogs(query);
    Respond.ok(res, logs, undefined, meta);
  } catch (err) { next(err); }
}
