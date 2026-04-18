import { prisma } from '../../config/database';
import { redis, RedisKeys } from '../../config/redis';
import { AppError } from '../../middleware/errorHandler';
import { buildPaginationMeta } from '../../utils/pagination';
import type { ListNotificationsQuery, UpdatePreferencesDto, RegisterDeviceDto } from './validators';

// Device token TTL — 90 days (tokens expire / rotate)
const DEVICE_TOKEN_TTL = 90 * 24 * 60 * 60;

// ─────────────────────────────────────────────
// GET /notifications
// ─────────────────────────────────────────────
export async function listNotifications(userId: string, query: ListNotificationsQuery) {
  const { unread_only, page, limit } = query;
  const skip = (page - 1) * limit;

  const where = {
    user_id: userId,
    ...(unread_only ? { read: false } : {}),
  };

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: [{ read: 'asc' }, { created_at: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.notification.count({ where }),
  ]);

  const unread_count = unread_only
    ? total
    : await prisma.notification.count({ where: { user_id: userId, read: false } });

  return {
    notifications,
    unread_count,
    meta: buildPaginationMeta(total, page, limit),
  };
}

// ─────────────────────────────────────────────
// PATCH /notifications/:id/read
// ─────────────────────────────────────────────
export async function markAsRead(userId: string, notificationId: string) {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, user_id: userId },
  });
  if (!notification) throw AppError.notFound('Notification');

  if (notification.read) return notification;

  return prisma.notification.update({
    where: { id: notificationId },
    data:  { read: true },
  });
}

// ─────────────────────────────────────────────
// PATCH /notifications/read-all
// ─────────────────────────────────────────────
export async function markAllAsRead(userId: string): Promise<{ updated: number }> {
  const result = await prisma.notification.updateMany({
    where: { user_id: userId, read: false },
    data:  { read: true },
  });
  return { updated: result.count };
}

// ─────────────────────────────────────────────
// GET /notifications/preferences
// Returns merged list: explicit rows + defaults for missing event types
// ─────────────────────────────────────────────
const ALL_EVENT_TYPES = [
  'booking_confirmed',
  'booking_cancelled',
  'booking_reminder',
  'booking_expiry_warning',
  'booking_completed',
  'payment_success',
  'payment_failed',
  'refund_processed',
  'payout_processed',
  'kyc_approved',
  'kyc_rejected',
  'new_review',
  'space_approved',
  'space_rejected',
  'booking_extended',
  'dispute_opened',
  'dispute_resolved',
] as const;

export async function getPreferences(userId: string) {
  const rows = await prisma.notificationPreference.findMany({
    where:  { user_id: userId },
    select: { event_type: true, push_enabled: true, email_enabled: true, sms_enabled: true },
  });

  const rowMap = new Map(rows.map((r) => [r.event_type, r]));

  return ALL_EVENT_TYPES.map((event_type) => {
    const row = rowMap.get(event_type);
    return {
      event_type,
      push_enabled:  row?.push_enabled  ?? true,
      email_enabled: row?.email_enabled ?? true,
      sms_enabled:   row?.sms_enabled   ?? false,
    };
  });
}

// ─────────────────────────────────────────────
// PATCH /notifications/preferences
// Upserts per-event preference rows
// ─────────────────────────────────────────────
export async function updatePreferences(userId: string, dto: UpdatePreferencesDto) {
  await Promise.all(
    dto.preferences.map((pref) =>
      prisma.notificationPreference.upsert({
        where:  { user_id_event_type: { user_id: userId, event_type: pref.event_type } },
        create: {
          user_id:       userId,
          event_type:    pref.event_type,
          push_enabled:  pref.push_enabled  ?? true,
          email_enabled: pref.email_enabled ?? true,
          sms_enabled:   pref.sms_enabled   ?? false,
        },
        update: {
          ...(pref.push_enabled  !== undefined && { push_enabled:  pref.push_enabled }),
          ...(pref.email_enabled !== undefined && { email_enabled: pref.email_enabled }),
          ...(pref.sms_enabled   !== undefined && { sms_enabled:   pref.sms_enabled }),
        },
      })
    )
  );

  return getPreferences(userId);
}

// ─────────────────────────────────────────────
// POST /notifications/register-device
// Stores FCM/APNs token in Redis set per user
// ─────────────────────────────────────────────
export async function registerDevice(userId: string, dto: RegisterDeviceDto): Promise<void> {
  const key = RedisKeys.deviceTokens(userId);
  await redis.sadd(key, dto.token);
  await redis.expire(key, DEVICE_TOKEN_TTL);
}

// ─────────────────────────────────────────────
// (Internal) Remove a device token — called when FCM reports token invalid
// ─────────────────────────────────────────────
export async function removeDeviceToken(userId: string, token: string): Promise<void> {
  await redis.srem(RedisKeys.deviceTokens(userId), token);
}
