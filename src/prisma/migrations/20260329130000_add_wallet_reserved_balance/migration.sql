-- Add reserved_balance to wallets table.
-- Tracks funds that are earmarked for a pending payout request so the spendable
-- balance (balance column) is always accurate. On withdrawal request the amount
-- moves from balance → reserved_balance.  On payout success it is cleared; on
-- payout failure it is moved back to balance with a refund WalletTransaction.
ALTER TABLE "wallets" ADD COLUMN "reserved_balance" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_reserved_balance_check" CHECK (reserved_balance >= 0);
