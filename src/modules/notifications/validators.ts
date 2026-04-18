import { z } from 'zod';

// ─────────────────────────────────────────────
// GET /notifications — list query
// ─────────────────────────────────────────────
export const ListNotificationsQuerySchema = z.object({
  unread_only: z.string().optional().transform((v) => v === 'true'),
  page:  z.string().optional().transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit: z.string().optional().transform((v) => Math.min(50, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;

// ─────────────────────────────────────────────
// Route param — :id
// ─────────────────────────────────────────────
export const NotificationIdParamSchema = z.object({
  id: z.string().uuid('Invalid notification ID'),
});
export type NotificationIdParam = z.infer<typeof NotificationIdParamSchema>;

// ─────────────────────────────────────────────
// PATCH /notifications/preferences — update per-event settings
// ─────────────────────────────────────────────
const eventTypes = [
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

export const UpdatePreferencesSchema = z.object({
  preferences: z.array(
    z.object({
      event_type:    z.enum(eventTypes),
      push_enabled:  z.boolean().optional(),
      email_enabled: z.boolean().optional(),
      sms_enabled:   z.boolean().optional(),
    })
  ).min(1, 'At least one preference entry is required'),
});
export type UpdatePreferencesDto = z.infer<typeof UpdatePreferencesSchema>;

// ─────────────────────────────────────────────
// POST /notifications/register-device
// ─────────────────────────────────────────────
export const RegisterDeviceSchema = z.object({
  token:    z.string({ required_error: 'Device token is required' }).min(10),
  platform: z.enum(['fcm', 'apns']).default('fcm'),
});
export type RegisterDeviceDto = z.infer<typeof RegisterDeviceSchema>;
