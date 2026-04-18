import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import * as walletService from './service';
import {
  TopUpSchema,
  TopUpConfirmSchema,
  TopUpVerifyRazorpaySchema,
  WalletTransactionQuerySchema,
  WithdrawSchema,
  AdminWalletAdjustSchema,
  UserIdParamSchema,
} from './validators';

// ─────────────────────────────────────────────
// GET /wallet
// ─────────────────────────────────────────────
export async function getWallet(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const wallet = await walletService.getWallet(req.user!.sub);
    Respond.ok(res, wallet);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /wallet/topup
// ─────────────────────────────────────────────
export async function createTopUp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = TopUpSchema.parse(req.body);
    const result = await walletService.createTopUpIntent(req.user!.sub, body);
    Respond.created(res, result, 'Top-up payment initiated');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /wallet/topup/confirm  (Stripe — post-3DS)
// ─────────────────────────────────────────────
export async function confirmTopUp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = TopUpConfirmSchema.parse(req.body);
    const result = await walletService.confirmTopUpStripe(req.user!.sub, body);
    Respond.ok(res, result, result.credited ? 'Wallet topped up successfully' : 'Already credited');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /wallet/topup/verify  (Razorpay)
// ─────────────────────────────────────────────
export async function verifyTopUp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = TopUpVerifyRazorpaySchema.parse(req.body);
    const result = await walletService.verifyTopUpRazorpay(req.user!.sub, body);
    Respond.ok(res, result, result.credited ? 'Wallet topped up successfully' : 'Already credited');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /wallet/transactions
// ─────────────────────────────────────────────
export async function getTransactions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = WalletTransactionQuerySchema.parse(req.query);
    const { transactions, meta } = await walletService.getTransactionHistory(req.user!.sub, query);
    Respond.ok(res, transactions, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /wallet/withdraw
// ─────────────────────────────────────────────
export async function requestWithdrawal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = WithdrawSchema.parse(req.body);
    const result = await walletService.requestWithdrawal(req.user!.sub, body);
    Respond.created(res, result, 'Withdrawal request submitted');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /admin/wallet/:userId/adjust
// (Mounted from admin routes)
// ─────────────────────────────────────────────
export async function adminAdjust(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = UserIdParamSchema.parse(req.params);
    const body = AdminWalletAdjustSchema.parse(req.body);
    const result = await walletService.adminAdjustWallet(req.user!.sub, userId, body);
    Respond.ok(res, result, `Wallet ${body.type === 'credit' ? 'credited' : 'debited'} successfully`);
  } catch (err) { next(err); }
}
