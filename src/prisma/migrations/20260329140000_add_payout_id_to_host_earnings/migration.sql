-- Add payout_id FK to host_earnings.
-- Nullable: only set when an earning is moved to on_hold for a specific payout.
-- ON DELETE SET NULL: if a payout row is deleted the earning is detached but not lost.

ALTER TABLE "host_earnings" ADD COLUMN "payout_id" UUID;

ALTER TABLE "host_earnings"
  ADD CONSTRAINT "host_earnings_payout_id_fkey"
  FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE SET NULL;

CREATE INDEX "host_earnings_payout_id_idx" ON "host_earnings"("payout_id");
