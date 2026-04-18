-- ─────────────────────────────────────────────────────────────
-- JustPark — Initial Database Migration
-- PostgreSQL 16 + PostGIS 3.4
--
-- Run order:
--   1. Extensions
--   2. Enum types
--   3. Tables (dependencies first)
--   4. Indexes (including spatial)
--   5. Constraints (check, exclusion)
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────
-- 1. EXTENSIONS
-- ─────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- required for exclusion constraint

-- ─────────────────────────────────────────────
-- 2. ENUM TYPES
-- ─────────────────────────────────────────────

CREATE TYPE "UserRole" AS ENUM ('user', 'host', 'admin');
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended', 'deactivated');
CREATE TYPE "OtpType" AS ENUM ('email_verify', 'phone_verify', 'password_reset');
CREATE TYPE "SocialProvider" AS ENUM ('google', 'apple');
CREATE TYPE "KycDocumentType" AS ENUM ('id_card', 'passport', 'driving_license', 'business_registration');
CREATE TYPE "KycStatus" AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE "VehicleType" AS ENUM ('car', 'bike', 'ev', 'truck', 'van');
CREATE TYPE "SpaceType" AS ENUM ('open_air', 'covered', 'garage', 'indoor', 'underground');
CREATE TYPE "SpaceStatus" AS ENUM ('draft', 'pending_review', 'active', 'paused', 'rejected', 'deleted');
CREATE TYPE "CancellationPolicy" AS ENUM ('flexible', 'moderate', 'strict');
CREATE TYPE "Amenity" AS ENUM (
  'cctv', 'ev_charging', '24x7_access', 'gated', 'covered',
  'security_guard', 'lighting', 'wheelchair_accessible',
  'ev_type1', 'ev_type2', 'ev_ccs', 'ev_chademo'
);
CREATE TYPE "RateType" AS ENUM ('hourly', 'daily', 'monthly');
CREATE TYPE "BookingStatus" AS ENUM ('pending', 'confirmed', 'active', 'completed', 'cancelled', 'no_show', 'disputed');
CREATE TYPE "CancelledBy" AS ENUM ('user', 'host', 'admin');
CREATE TYPE "PaymentMethod" AS ENUM ('card', 'upi', 'net_banking', 'wallet', 'wallet_card_split');
CREATE TYPE "TransactionStatus" AS ENUM ('pending', 'processing', 'completed', 'failed', 'refunded', 'partially_refunded');
CREATE TYPE "PaymentGateway" AS ENUM ('stripe', 'razorpay');
CREATE TYPE "RefundStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE "RefundTo" AS ENUM ('original_method', 'wallet');
CREATE TYPE "WalletTransactionType" AS ENUM ('top_up', 'payment', 'refund', 'cashback', 'admin_credit', 'admin_debit', 'withdrawal');
CREATE TYPE "ReviewStatus" AS ENUM ('active', 'flagged', 'removed');
CREATE TYPE "DiscountType" AS ENUM ('percentage', 'flat');
CREATE TYPE "EarningStatus" AS ENUM ('pending', 'available', 'paid_out', 'on_hold');
CREATE TYPE "PayoutStatus" AS ENUM ('requested', 'processing', 'completed', 'failed');
CREATE TYPE "TicketStatus" AS ENUM ('open', 'in_progress', 'resolved', 'closed');
CREATE TYPE "TicketPriority" AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE "ResolutionType" AS ENUM ('refund', 'partial_refund', 'no_action', 'credit');

-- ─────────────────────────────────────────────
-- 3. TABLES
-- ─────────────────────────────────────────────

-- users
CREATE TABLE users (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  email          VARCHAR(255) NOT NULL UNIQUE,
  phone          VARCHAR(20)  UNIQUE,
  password_hash  VARCHAR(255),
  first_name     VARCHAR(100) NOT NULL,
  last_name      VARCHAR(100) NOT NULL,
  role           "UserRole"   NOT NULL DEFAULT 'user',
  avatar_url     VARCHAR(500),
  email_verified BOOLEAN      NOT NULL DEFAULT false,
  phone_verified BOOLEAN      NOT NULL DEFAULT false,
  status         "UserStatus" NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- sessions
CREATE TABLE sessions (
  id                 UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(255) NOT NULL,
  device_info        JSONB,
  ip_address         VARCHAR(45),
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- otp_tokens
CREATE TABLE otp_tokens (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  otp_hash   VARCHAR(255) NOT NULL,
  type       "OtpType"   NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- social_auth_providers
CREATE TABLE social_auth_providers (
  id               UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         "SocialProvider" NOT NULL,
  provider_user_id VARCHAR(255)     NOT NULL,
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);

-- kyc_documents
CREATE TABLE kyc_documents (
  id            UUID                PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID                NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type "KycDocumentType"   NOT NULL,
  document_url  VARCHAR(500)        NOT NULL,
  status        "KycStatus"         NOT NULL DEFAULT 'pending',
  admin_notes   TEXT,
  reviewed_by   UUID                REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

-- vehicles
CREATE TABLE vehicles (
  id           UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plate_number VARCHAR(20)   NOT NULL,
  type         "VehicleType" NOT NULL,
  make         VARCHAR(100),
  model        VARCHAR(100),
  color        VARCHAR(50),
  is_default   BOOLEAN       NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- parking_spaces (PostGIS geography column)
CREATE TABLE parking_spaces (
  id                           UUID                 PRIMARY KEY DEFAULT uuid_generate_v4(),
  host_id                      UUID                 NOT NULL REFERENCES users(id),
  name                         VARCHAR(200)         NOT NULL,
  description                  TEXT,
  address_line1                VARCHAR(255)         NOT NULL,
  address_line2                VARCHAR(255),
  city                         VARCHAR(100)         NOT NULL,
  state                        VARCHAR(100)         NOT NULL,
  postal_code                  VARCHAR(20)          NOT NULL,
  country                      VARCHAR(2)           NOT NULL DEFAULT 'IN',
  location                     geography(Point, 4326),
  geohash                      VARCHAR(12),
  space_type                   "SpaceType"          NOT NULL,
  total_capacity               INTEGER              NOT NULL DEFAULT 1,
  allowed_vehicles             TEXT[]               NOT NULL DEFAULT '{}',
  status                       "SpaceStatus"        NOT NULL DEFAULT 'draft',
  cancellation_policy          "CancellationPolicy" NOT NULL DEFAULT 'flexible',
  min_booking_duration_minutes INTEGER,
  max_booking_duration_minutes INTEGER,
  buffer_minutes               INTEGER              NOT NULL DEFAULT 0,
  instant_book                 BOOLEAN              NOT NULL DEFAULT true,
  created_at                   TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ          NOT NULL DEFAULT NOW()
);

-- space_photos
CREATE TABLE space_photos (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  space_id      UUID        NOT NULL REFERENCES parking_spaces(id) ON DELETE CASCADE,
  url           VARCHAR(500) NOT NULL,
  display_order INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- space_amenities
CREATE TABLE space_amenities (
  id       UUID      PRIMARY KEY DEFAULT uuid_generate_v4(),
  space_id UUID      NOT NULL REFERENCES parking_spaces(id) ON DELETE CASCADE,
  amenity  "Amenity" NOT NULL,
  UNIQUE (space_id, amenity)
);

-- space_schedules
CREATE TABLE space_schedules (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  space_id    UUID        NOT NULL REFERENCES parking_spaces(id) ON DELETE CASCADE,
  day_of_week INTEGER     NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  open_time   VARCHAR(5)  NOT NULL,   -- "HH:mm"
  close_time  VARCHAR(5)  NOT NULL,   -- "HH:mm"
  is_closed   BOOLEAN     NOT NULL DEFAULT false,
  UNIQUE (space_id, day_of_week)
);

-- space_blackout_dates
CREATE TABLE space_blackout_dates (
  id       UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  space_id UUID        NOT NULL REFERENCES parking_spaces(id) ON DELETE CASCADE,
  date     DATE        NOT NULL,
  reason   VARCHAR(255)
);

-- space_pricing_rules
CREATE TABLE space_pricing_rules (
  id                 UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  space_id           UUID        NOT NULL REFERENCES parking_spaces(id) ON DELETE CASCADE,
  rate_type          "RateType"  NOT NULL,
  base_rate          NUMERIC(10, 2) NOT NULL,
  currency           VARCHAR(3)  NOT NULL DEFAULT 'INR',
  peak_rules         JSONB,
  weekend_multiplier NUMERIC(4, 2),
  discount_rules     JSONB,
  min_price          NUMERIC(10, 2),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (space_id, rate_type)
);

-- promo_codes (declared before bookings for FK)
CREATE TABLE promo_codes (
  id                 UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  code               VARCHAR(50)    NOT NULL UNIQUE,
  discount_type      "DiscountType" NOT NULL,
  discount_value     NUMERIC(10, 2) NOT NULL,
  max_discount       NUMERIC(10, 2),
  min_booking_amount NUMERIC(10, 2),
  usage_limit        INTEGER,
  used_count         INTEGER        NOT NULL DEFAULT 0,
  valid_from         TIMESTAMPTZ    NOT NULL,
  valid_until        TIMESTAMPTZ    NOT NULL,
  active             BOOLEAN        NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- bookings
CREATE TABLE bookings (
  id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID            NOT NULL REFERENCES users(id),
  space_id            UUID            NOT NULL REFERENCES parking_spaces(id),
  vehicle_id          UUID            NOT NULL REFERENCES vehicles(id),
  start_time          TIMESTAMPTZ     NOT NULL,
  end_time            TIMESTAMPTZ     NOT NULL,
  status              "BookingStatus" NOT NULL DEFAULT 'pending',
  base_price          NUMERIC(10, 2)  NOT NULL,
  platform_fee        NUMERIC(10, 2)  NOT NULL,
  tax_amount          NUMERIC(10, 2)  NOT NULL,
  discount_amount     NUMERIC(10, 2)  NOT NULL DEFAULT 0,
  total_price         NUMERIC(10, 2)  NOT NULL,
  promo_code_id       UUID            REFERENCES promo_codes(id),
  cancellation_reason TEXT,
  cancelled_by        "CancelledBy",
  refund_amount       NUMERIC(10, 2),
  host_note           TEXT,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_booking_times CHECK (end_time > start_time)
);

-- booking_locks
CREATE TABLE booking_locks (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  space_id        UUID        NOT NULL REFERENCES parking_spaces(id) ON DELETE CASCADE,
  start_time      TIMESTAMPTZ NOT NULL,
  end_time        TIMESTAMPTZ NOT NULL,
  locked_by       UUID        NOT NULL REFERENCES users(id),
  lock_expires_at TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- transactions
CREATE TABLE transactions (
  id              UUID                PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id      UUID                NOT NULL REFERENCES bookings(id),
  user_id         UUID                NOT NULL REFERENCES users(id),
  amount          NUMERIC(10, 2)      NOT NULL,
  currency        VARCHAR(3)          NOT NULL DEFAULT 'INR',
  payment_method  "PaymentMethod"     NOT NULL,
  status          "TransactionStatus" NOT NULL DEFAULT 'pending',
  gateway         "PaymentGateway"    NOT NULL,
  gateway_ref     VARCHAR(255),
  idempotency_key VARCHAR(255)        NOT NULL UNIQUE,
  metadata        JSONB,
  created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

-- refunds
CREATE TABLE refunds (
  id                 UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id     UUID           NOT NULL REFERENCES transactions(id),
  amount             NUMERIC(10, 2) NOT NULL,
  reason             TEXT,
  status             "RefundStatus" NOT NULL DEFAULT 'pending',
  refund_to          "RefundTo"     NOT NULL,
  gateway_refund_ref VARCHAR(255),
  processed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- saved_payment_methods
CREATE TABLE saved_payment_methods (
  id             UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gateway        "PaymentGateway" NOT NULL,
  token          VARCHAR(255)     NOT NULL,
  card_last_four VARCHAR(4),
  card_brand     VARCHAR(50),
  is_default     BOOLEAN          NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- wallets
CREATE TABLE wallets (
  id         UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID           NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance    NUMERIC(10, 2) NOT NULL DEFAULT 0,
  currency   VARCHAR(3)     NOT NULL DEFAULT 'INR',
  updated_at TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wallet_balance_non_negative CHECK (balance >= 0)
);

-- wallet_transactions
CREATE TABLE wallet_transactions (
  id             UUID                    PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id      UUID                    NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  type           "WalletTransactionType" NOT NULL,
  amount         NUMERIC(10, 2)          NOT NULL,
  reference_type VARCHAR(50),
  reference_id   UUID,
  description    TEXT,
  balance_after  NUMERIC(10, 2)          NOT NULL,
  created_at     TIMESTAMPTZ             NOT NULL DEFAULT NOW()
);

-- notifications
CREATE TABLE notifications (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(100) NOT NULL,
  title      VARCHAR(255) NOT NULL,
  body       TEXT         NOT NULL,
  data       JSONB,
  read       BOOLEAN      NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- notification_preferences
CREATE TABLE notification_preferences (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type    VARCHAR(100) NOT NULL,
  push_enabled  BOOLEAN      NOT NULL DEFAULT true,
  email_enabled BOOLEAN      NOT NULL DEFAULT true,
  sms_enabled   BOOLEAN      NOT NULL DEFAULT false,
  UNIQUE (user_id, event_type)
);

-- reviews
CREATE TABLE reviews (
  id          UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id  UUID           NOT NULL UNIQUE REFERENCES bookings(id),
  reviewer_id UUID           NOT NULL REFERENCES users(id),
  reviewee_id UUID           REFERENCES users(id),
  space_id    UUID           REFERENCES parking_spaces(id),
  rating      INTEGER        NOT NULL,
  body        TEXT,
  status      "ReviewStatus" NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_review_rating CHECK (rating >= 1 AND rating <= 5)
);

-- review_responses
CREATE TABLE review_responses (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  review_id  UUID        NOT NULL UNIQUE REFERENCES reviews(id) ON DELETE CASCADE,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- host_earnings
CREATE TABLE host_earnings (
  id                UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  host_id           UUID            NOT NULL REFERENCES users(id),
  booking_id        UUID            NOT NULL UNIQUE REFERENCES bookings(id),
  gross_amount      NUMERIC(10, 2)  NOT NULL,
  commission_amount NUMERIC(10, 2)  NOT NULL,
  net_amount        NUMERIC(10, 2)  NOT NULL,
  status            "EarningStatus" NOT NULL DEFAULT 'pending',
  available_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- bank_accounts
CREATE TABLE bank_accounts (
  id                       UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  host_id                  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_holder_name      VARCHAR(200) NOT NULL,
  account_number_encrypted VARCHAR(500) NOT NULL,
  ifsc_code                VARCHAR(20)  NOT NULL,
  bank_name                VARCHAR(100) NOT NULL,
  is_default               BOOLEAN      NOT NULL DEFAULT false,
  is_verified              BOOLEAN      NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- payouts
CREATE TABLE payouts (
  id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  host_id         UUID            NOT NULL REFERENCES users(id),
  amount          NUMERIC(10, 2)  NOT NULL,
  bank_account_id UUID            NOT NULL REFERENCES bank_accounts(id),
  status          "PayoutStatus"  NOT NULL DEFAULT 'requested',
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- audit_logs
CREATE TABLE audit_logs (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id    UUID        REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id   UUID,
  metadata    JSONB,
  ip_address  VARCHAR(45),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- support_tickets
CREATE TABLE support_tickets (
  id          UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID             NOT NULL REFERENCES users(id),
  booking_id  UUID             REFERENCES bookings(id),
  category    VARCHAR(100)     NOT NULL,
  subject     VARCHAR(255)     NOT NULL,
  description TEXT             NOT NULL,
  status      "TicketStatus"   NOT NULL DEFAULT 'open',
  priority    "TicketPriority" NOT NULL DEFAULT 'medium',
  assigned_to UUID             REFERENCES users(id),
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- disputes
CREATE TABLE disputes (
  id              UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id       UUID             NOT NULL UNIQUE REFERENCES support_tickets(id),
  booking_id      UUID             NOT NULL UNIQUE REFERENCES bookings(id),
  raised_by       UUID             NOT NULL REFERENCES users(id),
  reason          TEXT             NOT NULL,
  resolution      TEXT,
  resolution_type "ResolutionType",
  resolved_by     UUID             REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- platform_config
CREATE TABLE platform_config (
  key        VARCHAR(100) PRIMARY KEY,
  value      JSONB        NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- favorites
CREATE TABLE favorites (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id   UUID        NOT NULL REFERENCES parking_spaces(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, space_id)
);

-- ─────────────────────────────────────────────
-- 4. INDEXES
-- ─────────────────────────────────────────────

-- users
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);

-- sessions
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_refresh_token_hash ON sessions(refresh_token_hash);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- otp_tokens
CREATE INDEX idx_otp_tokens_user_id ON otp_tokens(user_id);
CREATE INDEX idx_otp_tokens_expires_at ON otp_tokens(expires_at);

-- social_auth_providers
CREATE INDEX idx_social_auth_user_id ON social_auth_providers(user_id);

-- kyc_documents
CREATE INDEX idx_kyc_user_id ON kyc_documents(user_id);
CREATE INDEX idx_kyc_status ON kyc_documents(status);

-- vehicles
CREATE INDEX idx_vehicles_user_id ON vehicles(user_id);

-- parking_spaces — spatial + regular indexes
CREATE INDEX idx_spaces_location ON parking_spaces USING GIST(location);
CREATE INDEX idx_spaces_geohash ON parking_spaces(geohash);
CREATE INDEX idx_spaces_host_id ON parking_spaces(host_id);
CREATE INDEX idx_spaces_status ON parking_spaces(status);
CREATE INDEX idx_spaces_city ON parking_spaces(city);
CREATE INDEX idx_spaces_space_type ON parking_spaces(space_type);
-- Full-text search on name and description
CREATE INDEX idx_spaces_name_fts ON parking_spaces USING GIN(to_tsvector('english', name));
CREATE INDEX idx_spaces_description_fts ON parking_spaces USING GIN(to_tsvector('english', COALESCE(description, '')));
-- Trigram for fuzzy search
CREATE INDEX idx_spaces_name_trgm ON parking_spaces USING GIN(name gin_trgm_ops);

-- space_photos
CREATE INDEX idx_space_photos_space_id ON space_photos(space_id);

-- space_blackout_dates
CREATE INDEX idx_blackout_space_date ON space_blackout_dates(space_id, date);

-- space_pricing_rules
CREATE INDEX idx_pricing_space_id ON space_pricing_rules(space_id);

-- bookings
CREATE INDEX idx_bookings_user_id ON bookings(user_id);
CREATE INDEX idx_bookings_space_id ON bookings(space_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_times ON bookings(start_time, end_time);
CREATE INDEX idx_bookings_space_times ON bookings(space_id, start_time, end_time);

-- booking_locks
CREATE INDEX idx_booking_locks_space_id ON booking_locks(space_id);
CREATE INDEX idx_booking_locks_expires_at ON booking_locks(lock_expires_at);

-- transactions
CREATE INDEX idx_transactions_booking_id ON transactions(booking_id);
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE UNIQUE INDEX idx_transactions_idempotency ON transactions(idempotency_key);

-- refunds
CREATE INDEX idx_refunds_transaction_id ON refunds(transaction_id);
CREATE INDEX idx_refunds_status ON refunds(status);

-- saved_payment_methods
CREATE INDEX idx_saved_methods_user_id ON saved_payment_methods(user_id);

-- wallet_transactions
CREATE INDEX idx_wallet_txns_wallet_id ON wallet_transactions(wallet_id);
CREATE INDEX idx_wallet_txns_created_at ON wallet_transactions(created_at);

-- notifications
CREATE INDEX idx_notifications_user_read ON notifications(user_id, read);
CREATE INDEX idx_notifications_created_at ON notifications(created_at);

-- reviews
CREATE INDEX idx_reviews_space_id ON reviews(space_id);
CREATE INDEX idx_reviews_reviewer_id ON reviews(reviewer_id);
CREATE INDEX idx_reviews_status ON reviews(status);

-- promo_codes
CREATE INDEX idx_promo_codes_code ON promo_codes(code);
CREATE INDEX idx_promo_codes_active_valid ON promo_codes(active, valid_until);

-- host_earnings
CREATE INDEX idx_host_earnings_host_id ON host_earnings(host_id);
CREATE INDEX idx_host_earnings_status ON host_earnings(status);
CREATE INDEX idx_host_earnings_available_at ON host_earnings(available_at);

-- payouts
CREATE INDEX idx_payouts_host_id ON payouts(host_id);
CREATE INDEX idx_payouts_status ON payouts(status);

-- bank_accounts
CREATE INDEX idx_bank_accounts_host_id ON bank_accounts(host_id);

-- audit_logs
CREATE INDEX idx_audit_logs_actor_id ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

-- support_tickets
CREATE INDEX idx_tickets_user_id ON support_tickets(user_id);
CREATE INDEX idx_tickets_status ON support_tickets(status);
CREATE INDEX idx_tickets_priority ON support_tickets(priority);

-- disputes
CREATE INDEX idx_disputes_raised_by ON disputes(raised_by);

-- favorites
CREATE INDEX idx_favorites_user_id ON favorites(user_id);

-- ─────────────────────────────────────────────
-- 5. SPECIAL CONSTRAINTS
-- ─────────────────────────────────────────────

-- Booking overlap exclusion constraint using tstzrange
-- Prevents double-booking the same space for overlapping time windows
-- Only applies to confirmed and active bookings
ALTER TABLE bookings ADD CONSTRAINT no_overlapping_bookings
  EXCLUDE USING GIST (
    space_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  )
  WHERE (status IN ('confirmed', 'active'));

-- ─────────────────────────────────────────────
-- 6. DEFAULT PLATFORM CONFIG
-- ─────────────────────────────────────────────

INSERT INTO platform_config (key, value) VALUES
  ('commission_rate',        '{"value": 0.15, "description": "Platform commission (15%)"}'),
  ('tax_rate',               '{"value": 0.18, "description": "GST rate (18%)"}'),
  ('dispute_window_hours',   '{"value": 72, "description": "Hours before earnings become available"}'),
  ('slot_lock_ttl_seconds',  '{"value": 600, "description": "Slot lock TTL (10 minutes)"}'),
  ('max_search_radius_m',    '{"value": 10000, "description": "Max geo search radius in meters"}'),
  ('default_search_radius_m','{"value": 2000, "description": "Default geo search radius in meters"}'),
  ('max_photos_per_space',   '{"value": 10, "description": "Maximum photos per parking space"}'),
  ('otp_expiry_minutes',     '{"value": 10, "description": "OTP validity window in minutes"}'),
  ('instant_payout_fee_pct', '{"value": 0.01, "description": "Instant payout fee (1%)"}'),
  ('booking_reminder_minutes','{"value": 60, "description": "Booking reminder before start (minutes)"}'),
  ('expiry_warning_minutes', '{"value": 30, "description": "Booking expiry warning before end (minutes)"}');
