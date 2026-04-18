import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { getIO } from './index';

// ─────────────────────────────────────────────
// emitSpaceAvailabilityUpdate
// Emitted to: space:{spaceId}
// Triggered by: booking created, cancelled, or lock acquired/released
// ─────────────────────────────────────────────
export async function emitSpaceAvailabilityUpdate(spaceId: string): Promise<void> {
  try {
    const io = getIO();

    // Compute available slots = total_capacity − active/confirmed bookings
    const [space, activeCount] = await Promise.all([
      prisma.parkingSpace.findUnique({
        where:  { id: spaceId },
        select: { total_capacity: true },
      }),
      prisma.booking.count({
        where: {
          space_id: spaceId,
          status:   { in: ['confirmed', 'active'] },
        },
      }),
    ]);

    const availableSlots = Math.max(0, (space?.total_capacity ?? 0) - activeCount);

    io.to(`space:${spaceId}`).emit('space:availability-update', {
      spaceId,
      availableSlots,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.debug({ msg: 'socket:emit:failed', event: 'space:availability-update', spaceId, err });
  }
}

// ─────────────────────────────────────────────
// emitBookingStatusChange
// Emitted to: user:{userId} AND host:{hostId}
// Triggered by: booking confirmed, cancelled, completed, modified
// ─────────────────────────────────────────────
export function emitBookingStatusChange(
  userId:    string,
  hostId:    string,
  bookingId: string,
  status:    string,
  details?:  Record<string, unknown>
): void {
  try {
    const io      = getIO();
    const payload = {
      bookingId,
      status,
      details:   details ?? {},
      updatedAt: new Date().toISOString(),
    };
    io.to(`user:${userId}`).emit('booking:status-change', payload);
    io.to(`host:${hostId}`).emit('booking:status-change', payload);
  } catch (err) {
    logger.debug({ msg: 'socket:emit:failed', event: 'booking:status-change', bookingId, err });
  }
}

// ─────────────────────────────────────────────
// emitNewNotification
// Emitted to: user:{userId}
// Triggered by: any new notification created
// ─────────────────────────────────────────────
export function emitNewNotification(
  userId:       string,
  notification: Record<string, unknown>
): void {
  try {
    getIO().to(`user:${userId}`).emit('notification:new', notification);
  } catch (err) {
    logger.debug({ msg: 'socket:emit:failed', event: 'notification:new', userId, err });
  }
}

// ─────────────────────────────────────────────
// emitPayoutUpdate
// Emitted to: host:{hostId}
// Triggered by: payout status changes
// ─────────────────────────────────────────────
export function emitPayoutUpdate(
  hostId:   string,
  payoutId: string,
  status:   string,
  amount:   number
): void {
  try {
    getIO().to(`host:${hostId}`).emit('payout:update', {
      payoutId,
      status,
      amount,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.debug({ msg: 'socket:emit:failed', event: 'payout:update', hostId, err });
  }
}
