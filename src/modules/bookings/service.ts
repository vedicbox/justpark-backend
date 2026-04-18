import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { redis, RedisKeys } from '../../config/redis';
import { AppError } from '../../middleware/errorHandler';
import { env } from '../../config/env';
import { requireRazorpay } from '../../config/payments';
import {
  checkAvailability,
  checkSlotAvailability,
  acquireSlotLock,
} from '../../services/availabilityEngine';
import { calculateBookingPrice, incrementPromoUsage } from '../../services/pricingEngine';
import { buildPaginationMeta } from '../../utils/pagination';
import { ErrorCode } from '../../types';
import {
  notifyBookingConfirmed,
  notifyBookingCancelled,
  notifyHostNewBooking,
  notifyBookingExtended,
} from '../../services/notification';
import { initiateRefund } from '../../services/refund';
import { sendEmail, userCancellationTemplate, hostCancellationTemplate } from '../../services/emailService';
import { logger } from '../../utils/logger';
import {
  emitBookingStatusChange,
  emitSpaceAvailabilityUpdate,
} from '../../socket/handlers';
import type {
  CheckAvailabilityDto,
  LockSlotDto,
  CreateBookingDto,
  ListBookingsQuery,
  ModifyBookingDto,
  ExtendBookingDto,
  VerifyExtensionPaymentDto,
  CancelBookingDto,
  RebookDto,
  RejectBookingDto,
  HostCancelBookingDto,
  HostListBookingsQuery,
} from './validators';

// ─────────────────────────────────────────────
// Reusable booking select (no sensitive fields)
// ─────────────────────────────────────────────
const BOOKING_SELECT = {
  id: true,
  user_id: true,
  space_id: true,
  slot_id: true,
  vehicle_id: true,
  start_time: true,
  end_time: true,
  status: true,
  base_price: true,
  platform_fee: true,
  tax_amount: true,
  discount_amount: true,
  total_price: true,
  cancellation_reason: true,
  cancelled_by: true,
  cancelled_at: true,
  refund_amount: true,
  host_note: true,
  created_at: true,
  updated_at: true,
} as const;

const BOOKING_DETAIL_SELECT = {
  ...BOOKING_SELECT,
  space: {
    select: {
      id: true,
      name: true,
      address_line1: true,
      city: true,
      state: true,
      country: true,
      cancellation_policy: true,
      instant_book: true,
      host_id: true,
    },
  },
  slot: {
    select: { id: true, slot_number: true },
  },
  vehicle: {
    select: { id: true, plate_number: true, type: true, make: true, model: true, color: true },
  },
  transactions: {
    select: { id: true, amount: true, status: true, payment_method: true, gateway: true, created_at: true },
    orderBy: { created_at: 'desc' as const },
    take: 5,
  },
} as const;

// ─────────────────────────────────────────────
// ISO key (second precision, no millis) for Redis lock keys
// ─────────────────────────────────────────────
function isoKey(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ─────────────────────────────────────────────
// Refund calculation (inline — no gateway calls yet)
// Returns the refund amount and credits it to the user's wallet.
// ─────────────────────────────────────────────
interface RefundResult {
  refundAmount: number;
  policy: string;
  reason: string;
}

function calculateRefundAmount(
  totalPrice: number,
  startTime: Date,
  cancellationPolicy: string,
  cancelledBy: 'user' | 'host' | 'admin'
): RefundResult {
  if (cancelledBy === 'admin') {
    return { refundAmount: totalPrice, policy: 'admin_override', reason: 'Full refund by admin' };
  }
  if (cancelledBy === 'host') {
    return { refundAmount: totalPrice, policy: 'host_cancel', reason: 'Full refund — host cancelled' };
  }

  const hoursUntilStart = (startTime.getTime() - Date.now()) / 3_600_000;

  switch (cancellationPolicy) {
    case 'flexible':
      if (hoursUntilStart > 1) {
        return { refundAmount: totalPrice, policy: 'flexible', reason: '100% refund (>1hr before start)' };
      }
      return { refundAmount: 0, policy: 'flexible', reason: 'No refund (<1hr before start)' };

    case 'moderate':
      if (hoursUntilStart > 24) {
        return {
          refundAmount: Math.round(totalPrice * 0.5 * 100) / 100,
          policy: 'moderate',
          reason: '50% refund (>24hr before start)',
        };
      }
      return { refundAmount: 0, policy: 'moderate', reason: 'No refund (<24hr before start)' };

    case 'strict':
    default:
      return { refundAmount: 0, policy: 'strict', reason: 'No refund (strict policy)' };
  }
}


// Create host earnings record after booking confirmation
async function createHostEarning(
  hostId: string,
  bookingId: string,
  basePrice: number
): Promise<void> {
  const grossAmount     = Math.round(basePrice * 100) / 100;
  const commissionAmount = 0; // Platform fee already collected from user
  const netAmount       = grossAmount;
  const availableAt     = new Date(Date.now() + env.DISPUTE_WINDOW_HOURS * 3_600_000);

  // Upsert instead of create: if confirmBookingAfterPayment() already created
  // an earnings record (instant_book or payment-first flows), this silently
  // skips the duplicate instead of throwing a unique-constraint violation.
  await prisma.hostEarning.upsert({
    where:  { booking_id: bookingId },
    create: {
      host_id:           hostId,
      booking_id:        bookingId,
      gross_amount:      grossAmount,
      commission_amount: commissionAmount,
      net_amount:        netAmount,
      status:            'pending',
      available_at:      availableAt,
    },
    update: {}, // already exists — don't overwrite figures set by the payment path
  });
}

async function findLatestNonFailedTransaction(bookingId: string) {
  return prisma.transaction.findFirst({
    where: {
      booking_id: bookingId,
      status:     { in: ['pending', 'processing', 'completed', 'partially_refunded', 'refunded'] },
    },
    orderBy: { created_at: 'desc' },
    select:  { id: true, status: true },
  });
}

async function hasCompletedPaymentTransaction(bookingId: string): Promise<boolean> {
  const transaction = await prisma.transaction.findFirst({
    where:   { booking_id: bookingId, status: 'completed' },
    select:  { id: true },
    orderBy: { created_at: 'desc' },
  });
  return Boolean(transaction);
}

// ─────────────────────────────────────────────
// POST /bookings/check-availability
// ─────────────────────────────────────────────
export async function checkAvailabilityWithPricing(dto: CheckAvailabilityDto) {
  const start = new Date(dto.start_time);
  const end   = new Date(dto.end_time);

  const availability = await checkAvailability(dto.space_id, start, end);

  // Only calculate price when available (avoid unnecessary DB calls)
  if (!availability.available) {
    return { availability, pricing: null };
  }

  let pricing: any = null;
  try {
    pricing = await calculateBookingPrice(dto.space_id, start, end);
  } catch {
    // Pricing might fail if no rules configured — not a hard error here
  }

  return { availability, pricing };
}

// ─────────────────────────────────────────────
// POST /bookings/lock
// Acquires a Redis NX lock on a specific parking slot.
// If dto.slot_id is provided, that slot is locked (or TTL refreshed if same user).
// If omitted, the first available slot is auto-selected.
// Returns the locked slot_id — client must pass it to POST /bookings.
// ─────────────────────────────────────────────
export async function lockSlot(dto: LockSlotDto, userId: string) {
  const start = new Date(dto.start_time);
  const end   = new Date(dto.end_time);

  // ── Case 1: User wants to refresh an existing lock on a specific slot ───
  if (dto.slot_id) {
    const key      = RedisKeys.slotLockById(dto.slot_id, isoKey(start), isoKey(end));
    const existing = await redis.get(key);

    if (existing) {
      if (existing === userId) {
        await redis.expire(key, env.SLOT_LOCK_TTL_SECONDS);
        return {
          locked: true,
          extended: true,
          slot_id: dto.slot_id,
          expires_in_seconds: env.SLOT_LOCK_TTL_SECONDS,
          message: 'Slot lock refreshed',
        };
      }
      throw AppError.conflict(
        ErrorCode.SLOT_LOCKED,
        'This slot is currently held by another user. Please try a different slot or time.'
      );
    }
  }

  // ── Check space-level availability (schedule, blackout, duration, slots) ─
  const avail = await checkAvailability(dto.space_id, start, end);
  if (!avail.available) {
    throw AppError.conflict(ErrorCode.SLOT_UNAVAILABLE, avail.reason ?? 'Slot is not available');
  }

  // ── Determine slot to lock ───────────────────────────────────────────────
  let targetSlotId: string;
  if (dto.slot_id) {
    const found = avail.availableSlots.find((s) => s.id === dto.slot_id);
    if (!found) {
      throw AppError.conflict(ErrorCode.SLOT_UNAVAILABLE, 'The requested slot is not available for this time window');
    }
    targetSlotId = dto.slot_id;
  } else {
    // Auto-select: try each available slot in order until one is successfully locked (NX)
    let lockedId: string | null = null;
    for (const slot of avail.availableSlots) {
      const acquired = await acquireSlotLock(slot.id, start, end, userId, env.SLOT_LOCK_TTL_SECONDS);
      if (acquired) {
        lockedId = slot.id;
        break;
      }
      // Another request raced us to this slot — try next
    }
    if (!lockedId) {
      throw AppError.conflict(
        ErrorCode.SLOT_LOCKED,
        'All available slots were just reserved by other users. Please try again.'
      );
    }
    return {
      locked: true,
      extended: false,
      slot_id: lockedId,
      expires_in_seconds: env.SLOT_LOCK_TTL_SECONDS,
      message: 'Slot locked for checkout',
    };
  }

  const acquired = await acquireSlotLock(targetSlotId, start, end, userId, env.SLOT_LOCK_TTL_SECONDS);
  if (!acquired) {
    throw AppError.conflict(ErrorCode.SLOT_LOCKED, 'This slot was just reserved by another user.');
  }

  return {
    locked: true,
    extended: false,
    slot_id: targetSlotId,
    expires_in_seconds: env.SLOT_LOCK_TTL_SECONDS,
    message: 'Slot locked for checkout',
  };
}

// ─────────────────────────────────────────────
// DELETE /bookings/lock
// Releases a Redis slot lock (optional — locks auto-expire).
// ─────────────────────────────────────────────
export async function releaseLock(dto: LockSlotDto, userId: string) {
  const start = new Date(dto.start_time);
  const end   = new Date(dto.end_time);

  if (!dto.slot_id) {
    throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'slot_id is required to release a lock');
  }

  const key = RedisKeys.slotLockById(dto.slot_id, isoKey(start), isoKey(end));
  const existing = await redis.get(key);

  if (!existing) {
    return {
      released: false,
      message: 'Lock not found or already expired',
    };
  }

  if (existing !== userId) {
    throw AppError.forbidden('You do not own this lock');
  }

  await redis.del(key);

  return {
    released: true,
    message: 'Lock released successfully',
  };
}

// ─────────────────────────────────────────────
// POST /bookings
// ─────────────────────────────────────────────
export async function createBooking(dto: CreateBookingDto, userId: string) {
  const start = new Date(dto.start_time);
  const end   = new Date(dto.end_time);

  // 1. Verify user holds the Redis slot lock (written by POST /bookings/lock)
  const lockKey   = RedisKeys.slotLockById(dto.slot_id, isoKey(start), isoKey(end));
  const lockOwner = await redis.get(lockKey);
  if (!lockOwner || lockOwner !== userId) {
    throw AppError.conflict(
      ErrorCode.LOCK_NOT_FOUND,
      'No active slot lock found. Please call POST /bookings/lock first and use the returned slot_id.'
    );
  }

  // Atomic transaction: Create booking (DB EXCLUDE constraint is the final race-condition guard)
  const result = await prisma.$transaction(async (tx) => {
    // 2. Re-check slot availability within transaction (additional safety).
    // skipLockScan = true: lock ownership was already verified above (lockOwner === userId).
    // The user's own lock must not be treated as a blocking conflict here.
    const avail = await checkSlotAvailability(dto.slot_id, dto.space_id, start, end, undefined, true);
    if (!avail.available) {
      throw AppError.conflict(
        ErrorCode.SLOT_UNAVAILABLE,
        avail.reason ?? 'Slot is no longer available'
      );
    }

    // 3. Fetch space + validate vehicle within transaction
    const space = await tx.parkingSpace.findUnique({
      where: { id: dto.space_id },
      select: {
        id: true,
        host_id: true,
        instant_book: true,
        allowed_vehicles: true,
        cancellation_policy: true,
      },
    });
    if (!space) throw AppError.notFound('Space');

    const vehicle = await tx.vehicle.findFirst({
      where: { id: dto.vehicle_id, user_id: userId },
      select: { id: true, type: true },
    });
    if (!vehicle) throw AppError.notFound('Vehicle');

    if (space.allowed_vehicles.length > 0 && !space.allowed_vehicles.includes(vehicle.type)) {
      throw AppError.badRequest(
        ErrorCode.VALIDATION_ERROR,
        `Your vehicle type '${vehicle.type}' is not allowed at this space. Allowed: ${space.allowed_vehicles.join(', ')}`
      );
    }

    // 4. Calculate price server-side
    const pricing = await calculateBookingPrice(dto.space_id, start, end, dto.promo_code);

    // 5. Create booking within transaction — DB exclusion constraint is final safety net.
    // Always start as 'pending' — payment is required before any booking is confirmed.
    // instant_book = true means no host-approval step is needed, but payment is still
    // required. confirmBookingAfterPayment() transitions pending → confirmed once the
    // gateway reports a successful charge.
    const booking = await tx.booking.create({
      data: {
        user_id:         userId,
        space_id:        dto.space_id,
        slot_id:         dto.slot_id,
        vehicle_id:      dto.vehicle_id,
        start_time:      start,
        end_time:        end,
        status:          'pending',
        base_price:      pricing.base_price,
        platform_fee:    pricing.platform_fee,
        tax_amount:      pricing.tax_amount,
        discount_amount: pricing.discount_amount,
        total_price:     pricing.total_price,
        host_note:       dto.host_note,
      },
      select: BOOKING_DETAIL_SELECT,
    });

    return { booking, space, pricing };
  });

  const { booking, space, pricing } = result;

  // 6. Post-creation side effects (outside transaction for performance)
  // Lock is intentionally NOT released here to prevent overbooking during checkout

  if (dto.promo_code) {
    await incrementPromoUsage(dto.promo_code).catch(() => {/* non-critical */});
  }

  // Host earnings are created in confirmBookingAfterPayment() — only after the gateway
  // confirms a successful charge. No earnings are created here because the booking has
  // not been paid yet (status is always 'pending' at creation time).

  // Notify host of a new pending booking awaiting payment + approval.
  // Do NOT call notifyBookingConfirmed here — the booking is not confirmed until payment
  // succeeds (handled by confirmBookingAfterPayment → emitBookingStatusChange).
  const spaceName = booking.space?.name ?? 'your booked space';
  notifyHostNewBooking(space.host_id, booking.id, spaceName).catch(() => {});

  // Real-time events (fire-and-forget)
  emitBookingStatusChange(userId, space.host_id, booking.id, booking.status, { space_id: dto.space_id });
  emitSpaceAvailabilityUpdate(dto.space_id).catch(() => {});

  return { booking, pricing };
}

// ─────────────────────────────────────────────
// GET /bookings
// ─────────────────────────────────────────────
export async function listBookings(userId: string, query: ListBookingsQuery) {
  const { status, filter, page, limit } = query;
  const skip = (page - 1) * limit;
  const now  = new Date();

  const where: Prisma.BookingWhereInput = { user_id: userId };

  if (status) {
    where.status = status;
  } else if (filter === 'upcoming') {
    where.start_time = { gt: now };
    where.status = { in: ['pending', 'confirmed'] };
  } else if (filter === 'past') {
    where.end_time = { lt: now };
    where.status   = { in: ['completed', 'cancelled', 'no_show', 'disputed'] };
  } else if (filter === 'active') {
    where.status = 'active';
  }

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      select: {
        ...BOOKING_SELECT,
        space: {
          select: {
            id: true,
            name: true,
            address_line1: true,
            city: true,
            photos: { select: { url: true }, orderBy: { display_order: 'asc' }, take: 1 },
          },
        },
        vehicle: { select: { id: true, plate_number: true, type: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.booking.count({ where }),
  ]);

  return { bookings, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// GET /bookings/:id
// ─────────────────────────────────────────────
export async function getBooking(userId: string, bookingId: string) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, user_id: userId },
    select: BOOKING_DETAIL_SELECT,
  });
  if (!booking) throw AppError.notFound('Booking');
  return booking;
}

// ─────────────────────────────────────────────
// PATCH /bookings/:id — modify end_time
// Safe only before any payment has been initiated
// ─────────────────────────────────────────────
export async function modifyBooking(userId: string, bookingId: string, dto: ModifyBookingDto) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, user_id: userId },
    select: { ...BOOKING_SELECT, space: { select: { cancellation_policy: true, host_id: true, instant_book: true } } },
  });
  if (!booking) throw AppError.notFound('Booking');

  if (!['pending', 'confirmed'].includes(booking.status)) {
    throw AppError.conflict(
      ErrorCode.BOOKING_NOT_MODIFIABLE,
      `Booking cannot be modified in status '${booking.status}'`
    );
  }

  if (booking.status === 'confirmed') {
    throw AppError.conflict(
      ErrorCode.BOOKING_NOT_MODIFIABLE,
      'Confirmed bookings cannot be modified because payment adjustment is not supported. Cancel and rebook instead.'
    );
  }

  const blockingTransaction = await findLatestNonFailedTransaction(bookingId);
  if (blockingTransaction) {
    throw AppError.conflict(
      ErrorCode.BOOKING_NOT_MODIFIABLE,
      'Booking cannot be modified after payment has been initiated. Cancel and create a new booking instead.'
    );
  }

  const newEnd = new Date(dto.end_time);
  if (newEnd <= booking.start_time) {
    throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'New end_time must be after start_time');
  }

  // Check availability for the modified window — use slot-level check if slot is assigned
  const avail = booking.slot_id
    ? await checkSlotAvailability(booking.slot_id, booking.space_id, booking.start_time, newEnd, bookingId)
    : await checkAvailability(booking.space_id, booking.start_time, newEnd);
  if (!avail.available) {
    throw AppError.conflict(ErrorCode.SLOT_UNAVAILABLE, avail.reason ?? 'New time slot is not available');
  }

  // Recalculate price
  const pricing = await calculateBookingPrice(booking.space_id, booking.start_time, newEnd);

  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      end_time:        newEnd,
      base_price:      pricing.base_price,
      platform_fee:    pricing.platform_fee,
      tax_amount:      pricing.tax_amount,
      discount_amount: pricing.discount_amount,
      total_price:     pricing.total_price,
    },
    select: BOOKING_DETAIL_SELECT,
  });

  return { booking: updated, pricing };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toPaise(amount: number): number {
  return Math.round(amount * 100);
}

function generateExtensionIdempotencyKey(userId: string, bookingId: string, extensionHours: number): string {
  const data = `extend:${userId}:${bookingId}:${extensionHours}:${Math.floor(Date.now() / 1000)}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ─────────────────────────────────────────────
// POST /bookings/:id/extend
// Creates a Razorpay order for additional hours.
// ─────────────────────────────────────────────
export async function extendBooking(userId: string, bookingId: string, dto: ExtendBookingDto) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, user_id: userId },
    select: {
      ...BOOKING_SELECT,
      space: {
        select: {
          id: true,
          name: true,
          host_id: true,
          cancellation_policy: true,
          instant_book: true,
        },
      },
      slot: { select: { id: true, slot_number: true } },
    },
  });
  if (!booking) throw AppError.notFound('Booking');

  if (booking.status !== 'active') {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      'Only active bookings can be extended'
    );
  }

  const extensionHours = dto.extension_hours;
  const currentEnd = new Date(booking.end_time);
  const newEnd = new Date(currentEnd.getTime() + extensionHours * 3_600_000);

  // Check availability for the extension window (current end → new end)
  const slotId = booking.slot?.id ?? booking.slot_id;
  const avail = slotId
    ? await checkSlotAvailability(slotId, booking.space_id, currentEnd, newEnd, bookingId)
    : await checkAvailability(booking.space_id, currentEnd, newEnd);

  if (!avail.available) {
    throw AppError.conflict(
      ErrorCode.SLOT_UNAVAILABLE,
      avail.reason ?? 'Spot is not available for the requested extension period. Another booking exists for that time.'
    );
  }

  // Calculate price for extension period only
  const extensionPricing = await calculateBookingPrice(booking.space_id, currentEnd, newEnd);
  const extensionAmount = round2(extensionPricing.total_price);

  if (extensionAmount <= 0) {
    throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Extension price calculation failed');
  }

  // Create Razorpay order for the extension amount
  const rzp = requireRazorpay();
  const idemKey = generateExtensionIdempotencyKey(userId, bookingId, extensionHours);

  const order = await rzp.orders.create({
    amount:   toPaise(extensionAmount),
    currency: 'INR',
    receipt:  `ext-${bookingId}`,
    notes:    { booking_id: bookingId, user_id: userId, type: 'extension', extension_hours: String(extensionHours) },
  });

  // Create a transaction for the extension payment
  const transaction = await prisma.transaction.create({
    data: {
      booking_id:      bookingId,
      user_id:         userId,
      amount:          extensionAmount,
      currency:        'INR',
      payment_method:  'card',
      status:          'pending',
      gateway:         'razorpay',
      gateway_ref:     order.id,
      idempotency_key: idemKey,
      metadata: {
        razorpay_order_id: order.id,
        type:              'extension',
        extension_hours:   extensionHours,
        current_end_time:  currentEnd.toISOString(),
        new_end_time:      newEnd.toISOString(),
      },
    },
  });

  return {
    transaction_id:    transaction.id,
    razorpay_order_id: order.id,
    amount:            extensionAmount,
    currency:          'INR',
    key_id:            env.RAZORPAY_KEY_ID,
    extension_hours:   extensionHours,
    new_end_time:      newEnd.toISOString(),
    pricing:           extensionPricing,
  };
}

// ─────────────────────────────────────────────
// POST /bookings/:id/extend/verify
// Verifies Razorpay payment and updates end_time.
// ─────────────────────────────────────────────
export async function verifyExtensionPayment(
  userId: string,
  bookingId: string,
  dto: VerifyExtensionPaymentDto
) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = dto;

  // 1. Verify Razorpay signature
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    throw AppError.badRequest(ErrorCode.SERVICE_UNAVAILABLE, 'Razorpay is not configured');
  }

  const expectedSig = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const isValid = crypto.timingSafeEqual(
    Buffer.from(expectedSig, 'hex'),
    Buffer.from(razorpay_signature, 'hex')
  );

  if (!isValid) {
    throw AppError.badRequest(ErrorCode.PAYMENT_FAILED, 'Invalid Razorpay payment signature');
  }

  // 2. Find the extension transaction
  const transaction = await prisma.transaction.findFirst({
    where: { gateway_ref: razorpay_order_id, user_id: userId, booking_id: bookingId },
    select: { id: true, booking_id: true, status: true, amount: true, metadata: true },
  });
  if (!transaction) throw AppError.notFound('Extension transaction');

  if (transaction.status === 'completed') {
    // Already processed — return idempotent response
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, user_id: userId },
      select: BOOKING_DETAIL_SELECT,
    });
    return { booking, already_confirmed: true };
  }

  const meta = transaction.metadata as Record<string, any> | null;
  if (!meta || meta.type !== 'extension') {
    throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Transaction is not an extension payment');
  }

  const extensionHours = Number(meta.extension_hours);
  const newEndTime = new Date(meta.new_end_time as string);
  const extensionAmount = round2(Number(transaction.amount));

  // 3. Atomic update: transaction + booking
  const updatedBooking = await prisma.$transaction(async (tx) => {
    // Mark transaction as completed
    await tx.transaction.update({
      where: { id: transaction.id },
      data:  { status: 'completed', gateway_ref: razorpay_payment_id },
    });

    // Fetch current booking to update prices
    const current = await tx.booking.findUnique({
      where:  { id: bookingId },
      select: {
        base_price: true,
        platform_fee: true,
        tax_amount: true,
        discount_amount: true,
        total_price: true,
        space: { select: { host_id: true, name: true } },
      },
    });
    if (!current) throw AppError.notFound('Booking');

    // Re-calculate extension pricing for accurate breakdown
    const currentEnd = new Date(meta.current_end_time as string);
    const extPricing = await calculateBookingPrice(current.space!.name ? bookingId : bookingId, currentEnd, newEndTime).catch(() => null);
    // Fallback: use the transaction amount as total extension cost
    const extBase     = extPricing ? round2(extPricing.base_price) : extensionAmount;
    const extFee      = extPricing ? round2(extPricing.platform_fee) : 0;
    const extTax      = extPricing ? round2(extPricing.tax_amount) : 0;

    // Update booking end_time and accumulate price
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: {
        end_time:     newEndTime,
        base_price:   round2(Number(current.base_price) + extBase),
        platform_fee: round2(Number(current.platform_fee) + extFee),
        tax_amount:   round2(Number(current.tax_amount) + extTax),
        total_price:  round2(Number(current.total_price) + extensionAmount),
      },
      select: BOOKING_DETAIL_SELECT,
    });

    // Update host earnings
    const existingEarning = await tx.hostEarning.findUnique({ where: { booking_id: bookingId } });
    if (existingEarning) {
      await tx.hostEarning.update({
        where: { booking_id: bookingId },
        data: {
          gross_amount:      round2(Number(existingEarning.gross_amount) + extBase),
          net_amount:        round2(Number(existingEarning.net_amount) + extBase),
        },
      });
    }

    return { updated, hostId: current.space!.host_id, spaceName: current.space!.name };
  });

  // 4. Notifications (fire-and-forget)
  notifyBookingExtended(
    userId,
    updatedBooking.hostId,
    bookingId,
    updatedBooking.spaceName ?? 'your parking space',
    extensionHours
  ).catch(() => {});

  // 5. Real-time events
  emitBookingStatusChange(userId, updatedBooking.hostId, bookingId, 'active', {
    extended: true,
    extension_hours: extensionHours,
    new_end_time: newEndTime.toISOString(),
  });
  emitSpaceAvailabilityUpdate(updatedBooking.updated.space_id).catch(() => {});

  return { booking: updatedBooking.updated, already_confirmed: false };
}

// ─────────────────────────────────────────────
// POST /bookings/:id/cancel
// ─────────────────────────────────────────────
export async function cancelBooking(userId: string, bookingId: string, dto: CancelBookingDto) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, user_id: userId },
    select: {
      ...BOOKING_SELECT,
      space: { select: { cancellation_policy: true, host_id: true } },
    },
  });
  if (!booking) throw AppError.notFound('Booking');

  if (!['pending', 'confirmed', 'active'].includes(booking.status)) {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      `Booking cannot be cancelled from status '${booking.status}'`
    );
  }

  const { refundAmount, reason: refundReason } = calculateRefundAmount(
    Number(booking.total_price),
    booking.start_time,
    booking.space!.cancellation_policy,
    'user'
  );

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    // Atomic guard: only cancel if still in a cancellable status.
    // Prevents a double-cancel race where two concurrent requests both pass
    // the status check above and then both proceed to credit the wallet.
    const updated = await tx.booking.updateMany({
      where: {
        id:      bookingId,
        user_id: userId,
        status:  { in: ['pending', 'confirmed', 'active'] },
      },
      data: {
        status:              'cancelled',
        cancelled_by:        'user',
        cancellation_reason: dto.reason ?? refundReason,
        refund_amount:       refundAmount,
        cancelled_at:        now,
      },
    });

    if (updated.count === 0) {
      throw AppError.conflict(
        ErrorCode.INVALID_BOOKING_STATE,
        'Booking is no longer cancellable (already cancelled or status changed)'
      );
    }

    // Void pending host earnings
    await tx.hostEarning.updateMany({
      where: { booking_id: bookingId, status: { in: ['pending', 'available'] } },
      data:  { status: 'on_hold' },
    });
  });

  // Issue refund via the proper refund service: creates a Refund record,
  // updates Transaction.status → 'refunded', and credits the wallet atomically.
  // Only applicable for paid bookings (confirmed/active had a completed transaction).
  if (refundAmount > 0) {
    const paidTx = await prisma.transaction.findFirst({
      where:   { booking_id: bookingId, status: 'completed' },
      select:  { id: true },
      orderBy: { created_at: 'desc' },
    });
    if (paidTx) {
      await initiateRefund({
        transactionId:  paidTx.id,
        reason:         refundReason,
        initiatedBy:    userId,
        amountOverride: refundAmount,
        refundTo:       'wallet',
      });
    }
  }

  notifyBookingCancelled(userId, bookingId, refundReason).catch(() => {});

  // Real-time events (fire-and-forget)
  emitBookingStatusChange(userId, booking.space!.host_id, bookingId, 'cancelled', { refund_amount: refundAmount });
  emitSpaceAvailabilityUpdate(booking.space_id).catch(() => {});

  // Load full booking context for email notifications
  try {
    const emailBooking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        user: true,
        space: { include: { host: true } }
      }
    });

    if (emailBooking) {
      const { user, space } = emailBooking;
      const host = space.host;

      try {
        const userTemplate = userCancellationTemplate({ user, booking: emailBooking, space, refund_amount: refundAmount });
        await sendEmail({
          to: user.email,
          ...userTemplate
        });
      } catch (err) {
        logger.error({ msg: 'Failed to send user cancellation email', err, bookingId });
      }

      try {
        const hostTemplate = hostCancellationTemplate({ host, booking: emailBooking, space, user });
        await sendEmail({
          to: host.email,
          ...hostTemplate
        });
      } catch (err) {
        logger.error({ msg: 'Failed to send host cancellation email', err, bookingId });
      }
    }
  } catch (err) {
    logger.error({ msg: 'Failed to fetch booking for cancellation emails', err });
  }

  return {
    cancelled: true,
    refund_amount: refundAmount,
    refund_reason: refundReason,
    refunded_to:   refundAmount > 0 ? 'wallet' : null,
  };
}

// ─────────────────────────────────────────────
// POST /bookings/:id/rebook
// Create a new booking with the same space and vehicle
// ─────────────────────────────────────────────
export async function rebookBooking(userId: string, bookingId: string, dto: RebookDto) {
  const original = await prisma.booking.findFirst({
    where: { id: bookingId, user_id: userId },
    select: { space_id: true, vehicle_id: true, host_note: true },
  });
  if (!original) throw AppError.notFound('Booking');

  const createDto: CreateBookingDto = {
    space_id:   original.space_id,
    slot_id:    dto.slot_id,
    vehicle_id: original.vehicle_id,
    start_time: dto.start_time,
    end_time:   dto.end_time,
    host_note:  original.host_note ?? undefined,
  };

  // Delegate to createBooking — requires user to have acquired a lock first
  return createBooking(createDto, userId);
}

// ═════════════════════════════════════════════
// HOST BOOKING MANAGEMENT
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /host/bookings
// ─────────────────────────────────────────────
export async function listHostBookings(hostId: string, query: HostListBookingsQuery) {
  const { space_id, status, page, limit } = query;
  const skip = (page - 1) * limit;

  // Verify space belongs to this host (if space_id filter provided)
  const where: Prisma.BookingWhereInput = {
    space: { host_id: hostId },
    ...(space_id ? { space_id } : {}),
    ...(status   ? { status }   : {}),
  };

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      select: {
        ...BOOKING_SELECT,
        space: { select: { id: true, name: true, address_line1: true } },
        user:  { select: { id: true, first_name: true, last_name: true, avatar_url: true } },
        vehicle: { select: { id: true, plate_number: true, type: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.booking.count({ where }),
  ]);

  return { bookings, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// PATCH /host/bookings/:id/approve
// Only for non-instant-book spaces with pending bookings
// ─────────────────────────────────────────────
export async function approveBooking(hostId: string, bookingId: string) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, space: { host_id: hostId } },
    select: { ...BOOKING_SELECT, space: { select: { host_id: true, cancellation_policy: true, instant_book: true } } },
  });
  if (!booking) throw AppError.notFound('Booking');

  if (booking.status !== 'pending') {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      `Only pending bookings can be approved. Current status: '${booking.status}'`
    );
  }

  if (booking.space?.instant_book) {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      'Instant-book spaces do not require host approval.'
    );
  }

  const hasCompletedPayment = await hasCompletedPaymentTransaction(bookingId);
  if (!hasCompletedPayment) {
    throw AppError.conflict(
      ErrorCode.PAYMENT_FAILED,
      'Booking payment has not completed yet. Only paid bookings can be approved.'
    );
  }

  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: 'confirmed' },
    select: BOOKING_SELECT,
  });

  // Create host earnings record
  await createHostEarning(
    booking.space!.host_id,
    bookingId,
    Number(booking.base_price)
  ).catch(() => {});

  // Notify user their booking was approved
  notifyBookingConfirmed(booking.user_id, bookingId, '').catch(() => {});

  // Real-time events
  emitBookingStatusChange(booking.user_id, hostId, bookingId, 'confirmed');
  emitSpaceAvailabilityUpdate(booking.space_id).catch(() => {});

  return updated;
}

// ─────────────────────────────────────────────
// PATCH /host/bookings/:id/reject
// Pending booking rejected — full refund to user wallet
// ─────────────────────────────────────────────
export async function rejectBooking(hostId: string, bookingId: string, dto: RejectBookingDto) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, space: { host_id: hostId } },
    select: { ...BOOKING_SELECT, space: { select: { host_id: true, instant_book: true } } },
  });
  if (!booking) throw AppError.notFound('Booking');

  if (booking.status !== 'pending') {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      `Only pending bookings can be rejected. Current status: '${booking.status}'`
    );
  }

  if (booking.space?.instant_book) {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      'Instant-book spaces do not support host rejection.'
    );
  }

  await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status:              'cancelled',
      cancelled_by:        'host',
      cancellation_reason: dto.reason,
      refund_amount:       booking.total_price,
      cancelled_at:        new Date(),
    },
  });

  // Only refund if the user actually paid. Pending bookings may not have a
  // completed transaction (user hadn't paid yet), so guard before crediting.
  const paidTx = await prisma.transaction.findFirst({
    where:   { booking_id: bookingId, status: 'completed' },
    select:  { id: true },
    orderBy: { created_at: 'desc' },
  });

  if (paidTx) {
    await initiateRefund({
      transactionId: paidTx.id,
      reason:        `Booking rejected by host: ${dto.reason}`,
      initiatedBy:   hostId,
      refundTo:      'wallet',
    });
  }

  notifyBookingCancelled(booking.user_id, bookingId, `Rejected by host: ${dto.reason}`).catch(() => {});

  // Real-time events
  emitBookingStatusChange(booking.user_id, hostId, bookingId, 'cancelled', { reason: dto.reason });
  emitSpaceAvailabilityUpdate(booking.space_id).catch(() => {});

  const refundedAmount = paidTx ? Number(booking.total_price) : 0;
  return { rejected: true, refund_amount: refundedAmount, refunded_to: paidTx ? 'wallet' : null };
}

// ─────────────────────────────────────────────
// POST /host/bookings/:id/cancel
// Host cancels a confirmed booking:
//  - Full refund to user wallet
//  - Platform credit to user (5% of total as compensation)
//  - Host penalty recorded in audit log
// ─────────────────────────────────────────────
export async function hostCancelBooking(
  hostId: string,
  bookingId: string,
  dto: HostCancelBookingDto
) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, space: { host_id: hostId } },
    select: { ...BOOKING_SELECT, space: { select: { host_id: true } } },
  });
  if (!booking) throw AppError.notFound('Booking');

  if (!['confirmed', 'active'].includes(booking.status)) {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      `Only confirmed or active bookings can be cancelled by the host. Current status: '${booking.status}'`
    );
  }

  const totalPrice    = Number(booking.total_price);
  const platformCredit = Math.round(totalPrice * 0.05 * 100) / 100; // 5% penalty credit

  await prisma.$transaction(async (tx) => {
    // Cancel booking
    await tx.booking.update({
      where: { id: bookingId },
      data: {
        status:              'cancelled',
        cancelled_by:        'host',
        cancellation_reason: dto.reason,
        refund_amount:       totalPrice,
        cancelled_at:        new Date(),
      },
    });

    // Put host earnings on hold
    await tx.hostEarning.updateMany({
      where: { booking_id: bookingId },
      data:  { status: 'on_hold' },
    });

    // Audit log — penalty note
    await tx.auditLog.create({
      data: {
        actor_id:    hostId,
        action:      'booking.host_cancelled',
        entity_type: 'booking',
        entity_id:   bookingId,
        metadata: {
          reason:         dto.reason,
          penalty_credit: platformCredit,
          user_id:        booking.user_id,
        },
      },
    });
  });

  // Full refund via the proper refund service: creates Refund record,
  // marks Transaction as 'refunded', and credits the wallet atomically.
  const paidTx = await prisma.transaction.findFirst({
    where:   { booking_id: bookingId, status: 'completed' },
    select:  { id: true },
    orderBy: { created_at: 'desc' },
  });

  if (paidTx) {
    await initiateRefund({
      transactionId: paidTx.id,
      reason:        `Full refund — host cancelled booking`,
      initiatedBy:   hostId,
      refundTo:      'wallet',
    });
  }

  // Platform credit (5% compensation) to user wallet — separate cashback entry
  if (platformCredit > 0) {
    await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { user_id: booking.user_id } });
      if (!wallet) return;
      const newBalance = Number(wallet.balance) + platformCredit;
      await tx.wallet.update({ where: { id: wallet.id }, data: { balance: newBalance } });
      await tx.walletTransaction.create({
        data: {
          wallet_id:      wallet.id,
          type:           'cashback',
          amount:         platformCredit,
          reference_type: 'booking',
          reference_id:   bookingId,
          description:    'Platform credit — host cancellation compensation',
          balance_after:  newBalance,
        },
      });
    });
  }

  // Real-time events
  emitBookingStatusChange(booking.user_id, hostId, bookingId, 'cancelled', { reason: dto.reason, platform_credit: platformCredit });
  emitSpaceAvailabilityUpdate(booking.space_id).catch(() => {});

  return {
    cancelled: true,
    refund_amount: totalPrice,
    platform_credit: platformCredit,
    refunded_to: 'wallet',
  };
}

// ─────────────────────────────────────────────
// GET /host/bookings/:id  (host views one booking)
// ─────────────────────────────────────────────
export async function getHostBooking(hostId: string, bookingId: string) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, space: { host_id: hostId } },
    select: {
      ...BOOKING_SELECT,
      space: { select: { id: true, name: true, address_line1: true, city: true } },
      user:  { select: { id: true, first_name: true, last_name: true, avatar_url: true } },
      vehicle: { select: { id: true, plate_number: true, type: true, make: true, model: true } },
      transactions: {
        select: { status: true },
        orderBy: { created_at: 'desc' },
        take: 1,
      },
    },
  });
  if (!booking) throw AppError.notFound('Booking');

  const latestTransaction = booking.transactions[0] ?? null;
  return {
    ...booking,
    payment_status: latestTransaction?.status ?? 'unpaid',
  };
}

// ─────────────────────────────────────────────
// Receipt PDF generation
// ─────────────────────────────────────────────
export async function generateReceiptPdf(userId: string, bookingId: string): Promise<Buffer> {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, user_id: userId },
    select: {
      id: true,
      status: true,
      start_time: true,
      end_time: true,
      base_price: true,
      platform_fee: true,
      tax_amount: true,
      discount_amount: true,
      total_price: true,
      refund_amount: true,
      created_at: true,
      space:   { select: { name: true, address_line1: true, city: true, state: true } },
      slot:    { select: { slot_number: true } },
      vehicle: { select: { plate_number: true, make: true, model: true } },
      user:    { select: { first_name: true, last_name: true, phone: true } },
      transactions: {
        where:   { status: 'completed' },
        select:  { payment_method: true, gateway: true, gateway_ref: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 1,
      },
    },
  });

  if (!booking) throw AppError.notFound('Booking');

  const receiptable = ['confirmed', 'active', 'completed', 'cancelled'];
  if (!receiptable.includes(booking.status)) {
    throw AppError.forbidden('Receipt is not available for this booking status');
  }
  if (booking.status === 'cancelled' && !booking.transactions.length) {
    throw AppError.forbidden('No payment was made for this booking');
  }

  return buildReceiptBuffer(booking);
}

function buildReceiptBuffer(booking: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fmt = (n: any) => `\u20B9${Number(n || 0).toFixed(2)}`;
    const tx = booking.transactions[0];
    const isCancelled = booking.status === 'cancelled';

    // Header
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#1d4ed8').text('JustPark', 50, 50);
    doc.fontSize(11).font('Helvetica').fillColor('#64748b')
      .text(isCancelled ? 'Cancellation Receipt' : 'Booking Receipt', 50, 78);
    doc.moveTo(50, 100).lineTo(545, 100).strokeColor('#e2e8f0').lineWidth(1).stroke();

    let y = 115;
    const row = (label: string, value: string, xL = 50, xV = 155) => {
      doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(label, xL, y);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text(value || '—', xV, y);
      y += 18;
    };
    const section = (title: string) => {
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#f1f5f9').lineWidth(1).stroke();
      y += 12;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text(title, 50, y);
      y += 18;
    };

    // Booking info
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('BOOKING DETAILS', 50, y); y += 18;
    row('Booking ID', `#${booking.id}`);
    row('Status', booking.status.toUpperCase());
    row('Issued',  new Date(booking.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }));

    section('PARKING SPOT');
    row('Location', booking.space?.name || '—');
    row('Address', [booking.space?.address_line1, booking.space?.city, booking.space?.state].filter(Boolean).join(', ') || '—');
    row('Slot', booking.slot?.slot_number ? `Slot ${booking.slot.slot_number}` : 'Allocated at check-in');

    section('RESERVATION TIME');
    row('Entry',    new Date(booking.start_time).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }));
    row('Exit',     new Date(booking.end_time).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }));
    const hours = Math.max(1, Math.round((new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) / 3_600_000));
    row('Duration', `${hours} hour${hours !== 1 ? 's' : ''}`);

    if (booking.vehicle) {
      section('VEHICLE');
      row('Vehicle',  [booking.vehicle.make, booking.vehicle.model].filter(Boolean).join(' ') || '—');
      row('Plate No.', booking.vehicle.plate_number || '—');
    }

    section('DRIVER');
    row('Name',  `${booking.user?.first_name || ''} ${booking.user?.last_name || ''}`.trim() || '—');
    row('Phone', booking.user?.phone || '—');

    section('PAYMENT BREAKDOWN');
    const priceRow = (label: string, value: string, color = '#0f172a') => {
      doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(label, 50, y);
      doc.font('Helvetica').fontSize(9).fillColor(color).text(value, 50, y, { align: 'right', width: 495 });
      y += 16;
    };
    priceRow('Base Price', fmt(booking.base_price));
    if (Number(booking.platform_fee)    > 0) priceRow('Platform Fee',  fmt(booking.platform_fee));
    if (Number(booking.tax_amount)      > 0) priceRow('Tax',            fmt(booking.tax_amount));
    if (Number(booking.discount_amount) > 0) priceRow('Discount',      `-${fmt(booking.discount_amount)}`, '#16a34a');

    y += 4;
    doc.rect(50, y, 495, 28).fillColor('#eff6ff').fill();
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1d4ed8').text('Total Paid', 60, y + 8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1d4ed8').text(fmt(booking.total_price), 50, y + 8, { align: 'right', width: 488 });
    y += 36;

    if (isCancelled && Number(booking.refund_amount) > 0) {
      doc.rect(50, y, 495, 24).fillColor('#f0fdf4').fill();
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#15803d').text('Refund Issued', 60, y + 6);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#15803d').text(fmt(booking.refund_amount), 50, y + 6, { align: 'right', width: 488 });
      y += 32;
    }

    if (tx) {
      section('PAYMENT INFO');
      row('Method',    tx.payment_method?.replace(/_/g, ' ').toUpperCase() || '—');
      row('Gateway',   tx.gateway?.toUpperCase() || '—');
      if (tx.gateway_ref) row('Reference', tx.gateway_ref);
      row('Date', new Date(tx.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }));
    }

    doc.moveTo(50, y + 8).lineTo(545, y + 8).strokeColor('#e2e8f0').lineWidth(1).stroke();
    doc.fontSize(8).font('Helvetica').fillColor('#94a3b8')
      .text('This is a computer-generated receipt and does not require a signature.', 50, y + 18, { align: 'center', width: 495 });

    doc.end();
  });
}
