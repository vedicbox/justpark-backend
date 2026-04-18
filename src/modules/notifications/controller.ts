import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import * as service from './service';
import type {
  ListNotificationsQuery,
  NotificationIdParam,
  UpdatePreferencesDto,
  RegisterDeviceDto,
} from './validators';

// ─────────────────────────────────────────────
// GET /notifications
// ─────────────────────────────────────────────
export async function listNotifications(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as ListNotificationsQuery;
    const { notifications, unread_count, meta } = await service.listNotifications(req.user!.sub, query);
    Respond.ok(res, { notifications, unread_count }, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /notifications/:id/read
// ─────────────────────────────────────────────
export async function markAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as NotificationIdParam;
    const notification = await service.markAsRead(req.user!.sub, id);
    Respond.ok(res, notification, 'Notification marked as read');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /notifications/read-all
// ─────────────────────────────────────────────
export async function markAllAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.markAllAsRead(req.user!.sub);
    Respond.ok(res, result, `${result.updated} notifications marked as read`);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /notifications/preferences
// ─────────────────────────────────────────────
export async function getPreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const preferences = await service.getPreferences(req.user!.sub);
    Respond.ok(res, preferences);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /notifications/preferences
// ─────────────────────────────────────────────
export async function updatePreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const preferences = await service.updatePreferences(req.user!.sub, req.body as UpdatePreferencesDto);
    Respond.ok(res, preferences, 'Preferences updated');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /notifications/register-device
// ─────────────────────────────────────────────
export async function registerDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.registerDevice(req.user!.sub, req.body as RegisterDeviceDto);
    Respond.ok(res, null, 'Device registered for push notifications');
  } catch (err) { next(err); }
}
