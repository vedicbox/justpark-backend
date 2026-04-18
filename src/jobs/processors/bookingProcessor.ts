import { Job } from 'bullmq';
import { prisma } from '../../config/database';
import { redis, RedisKeys } from '../../config/redis';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import {
  sendNotification,
  notifyBookingCancelled,
  notifyBookingReminder,
  notifyBookingExpiryWarning,
  notifyBookingExtensionReminder,
} from '../../services/notification';
import type { SlotLockData } from '../../types';

// ─────────────────────────────────────────────
// process-booking-completion
// Cron: every 5 minutes
// Finds active bookings past end_time → marks completed → queues earnings
// ─────────────────────────────────────────────
export async function processBookingCompletion(_job: Job): Promise<void> {
  const now = new Date();

  const bookings = await prisma.booking.findMany({
    where: { status: 'active', end_time: { lt: now } },
    select: {
      id:          true,
      user_id:     true,
      total_price: true,
      space: { select: { host_id: true, name: true } },
    },
  });

  for (const booking of bookings) {
    try {
      await prisma.booking.update({
        where: { id: booking.id },
        data:  { status: 'completed' },
      });

      // Enqueue host earnings calculation (fire-and-forget per booking)
      const { bookingQueue } = await import('../index');
      await bookingQueue.add('calculate-host-earnings', {
        bookingId:   booking.id,
        hostId:      booking.space.host_id,
        totalPrice:  Number(booking.total_price),
      });

      // Notify user that parking has ended
      await sendNotification(
        booking.user_id,
        'booking_completed',
        'Parking Completed',
        `Your parking at ${booking.space.name} has ended. We hope you enjoyed it!`,
        { booking_id: booking.id }
      );
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, 'Failed to complete booking');
    }
  }

  logger.info({ msg: 'process-booking-completion', processed: bookings.length });
}

// ─────────────────────────────────────────────
// calculate-host-earnings
// On demand: dispatched after each booking completion
// ─────────────────────────────────────────────
export async function calculateHostEarnings(job: Job): Promise<void> {
  const { bookingId, hostId } = job.data as {
    bookingId:  string;
    hostId:     string;
    totalPrice: number; // Retained in source payload for legacy queued jobs
  };

  // Fetch actual base price from DB to avoid queue payload backwards compatibility issues
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: { base_price: true } });
  if (!booking) return;

  const gross      = Math.round(Number(booking.base_price) * 100) / 100;
  const commission = 0; // Platform fee already collected from user
  const net        = gross;
  const availableAt = new Date(Date.now() + env.DISPUTE_WINDOW_HOURS * 3_600_000);

  // Upsert — create if missing (safety net), skip if already exists
  await prisma.hostEarning.upsert({
    where:  { booking_id: bookingId },
    create: {
      host_id:           hostId,
      booking_id:        bookingId,
      gross_amount:      gross,
      commission_amount: commission,
      net_amount:        net,
      status:            'pending',
      available_at:      availableAt,
    },
    update: {}, // already exists from booking confirmation — don't overwrite
  });

  logger.debug({ msg: 'calculate-host-earnings', bookingId, gross, commission, net });
}

// ─────────────────────────────────────────────
// auto-cancel-unconfirmed
// Cron: every 5 minutes
// Cancels pending bookings with no completed payment after 30 min
// ─────────────────────────────────────────────
export async function autoCancelUnconfirmed(_job: Job): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 60_000);

  // Grace window: if a payment was initiated in the last 10 minutes (gateway_ref
  // exists, status still pending/processing), the user may have completed payment
  // and the webhook just hasn't arrived yet. Skip those bookings to avoid
  // cancelling a booking whose payment is genuinely in-flight.
  const webhookGrace = new Date(Date.now() - 10 * 60_000);

  const bookings = await prisma.booking.findMany({
    where: {
      status:     'pending',
      created_at: { lt: cutoff },
      AND: [
        // A paid approval-based booking is allowed to remain pending while the
        // host reviews it. Only unpaid bookings should auto-expire here.
        {
          transactions: {
            none: { status: 'completed' },
          },
        },
        {
          transactions: {
            none: {
              status:      { in: ['pending', 'processing'] },
              gateway_ref: { not: null },
              created_at:  { gte: webhookGrace },
            },
          },
        },
      ],
    },
    select: { id: true, user_id: true, space_id: true, start_time: true, end_time: true },
  });

  for (const booking of bookings) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            status:              'cancelled',
            cancelled_by:        'admin',
            cancellation_reason: 'Payment not received within 30 minutes',
          },
        });

        await tx.transaction.updateMany({
          where: {
            booking_id: booking.id,
            status:     { in: ['pending', 'processing'] },
          },
          data: { status: 'failed' },
        });
      });

      // Release Redis slot lock (backup — Redis TTL already handles it)
      const lockKey = RedisKeys.slotLock(
        booking.space_id,
        booking.start_time.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        booking.end_time.toISOString().replace(/\.\d{3}Z$/, 'Z')
      );
      await redis.del(lockKey).catch(() => {});

      // Clean up DB lock record if any
      await prisma.bookingLock.deleteMany({
        where: { space_id: booking.space_id, start_time: booking.start_time },
      }).catch(() => {});

      await notifyBookingCancelled(
        booking.user_id,
        booking.id,
        'Payment not received within 30 minutes'
      );
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, 'Failed to auto-cancel booking');
    }
  }

  logger.info({ msg: 'auto-cancel-unconfirmed', cancelled: bookings.length });
}

// ─────────────────────────────────────────────
// send-booking-reminder
// Cron: every 5 minutes
// Sends 1-hour-before reminder for upcoming confirmed bookings
// ─────────────────────────────────────────────
export async function sendBookingReminders(_job: Job): Promise<void> {
  // Window: bookings starting in 55–65 minutes
  const from = new Date(Date.now() + 55 * 60_000);
  const to   = new Date(Date.now() + 65 * 60_000);

  const bookings = await prisma.booking.findMany({
    where: { status: 'confirmed', start_time: { gte: from, lte: to } },
    select: {
      id:      true,
      user_id: true,
      space:   { select: { name: true } },
    },
  });

  for (const booking of bookings) {
    await notifyBookingReminder(booking.user_id, booking.id, booking.space.name, 60).catch(() => {});
  }

  logger.debug({ msg: 'send-booking-reminders', sent: bookings.length });
}

// ─────────────────────────────────────────────
// send-expiry-warning
// Cron: every 5 minutes
// Sends 30-minute-before expiry warning for active bookings
// ─────────────────────────────────────────────
export async function sendExpiryWarnings(_job: Job): Promise<void> {
  // Window: bookings ending in 25–35 minutes
  const from = new Date(Date.now() + 25 * 60_000);
  const to   = new Date(Date.now() + 35 * 60_000);

  const bookings = await prisma.booking.findMany({
    where: { status: 'active', end_time: { gte: from, lte: to } },
    select: {
      id:      true,
      user_id: true,
      space:   { select: { name: true } },
    },
  });

  for (const booking of bookings) {
    await notifyBookingExpiryWarning(booking.user_id, booking.id, booking.space.name).catch(() => {});
  }

  logger.debug({ msg: 'send-expiry-warnings', sent: bookings.length });
}

// ─────────────────────────────────────────────
// release-expired-locks
// Cron: every 1 minute
// Safety net: removes orphaned Redis slot locks and stale DB booking locks
// Redis TTL handles most expirations; this catches edge cases
// ─────────────────────────────────────────────
export async function releaseExpiredLocks(_job: Job): Promise<void> {
  const now = new Date();
  let released = 0;

  // 1. Clean stale Redis lock keys (backup to Redis TTL)
  const keys = await redis.keys('lock:*').catch(() => [] as string[]);
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue; // already expired via TTL

    try {
      const lock = JSON.parse(raw) as SlotLockData;
      if (new Date(lock.expiresAt) < now) {
        await redis.del(key);
        released++;
      }
    } catch {
      // Not JSON — check TTL; if no expiry set, delete as orphan
      const ttl = await redis.ttl(key);
      if (ttl === -1) {
        await redis.del(key);
        released++;
      }
    }
  }

  // 2. Clean expired BookingLock DB records
  const deleted = await prisma.bookingLock.deleteMany({
    where: { lock_expires_at: { lt: now } },
  });

  logger.debug({ msg: 'release-expired-locks', redisReleased: released, dbDeleted: deleted.count });
}

// ─────────────────────────────────────────────
// activate-confirmed-bookings
// Cron: every 5 minutes
// Finds confirmed bookings whose start_time has passed → transitions to active.
// updateMany with status='confirmed' is idempotent: once a booking is active
// it is never matched again, so duplicate runs are harmless.
// ─────────────────────────────────────────────
export async function activateConfirmedBookings(_job: Job): Promise<void> {
  const now = new Date();

  const result = await prisma.booking.updateMany({
    where: { status: 'confirmed', start_time: { lte: now } },
    data:  { status: 'active' },
  });

  logger.info({ msg: 'activate-confirmed-bookings', activated: result.count });
}

// ─────────────────────────────────────────────
// detect-no-shows
// Cron: every 5 minutes
// Confirmed bookings whose start_time passed the grace period without
// the user arriving are marked no_show.  Grace period = 30 minutes.
// updateMany with status filter makes this idempotent — a booking already
// in no_show (or any other terminal state) is never matched again.
// ─────────────────────────────────────────────
export async function detectNoShows(_job: Job): Promise<void> {
  const GRACE_PERIOD_MS = 30 * 60_000; // 30 minutes
  const cutoff = new Date(Date.now() - GRACE_PERIOD_MS);

  const bookings = await prisma.booking.findMany({
    where: { status: 'confirmed', start_time: { lt: cutoff } },
    select: { id: true, user_id: true, space: { select: { name: true } } },
  });

  if (bookings.length === 0) {
    logger.debug({ msg: 'detect-no-shows', marked: 0 });
    return;
  }

  // Bulk update to no_show — second filter in updateMany ensures idempotency
  await prisma.booking.updateMany({
    where: {
      id:     { in: bookings.map((b) => b.id) },
      status: 'confirmed',
    },
    data: { status: 'no_show' },
  });

  // Notify each affected user (best-effort — don't fail the job if a push fails)
  for (const booking of bookings) {
    await sendNotification(
      booking.user_id,
      'booking_no_show',
      'Booking Marked as No-Show',
      `Your booking at ${booking.space.name} was marked as no-show because the parking session did not start within 30 minutes of the scheduled time.`,
      { booking_id: booking.id }
    ).catch(() => {});
  }

  logger.info({ msg: 'detect-no-shows', marked: bookings.length });
}

// ─────────────────────────────────────────────
// send-extension-prompt
// Cron: every 5 minutes
// Sends a 15-minute-before prompt encouraging users to extend active bookings
// ─────────────────────────────────────────────
export async function sendExtensionPrompts(_job: Job): Promise<void> {
  // Window: bookings ending in 10–20 minutes (captures the 15-minute mark)
  const from = new Date(Date.now() + 10 * 60_000);
  const to   = new Date(Date.now() + 20 * 60_000);

  const bookings = await prisma.booking.findMany({
    where: { status: 'active', end_time: { gte: from, lte: to } },
    select: {
      id:      true,
      user_id: true,
      space:   { select: { name: true } },
    },
  });

  for (const booking of bookings) {
    await notifyBookingExtensionReminder(booking.user_id, booking.id, booking.space.name).catch(() => {});
  }

  logger.debug({ msg: 'send-extension-prompts', sent: bookings.length });
}

// ─────────────────────────────────────────────
// Job dispatcher — routes by job.name
// ─────────────────────────────────────────────
export async function bookingJobDispatcher(job: Job): Promise<void> {
  switch (job.name) {
    case 'process-booking-completion': return processBookingCompletion(job);
    case 'calculate-host-earnings':    return calculateHostEarnings(job);
    case 'auto-cancel-unconfirmed':    return autoCancelUnconfirmed(job);
    case 'send-booking-reminder':      return sendBookingReminders(job);
    case 'send-expiry-warning':        return sendExpiryWarnings(job);
    case 'send-extension-prompt':      return sendExtensionPrompts(job);
    case 'release-expired-locks':      return releaseExpiredLocks(job);
    case 'detect-no-shows':                return detectNoShows(job);
    case 'activate-confirmed-bookings':    return activateConfirmedBookings(job);
    default:
      logger.warn({ msg: 'Unknown booking job type', name: job.name });
  }
}
