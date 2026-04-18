import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './controller';
import {
  ListNotificationsQuerySchema,
  NotificationIdParamSchema,
  UpdatePreferencesSchema,
  RegisterDeviceSchema,
} from './validators';

export const notificationsRouter = Router();

// All notification routes require authentication
notificationsRouter.use(authenticate);

/**
 * GET /notifications
 * List paginated notifications, unread first. ?unread_only=true to filter.
 */
notificationsRouter.get(
  '/',
  validate(ListNotificationsQuerySchema, 'query'),
  controller.listNotifications
);

/**
 * PATCH /notifications/read-all
 * Mark all unread notifications as read.
 * Must come before /:id to avoid route conflict.
 */
notificationsRouter.patch('/read-all', controller.markAllAsRead);

/**
 * PATCH /notifications/:id/read
 * Mark a single notification as read.
 */
notificationsRouter.patch(
  '/:id/read',
  validate(NotificationIdParamSchema, 'params'),
  controller.markAsRead
);

/**
 * GET /notifications/preferences
 * Get per-event-type push/email/sms preference settings.
 */
notificationsRouter.get('/preferences', controller.getPreferences);

/**
 * PATCH /notifications/preferences
 * Update push/email/sms toggles for one or more event types.
 */
notificationsRouter.patch(
  '/preferences',
  validate(UpdatePreferencesSchema),
  controller.updatePreferences
);

/**
 * POST /notifications/register-device
 * Register an FCM or APNs device token for push notifications.
 */
notificationsRouter.post(
  '/register-device',
  validate(RegisterDeviceSchema),
  controller.registerDevice
);
