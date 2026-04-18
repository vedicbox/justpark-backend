-- Add cancelled_at timestamp to Booking table.
-- Records the exact moment a booking was cancelled, independent of updated_at
-- (which can be touched by other updates such as refund_amount writes).
ALTER TABLE "bookings" ADD COLUMN "cancelled_at" TIMESTAMPTZ;
