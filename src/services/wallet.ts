import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { ErrorCode } from '../types';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
export interface WalletCreditParams {
  userId:        string;
  amount:        number;
  type:          'top_up' | 'refund' | 'cashback' | 'admin_credit';
  referenceType?: string;
  referenceId?:  string;
  description?:  string;
}

export interface WalletDebitParams {
  userId:        string;
  amount:        number;
  type:          'payment' | 'admin_debit' | 'withdrawal';
  referenceType?: string;
  referenceId?:  string;
  description?:  string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────
// getOrCreateWallet
// ─────────────────────────────────────────────
export async function getOrCreateWallet(userId: string, currency = 'INR') {
  return prisma.wallet.upsert({
    where:  { user_id: userId },
    create: { user_id: userId, balance: 0, currency },
    update: {},
    select: { id: true, user_id: true, balance: true, reserved_balance: true, currency: true, updated_at: true },
  });
}

// ─────────────────────────────────────────────
// getBalance
// ─────────────────────────────────────────────
export async function getBalance(userId: string) {
  const wallet = await getOrCreateWallet(userId);
  return { balance: round2(Number(wallet.balance)), currency: wallet.currency };
}

// ─────────────────────────────────────────────
// creditWallet  (atomic: update balance + create transaction record)
// ─────────────────────────────────────────────
export async function creditWallet(params: WalletCreditParams): Promise<{ newBalance: number }> {
  const { userId, amount, type, referenceType, referenceId, description } = params;

  if (amount <= 0) {
    throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Credit amount must be positive');
  }

  const creditAmount = round2(amount);

  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.upsert({
      where:  { user_id: userId },
      create: { user_id: userId, balance: 0, currency: 'INR' },
      update: {},
    });

    const newBalance = round2(Number(wallet.balance) + creditAmount);

    await tx.wallet.update({
      where: { id: wallet.id },
      data:  { balance: newBalance },
    });

    await tx.walletTransaction.create({
      data: {
        wallet_id:      wallet.id,
        type,
        amount:         creditAmount,
        reference_type: referenceType ?? null,
        reference_id:   referenceId   ?? null,
        description:    description   ?? null,
        balance_after:  newBalance,
      },
    });

    return { newBalance };
  });

  return result;
}

// ─────────────────────────────────────────────
// debitWallet  (atomic: check balance, update balance + create transaction record)
// Throws INSUFFICIENT_WALLET_BALANCE if balance < amount.
// ─────────────────────────────────────────────
export async function debitWallet(params: WalletDebitParams): Promise<{ newBalance: number }> {
  const { userId, amount, type, referenceType, referenceId, description } = params;

  if (amount <= 0) {
    throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Debit amount must be positive');
  }

  const debitAmount = round2(amount);

  const result = await prisma.$transaction(async (tx) => {
    // SELECT FOR UPDATE to prevent race conditions
    const wallets = await tx.$queryRaw<Array<{ id: string; balance: string; currency: string }>>`
      SELECT id, balance::text, currency
      FROM wallets
      WHERE user_id = ${userId}::uuid
      FOR UPDATE
    `;

    if (wallets.length === 0) {
      throw AppError.conflict(
        ErrorCode.INSUFFICIENT_WALLET_BALANCE,
        'Wallet not found. Please add funds to your wallet first.'
      );
    }

    const wallet     = wallets[0];
    const balance    = round2(Number(wallet.balance));
    const newBalance = round2(balance - debitAmount);

    if (newBalance < 0) {
      throw AppError.conflict(
        ErrorCode.INSUFFICIENT_WALLET_BALANCE,
        `Insufficient balance. Available: ₹${balance.toFixed(2)}, Required: ₹${debitAmount.toFixed(2)}`
      );
    }

    await tx.wallet.update({
      where: { id: wallet.id },
      data:  { balance: newBalance },
    });

    await tx.walletTransaction.create({
      data: {
        wallet_id:      wallet.id,
        type,
        amount:         debitAmount,
        reference_type: referenceType ?? null,
        reference_id:   referenceId   ?? null,
        description:    description   ?? null,
        balance_after:  newBalance,
      },
    });

    return { newBalance };
  });

  return result;
}
