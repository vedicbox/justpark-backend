-- ============================================================
-- JustPark: Fresh Test Reset
-- Preserves : admin users, schema, platform_config, promo codes
-- Removes   : all transactional + non-admin user data
-- ============================================================

BEGIN;

-- ── 1. Disputes ─────────────────────────────────────────────
-- Must come before: support_tickets, bookings
DELETE FROM disputes;

-- ── 2. Refunds ──────────────────────────────────────────────
-- Must come before: transactions
DELETE FROM refunds;

-- ── 3. Support tickets ──────────────────────────────────────
-- Must come before: bookings (booking_id nullable but FK still enforced)
DELETE FROM support_tickets;

-- ── 4. Review responses ─────────────────────────────────────
-- CASCADE from reviews, but explicit is safer
DELETE FROM review_responses;

-- ── 5. Reviews ──────────────────────────────────────────────
-- Must come before: bookings, users (no cascade defined)
DELETE FROM reviews;

-- ── 6. Wallet transactions ──────────────────────────────────
-- CASCADE from wallets, but clearing before wallet reset
DELETE FROM wallet_transactions;

-- ── 7. Payouts ──────────────────────────────────────────────
-- onDelete: SetNull on host_earnings.payout_id — nulls those refs automatically
-- Must come before: bank_accounts
DELETE FROM payouts;

-- ── 8. Host earnings ────────────────────────────────────────
-- Must come before: bookings (booking_id required, no cascade)
-- payout_id is now NULL (set by step 7)
DELETE FROM host_earnings;

-- ── 9. Transactions ─────────────────────────────────────────
-- Must come before: bookings (booking_id required, no cascade)
-- refunds already cleared in step 2
DELETE FROM transactions;

-- ── 10. Booking locks ────────────────────────────────────────
-- References spaces and slots; clearing before parking_spaces
DELETE FROM booking_locks;

-- ── 11. Bookings ─────────────────────────────────────────────
-- All FK children cleared above (transactions, reviews, host_earnings,
-- support_tickets, disputes, booking_locks)
DELETE FROM bookings;

-- ── 12. Notifications ────────────────────────────────────────
-- Must come before: users (no cascade defined)
DELETE FROM notifications;

-- ── 13. Audit logs ───────────────────────────────────────────
-- actor_id is nullable; no cascade — must delete before non-admin users
DELETE FROM audit_logs;

-- ── 14. Reset promo code usage ───────────────────────────────
-- Keep promo codes, just zero the counters
UPDATE promo_codes SET used_count = 0;

-- ── 15. Zero admin wallet balances ───────────────────────────
-- Non-admin wallets are fully deleted in step 24
UPDATE wallets
SET balance = 0.00, reserved_balance = 0.00
WHERE user_id IN (SELECT id FROM users WHERE role = 'admin');

-- ── 16. Saved payment methods ────────────────────────────────
-- CASCADE from users but bookings are now gone
DELETE FROM saved_payment_methods;

-- ── 17. Favorites ────────────────────────────────────────────
-- CASCADE from both users and spaces; clear before both
DELETE FROM favorites;

-- ── 18. Parking spaces ───────────────────────────────────────
-- CASCADE automatically removes:
--   space_photos, space_amenities, space_schedules,
--   space_blackout_dates, space_pricing_rules, parking_slots
-- All FK children (bookings, reviews, booking_locks, favorites)
-- are already cleared above.
DELETE FROM parking_spaces;

-- ── 19. Vehicles (non-admin users only) ──────────────────────
-- bookings already cleared; safe to delete
DELETE FROM vehicles
WHERE user_id IN (SELECT id FROM users WHERE role != 'admin');

-- ── 20. Bank accounts (non-admin users only) ─────────────────
-- payouts already cleared in step 7
DELETE FROM bank_accounts
WHERE host_id IN (SELECT id FROM users WHERE role != 'admin');

-- ── 21. KYC documents (non-admin users only) ─────────────────
DELETE FROM kyc_documents
WHERE user_id IN (SELECT id FROM users WHERE role != 'admin');

-- ── 22. Social auth providers (non-admin users only) ─────────
DELETE FROM social_auth_providers
WHERE user_id IN (SELECT id FROM users WHERE role != 'admin');

-- ── 23. Notification preferences (non-admin users only) ──────
DELETE FROM notification_preferences
WHERE user_id IN (SELECT id FROM users WHERE role != 'admin');

-- ── 24. Sessions — all users ─────────────────────────────────
-- Forces re-login. CASCADE from users anyway, but explicit.
DELETE FROM sessions;

-- ── 25. OTP tokens — all users ───────────────────────────────
-- CASCADE from users anyway, but explicit.
DELETE FROM otp_tokens;

-- ── 26. Wallets — non-admin users ────────────────────────────
-- CASCADE from users; wallet_transactions already cleared in step 6
DELETE FROM wallets
WHERE user_id IN (SELECT id FROM users WHERE role != 'admin');

-- ── 27. Non-admin users ───────────────────────────────────────
-- All FK dependencies cleared above.
-- Admin users (role = 'admin') are NOT touched.
DELETE FROM users WHERE role != 'admin';

COMMIT;
