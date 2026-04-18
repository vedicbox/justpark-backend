import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { ErrorCode } from '../../types';
import { isHost } from '../../middleware/roleGuard';
import { validate } from '../../middleware/validate';
import * as controller from './controller';
import {
  CreateSpaceSchema,
  UpdateSpaceSchema,
  SetScheduleSchema,
  AddBlackoutSchema,
  SetPricingSchema,
  SpaceIdParamSchema,
  PhotoIdParamSchema,
  BlackoutIdParamSchema,
  ListSpacesQuerySchema,
  EarningsBreakdownQuerySchema,
  TaxSummaryQuerySchema,
  PayoutListQuerySchema,
  PayoutRequestSchema,
  AddBankAccountSchema,
  UpdateBankAccountSchema,
  BankAccountIdParamSchema,
  CreateSlotSchema,
  UpdateSlotSchema,
  SlotParamSchema,
} from './validators';
import {
  HostListBookingsQuerySchema,
  BookingIdParamSchema,
  RejectBookingSchema,
  HostCancelBookingSchema,
} from '../bookings/validators';

export const hostRouter = Router();

// Photo upload middleware (memory storage, 5MB, images only)
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Only JPEG, PNG, and WebP images are allowed'));
  },
});

// All host routes require authentication and host (or admin) role
hostRouter.use(authenticate, isHost);

// ─────────────────────────────────────────────
// Space CRUD
// ─────────────────────────────────────────────

/**
 * POST /host/spaces
 * Create a new listing (starts as 'draft').
 * lat/lng required to set PostGIS geography location.
 */
hostRouter.post(
  '/spaces',
  validate(CreateSpaceSchema),
  controller.createSpace
);

/**
 * GET /host/spaces
 * List all spaces owned by this host. Optional ?status filter.
 */
hostRouter.get(
  '/spaces',
  validate(ListSpacesQuerySchema, 'query'),
  controller.listSpaces
);

/**
 * GET /host/spaces/:id
 * Full space details including photos, amenities, schedule, pricing.
 */
hostRouter.get(
  '/spaces/:id',
  validate(SpaceIdParamSchema, 'params'),
  controller.getSpace
);

/**
 * PATCH /host/spaces/:id
 * Update listing fields. Provide lat+lng together to update location.
 * Providing amenities[] replaces the entire amenity list.
 */
hostRouter.patch(
  '/spaces/:id',
  validate(SpaceIdParamSchema, 'params'),
  validate(UpdateSpaceSchema),
  controller.updateSpace
);

/**
 * POST /host/spaces/:id/submit
 * Submit draft for admin review → status: 'pending_review'.
 * Requirements: ≥3 photos, ≥1 pricing rule, location set.
 */
hostRouter.post(
  '/spaces/:id/submit',
  validate(SpaceIdParamSchema, 'params'),
  controller.submitSpace
);

/**
 * POST /host/spaces/:id/pause
 * Pause an active listing. No new bookings will be accepted.
 */
hostRouter.post(
  '/spaces/:id/pause',
  validate(SpaceIdParamSchema, 'params'),
  controller.pauseSpace
);

/**
 * POST /host/spaces/:id/unpause
 * Resume a paused listing → status: 'active'.
 */
hostRouter.post(
  '/spaces/:id/unpause',
  validate(SpaceIdParamSchema, 'params'),
  controller.unpauseSpace
);

/**
 * DELETE /host/spaces/:id
 * Soft-delete listing (status → 'deleted').
 * Blocked if any pending/confirmed/active bookings exist.
 */
hostRouter.delete(
  '/spaces/:id',
  validate(SpaceIdParamSchema, 'params'),
  controller.deleteSpace
);

// ─────────────────────────────────────────────
// Photo management
// ─────────────────────────────────────────────

/**
 * POST /host/spaces/:id/photos
 * Upload a photo (multipart/form-data, field: "photo").
 */
hostRouter.post(
  '/spaces/:id/photos',
  validate(SpaceIdParamSchema, 'params'),
  photoUpload.single('photo'),
  controller.addPhoto
);

/**
 * DELETE /host/spaces/:id/photos/:photoId
 * Remove a photo and delete from S3.
 */
hostRouter.delete(
  '/spaces/:id/photos/:photoId',
  validate(PhotoIdParamSchema, 'params'),
  controller.removePhoto
);

// ─────────────────────────────────────────────
// Schedule management
// ─────────────────────────────────────────────

/**
 * GET /host/spaces/:id/schedule
 */
hostRouter.get(
  '/spaces/:id/schedule',
  validate(SpaceIdParamSchema, 'params'),
  controller.getSchedule
);

/**
 * PUT /host/spaces/:id/schedule
 * Replace entire weekly schedule (1–7 day entries).
 */
hostRouter.put(
  '/spaces/:id/schedule',
  validate(SpaceIdParamSchema, 'params'),
  validate(SetScheduleSchema),
  controller.setSchedule
);

/**
 * GET /host/spaces/:id/blackout
 */
hostRouter.get(
  '/spaces/:id/blackout',
  validate(SpaceIdParamSchema, 'params'),
  controller.getBlackoutDates
);

/**
 * POST /host/spaces/:id/blackout
 */
hostRouter.post(
  '/spaces/:id/blackout',
  validate(SpaceIdParamSchema, 'params'),
  validate(AddBlackoutSchema),
  controller.addBlackout
);

/**
 * DELETE /host/spaces/:id/blackout/:dateId
 */
hostRouter.delete(
  '/spaces/:id/blackout/:dateId',
  validate(BlackoutIdParamSchema, 'params'),
  controller.removeBlackout
);

// ─────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────

/**
 * GET /host/spaces/:id/pricing
 */
hostRouter.get(
  '/spaces/:id/pricing',
  validate(SpaceIdParamSchema, 'params'),
  controller.getPricing
);

/**
 * PUT /host/spaces/:id/pricing
 * Replace all pricing rules. One rule per rate_type.
 */
hostRouter.put(
  '/spaces/:id/pricing',
  validate(SpaceIdParamSchema, 'params'),
  validate(SetPricingSchema),
  controller.setPricing
);

// ─────────────────────────────────────────────
// Host booking management
// ─────────────────────────────────────────────

/**
 * GET /host/bookings
 * List all bookings across the host's spaces.
 * Optional: ?space_id=, ?status=, ?page=, ?limit=
 */
hostRouter.get(
  '/bookings',
  validate(HostListBookingsQuerySchema, 'query'),
  controller.listHostBookings
);

/**
 * GET /host/bookings/:id
 * Full booking detail for a booking on one of the host's spaces.
 */
hostRouter.get(
  '/bookings/:id',
  validate(BookingIdParamSchema, 'params'),
  controller.getHostBooking
);

/**
 * GET /host/bookings/:id/invoice
 * Download a PDF invoice for a completed booking (for hosts).
 */
hostRouter.get(
  '/bookings/:id/invoice',
  validate(BookingIdParamSchema, 'params'),
  controller.downloadBookingInvoice
);

/**
 * PATCH /host/bookings/:id/approve
 * Approve a pending booking (non-instant-book spaces).
 * Creates host earnings record.
 */
hostRouter.patch(
  '/bookings/:id/approve',
  validate(BookingIdParamSchema, 'params'),
  controller.approveBooking
);

/**
 * PATCH /host/bookings/:id/reject
 * Reject a pending booking with a required reason.
 * Full refund is credited to user's wallet.
 */
hostRouter.patch(
  '/bookings/:id/reject',
  validate(BookingIdParamSchema, 'params'),
  validate(RejectBookingSchema),
  controller.rejectBooking
);

/**
 * POST /host/bookings/:id/cancel
 * Cancel a confirmed/active booking with a required reason.
 * Full refund + 5% platform credit to user wallet; host earnings put on hold.
 */
hostRouter.post(
  '/bookings/:id/cancel',
  validate(BookingIdParamSchema, 'params'),
  validate(HostCancelBookingSchema),
  controller.hostCancelBooking
);

// ─────────────────────────────────────────────
// Earnings
// ─────────────────────────────────────────────

/**
 * GET /host/earnings
 * Dashboard summary: totals by status, monthly trends, available-for-payout amount.
 */
hostRouter.get('/earnings', controller.getEarningsDashboard);

/**
 * GET /host/earnings/breakdown
 * Per-booking earnings list. Optional: ?status=, ?from=, ?to=, ?page=, ?limit=
 */
hostRouter.get(
  '/earnings/breakdown',
  validate(EarningsBreakdownQuerySchema, 'query'),
  controller.getEarningsBreakdown
);

/**
 * GET /host/earnings/tax-summary
 * Annual tax summary with month-wise breakdown. Required: ?year=2025
 */
hostRouter.get(
  '/earnings/tax-summary',
  validate(TaxSummaryQuerySchema, 'query'),
  controller.getTaxSummary
);

// ─────────────────────────────────────────────
// Payouts
// ─────────────────────────────────────────────

/**
 * GET /host/payouts
 * Payout history. Optional: ?status=requested|processing|completed|failed
 */
hostRouter.get(
  '/payouts',
  validate(PayoutListQuerySchema, 'query'),
  controller.listPayouts
);

/**
 * POST /host/payouts/request
 * Request a payout of available earnings to a verified bank account.
 * Minimum payout: ₹100. Marks earnings as on_hold pending admin processing.
 */
hostRouter.post(
  '/payouts/request',
  validate(PayoutRequestSchema),
  controller.requestPayout
);

// ─────────────────────────────────────────────
// Bank Accounts
// ─────────────────────────────────────────────

/**
 * GET /host/bank-accounts
 * List all bank accounts. Account number is masked (last 4 digits shown).
 */
hostRouter.get('/bank-accounts', controller.listBankAccounts);

/**
 * POST /host/bank-accounts
 * Add a new bank account. Account number is AES-256-GCM encrypted at rest.
 */
hostRouter.post(
  '/bank-accounts',
  validate(AddBankAccountSchema),
  controller.addBankAccount
);

/**
 * POST /host/bank-accounts/:id/retry
 * Retry Razorpay Verification for a pending/failed bank account.
 */
hostRouter.post(
  '/bank-accounts/:id/retry',
  validate(BankAccountIdParamSchema, 'params'),
  controller.retryBankAccountVerification
);

/**
 * PATCH /host/bank-accounts/:id
 * Update account holder name, bank name, or set as default.
 */
hostRouter.patch(
  '/bank-accounts/:id',
  validate(BankAccountIdParamSchema, 'params'),
  validate(UpdateBankAccountSchema),
  controller.updateBankAccount
);

/**
 * DELETE /host/bank-accounts/:id
 * Remove a bank account. Blocked if pending payouts reference this account.
 */
hostRouter.delete(
  '/bank-accounts/:id',
  validate(BankAccountIdParamSchema, 'params'),
  controller.deleteBankAccount
);

// ─────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────

/**
 * GET /host/analytics
 * Host performance dashboard: occupancy rate, revenue trends,
 * booking count, average rating, top-performing spaces.
 */
hostRouter.get('/analytics', controller.getHostAnalytics);

// ─────────────────────────────────────────────
// Slot management
// ─────────────────────────────────────────────

/**
 * GET /host/spaces/:id/slots
 * List all slots for a space (active and inactive).
 */
hostRouter.get(
  '/spaces/:id/slots',
  validate(SpaceIdParamSchema, 'params'),
  controller.listSlots
);

/**
 * POST /host/spaces/:id/slots
 * Create a new parking slot. Enforces total_capacity limit.
 */
hostRouter.post(
  '/spaces/:id/slots',
  validate(SpaceIdParamSchema, 'params'),
  validate(CreateSlotSchema),
  controller.createSlot
);

/**
 * PATCH /host/spaces/:id/slots/:slotId
 * Update slot_number, is_active, or notes.
 */
hostRouter.patch(
  '/spaces/:id/slots/:slotId',
  validate(SlotParamSchema, 'params'),
  validate(UpdateSlotSchema),
  controller.updateSlot
);

/**
 * DELETE /host/spaces/:id/slots/:slotId
 * Delete a slot. Blocked if the slot has upcoming or active bookings.
 */
hostRouter.delete(
  '/spaces/:id/slots/:slotId',
  validate(SlotParamSchema, 'params'),
  controller.deleteSlot
);
