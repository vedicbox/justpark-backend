import { prisma } from '../config/database';
import { notificationQueue } from '../jobs/index';
import { logger } from '../utils/logger';
import { emitNewNotification } from '../socket/handlers';
import type { NotificationEventType } from '../types';

// ─────────────────────────────────────────────
// Notification job payload (shared with processor)
// ─────────────────────────────────────────────
export interface NotificationJobPayload {
  userId:    string;
  eventType: string;
  title:     string;
  body:      string;
  data?:     Record<string, unknown>;
}

// ─────────────────────────────────────────────
// Channel override (optional — bypasses preferences)
// ─────────────────────────────────────────────
export interface ChannelOverride {
  inApp?: boolean;
  push?:  boolean;
  email?: boolean;
  sms?:   boolean;
}

// ─────────────────────────────────────────────
// sendNotification — main dispatcher
//   1. Creates an in-app DB notification record (always)
//   2. Dispatches a BullMQ job for push/email/SMS delivery
// ─────────────────────────────────────────────
export async function sendNotification(
  userId:    string,
  type:      NotificationEventType,
  title:     string,
  body:      string,
  data?:     Record<string, unknown>,
  channels?: ChannelOverride
): Promise<void> {
  try {
    // 1. In-app notification (synchronous DB write, unless explicitly disabled)
    let notification: Record<string, unknown> | undefined;
    if (channels?.inApp !== false) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created = await prisma.notification.create({
        data: { user_id: userId, type, title, body, data: (data ?? undefined) as any },
      });
      notification = created as unknown as Record<string, unknown>;
    }

    // 2. Emit real-time notification via Socket.IO (fire-and-forget)
    if (notification) {
      emitNewNotification(userId, notification);
    }

    // 3. Enqueue async job for push / email / SMS delivery
    const jobPayload: NotificationJobPayload = { userId, eventType: type, title, body, data };
    await notificationQueue.add(type, jobPayload, {
      jobId: `${type}:${userId}:${Date.now()}`,
    });
  } catch (err) {
    // Notification failures must never break the calling flow
    logger.error({ msg: 'sendNotification failed', userId, type, err });
  }
}

// ─────────────────────────────────────────────
// Convenience helpers — pre-built notification templates
// ─────────────────────────────────────────────

export function notifyBookingConfirmed(userId: string, bookingId: string, spaceName: string) {
  return sendNotification(
    userId,
    'booking_confirmed',
    'Booking Confirmed',
    `Your booking at ${spaceName} is confirmed.`,
    { booking_id: bookingId }
  );
}

export function notifyBookingCancelled(userId: string, bookingId: string, reason?: string) {
  return sendNotification(
    userId,
    'booking_cancelled',
    'Booking Cancelled',
    reason ? `Your booking was cancelled: ${reason}` : 'Your booking has been cancelled.',
    { booking_id: bookingId }
  );
}

export function notifyPaymentSuccess(userId: string, bookingId: string, amount: number) {
  return sendNotification(
    userId,
    'payment_success',
    'Payment Successful',
    `Payment of ₹${amount.toFixed(2)} received.`,
    { booking_id: bookingId, amount }
  );
}

export function notifyPaymentFailed(userId: string, bookingId: string) {
  return sendNotification(
    userId,
    'payment_failed',
    'Payment Failed',
    'Your payment could not be processed. Please try again.',
    { booking_id: bookingId }
  );
}

export function notifyRefundProcessed(userId: string, bookingId: string, amount: number) {
  return sendNotification(
    userId,
    'refund_processed',
    'Refund Processed',
    `A refund of ₹${amount.toFixed(2)} has been credited to your account.`,
    { booking_id: bookingId, amount }
  );
}

export function notifyHostNewBooking(hostId: string, bookingId: string, spaceName: string) {
  return sendNotification(
    hostId,
    'booking_confirmed',
    'New Booking Received',
    `You have a new booking request for ${spaceName}.`,
    { booking_id: bookingId, role: 'host' }
  );
}

export function notifySpaceApproved(hostId: string, spaceId: string, spaceName: string) {
  return sendNotification(
    hostId,
    'space_approved',
    'Listing Approved',
    `Your space "${spaceName}" has been approved and is now live.`,
    { space_id: spaceId, role: 'host' }
  );
}

export function notifySpaceRejected(hostId: string, spaceId: string, spaceName: string, reason: string) {
  return sendNotification(
    hostId,
    'space_rejected',
    'Listing Rejected',
    `Your space "${spaceName}" was rejected: ${reason}`,
    { space_id: spaceId, role: 'host' }
  );
}

export function notifyPayoutProcessed(hostId: string, payoutId: string, amount: number) {
  return sendNotification(
    hostId,
    'payout_processed',
    'Payout Processed',
    `Your payout of ₹${amount.toFixed(2)} has been processed.`,
    { payout_id: payoutId, amount, role: 'host' }
  );
}

export function notifyNewReview(hostId: string, reviewId: string, spaceName: string) {
  return sendNotification(
    hostId,
    'new_review',
    'New Review Received',
    `Someone left a review for your space "${spaceName}".`,
    { review_id: reviewId, role: 'host' }
  );
}

export function notifyKycApproved(userId: string) {
  return sendNotification(
    userId,
    'kyc_approved',
    'KYC Approved',
    'Your identity verification has been approved. You can now list spaces.',
    { role: 'host' }
  );
}

export function notifyKycRejected(userId: string, reason: string) {
  return sendNotification(
    userId,
    'kyc_rejected',
    'KYC Rejected',
    `Your identity verification was rejected: ${reason}`,
    { role: 'host' }
  );
}

export function notifyBookingReminder(userId: string, bookingId: string, spaceName: string, minutesBefore: number) {
  const label = minutesBefore <= 30 ? '30 minutes' : '1 hour';
  return sendNotification(
    userId,
    'booking_reminder',
    `Booking starts in ${label}`,
    `Your parking at ${spaceName} begins in ${label}. Get ready!`,
    { booking_id: bookingId }
  );
}

export function notifyBookingExpiryWarning(userId: string, bookingId: string, spaceName: string) {
  return sendNotification(
    userId,
    'booking_expiry_warning',
    'Parking expires in 30 minutes',
    `Your parking at ${spaceName} expires in 30 minutes.`,
    { booking_id: bookingId }
  );
}

export function notifyBookingExtensionReminder(userId: string, bookingId: string, spaceName: string) {
  return sendNotification(
    userId,
    'booking_extension_reminder',
    'Extend Booking?',
    `Your parking at ${spaceName} ends in 15 minutes. Would you like to extend?`,
    { booking_id: bookingId }
  );
}

export function notifyBookingExtended(
  userId: string, 
  hostId: string, 
  bookingId: string, 
  spaceName: string, 
  extensionHours: number
) {
  // Notify user
  sendNotification(
    userId,
    'booking_extended',
    'Booking Extended',
    `You have successfully extended your booking at ${spaceName} by ${extensionHours} hour(s).`,
    { booking_id: bookingId }
  ).catch(() => {});

  // Notify host
  return sendNotification(
    hostId,
    'booking_extended',
    'Booking Extended',
    `User has extended their booking at ${spaceName} by ${extensionHours} hour(s).`,
    { booking_id: bookingId, role: 'host' }
  );
}
