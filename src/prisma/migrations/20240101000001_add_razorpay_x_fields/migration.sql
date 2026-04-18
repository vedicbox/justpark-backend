-- Migration: add_razorpay_x_fields
-- Adds Razorpay X payout tracking columns to bank_accounts and payouts tables.

-- ─────────────────────────────────────────────
-- bank_accounts — Razorpay X Contact & Fund Account IDs
-- ─────────────────────────────────────────────
ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS razorpay_contact_id      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS razorpay_fund_account_id  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ─────────────────────────────────────────────
-- payouts — Razorpay X Payout tracking fields
-- ─────────────────────────────────────────────
ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS razorpay_payout_id VARCHAR(100) UNIQUE,
  ADD COLUMN IF NOT EXISTS idempotency_key    VARCHAR(100) NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN IF NOT EXISTS utr               VARCHAR(100),
  ADD COLUMN IF NOT EXISTS failure_reason    TEXT,
  ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Ensure idempotency_key is unique
CREATE UNIQUE INDEX IF NOT EXISTS payouts_idempotency_key_key ON payouts (idempotency_key);

-- Index on razorpay_payout_id for fast webhook lookups
CREATE INDEX IF NOT EXISTS payouts_razorpay_payout_id_idx ON payouts (razorpay_payout_id)
  WHERE razorpay_payout_id IS NOT NULL;

-- Auto-update updated_at trigger for bank_accounts
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_bank_accounts_updated_at'
  ) THEN
    CREATE TRIGGER set_bank_accounts_updated_at
      BEFORE UPDATE ON bank_accounts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_payouts_updated_at'
  ) THEN
    CREATE TRIGGER set_payouts_updated_at
      BEFORE UPDATE ON payouts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
