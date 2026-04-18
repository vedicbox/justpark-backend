import express, { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { isUser } from '../../middleware/roleGuard';
import { validate } from '../../middleware/validate';
import { idempotency } from '../../middleware/idempotency';
import * as controller from './controller';
import {
  CheckAvailabilitySchema,
  LockSlotSchema,
  CreateBookingSchema,
  ListBookingsQuerySchema,
  BookingIdParamSchema,
  ModifyBookingSchema,
  ExtendBookingSchema,
  VerifyExtensionPaymentSchema,
  CancelBookingSchema,
  RebookSchema,
} from './validators';

export const bookingsRouter = Router();

// Tighter body-size limit for data-only routes (all booking payloads are small JSON
// objects — no files). Acts as a defence-in-depth backstop: effective immediately if
// the global 5 MB parser in app.ts is ever removed or re-scoped to upload routes only.
bookingsRouter.use(express.json({ limit: '10kb' }));

// ─────────────────────────────────────────────
// Public (with auth) — availability check
// ─────────────────────────────────────────────

/**
 * POST /bookings/check-availability
 * Check if a space is available for the given window and get a price estimate.
 * Auth required to prevent abuse.
 */
bookingsRouter.post(
  '/check-availability',
  authenticate,
  validate(CheckAvailabilitySchema),
  controller.checkAvailability
);

// All remaining routes require authenticated user
bookingsRouter.use(authenticate, isUser);

// ─────────────────────────────────────────────
// Slot locking
// ─────────────────────────────────────────────

/**
 * POST /bookings/lock
 * Acquire a 10-minute Redis slot lock before checkout.
 * Re-calling with same user refreshes the TTL.
 */
bookingsRouter.post(
  '/lock',
  validate(LockSlotSchema),
  controller.lockSlot
);

/**
 * DELETE /bookings/lock
 * Release a slot lock (optional cleanup — locks auto-expire).
 */
bookingsRouter.delete(
  '/lock',
  validate(LockSlotSchema),
  controller.releaseLock
);

// ─────────────────────────────────────────────
// Booking CRUD
// ─────────────────────────────────────────────

/**
 * POST /bookings
 * Create a booking. Requires an active slot lock.
 * Price is calculated server-side; promo_code is optional.
 * Idempotency key required — duplicate submissions within 1 hour return the
 * cached response without creating a second booking.
 */
bookingsRouter.post(
  '/',
  idempotency(),
  validate(CreateBookingSchema),
  controller.createBooking
);

/**
 * GET /bookings
 * List the authenticated user's bookings.
 * Optional: ?status=, ?filter=upcoming|past|active, ?page=, ?limit=
 */
bookingsRouter.get(
  '/',
  validate(ListBookingsQuerySchema, 'query'),
  controller.listBookings
);

/**
 * GET /bookings/:id
 * Full booking detail including space, vehicle, and transactions.
 */
bookingsRouter.get(
  '/:id',
  validate(BookingIdParamSchema, 'params'),
  controller.getBooking
);

/**
 * GET /bookings/:id/receipt
 * Download a PDF receipt for a confirmed/active/completed booking.
 */
bookingsRouter.get(
  '/:id/receipt',
  validate(BookingIdParamSchema, 'params'),
  controller.downloadReceipt
);

/**
 * PATCH /bookings/:id
 * Modify end_time of a pending/confirmed booking.
 * Price is recalculated for the new duration.
 */
bookingsRouter.patch(
  '/:id',
  validate(BookingIdParamSchema, 'params'),
  validate(ModifyBookingSchema),
  controller.modifyBooking
);

/**
 * POST /bookings/:id/extend
 * Extend an active booking's end time.
 * Additional price is calculated for the extension window only.
 */
bookingsRouter.post(
  '/:id/extend',
  validate(BookingIdParamSchema, 'params'),
  validate(ExtendBookingSchema),
  controller.extendBooking
);

/**
 * POST /bookings/:id/extend/verify
 * Verify Razorpay payment for a booking extension and update end_time.
 */
bookingsRouter.post(
  '/:id/extend/verify',
  validate(BookingIdParamSchema, 'params'),
  validate(VerifyExtensionPaymentSchema),
  controller.verifyExtensionPayment
);

/**
 * POST /bookings/:id/cancel
 * Cancel a pending/confirmed/active booking.
 * Refund calculated per cancellation policy and credited to wallet.
 */
bookingsRouter.post(
  '/:id/cancel',
  validate(BookingIdParamSchema, 'params'),
  validate(CancelBookingSchema),
  controller.cancelBooking
);

/**
 * POST /bookings/:id/rebook
 * Create a new booking for the same space+vehicle at a different time.
 * Requires a slot lock for the new time window.
 */
bookingsRouter.post(
  '/:id/rebook',
  validate(BookingIdParamSchema, 'params'),
  validate(RebookSchema),
  controller.rebookBooking
);
