import { Worker, Job } from 'bullmq';
import { env } from '../../config/env';
import { prisma } from '../../config/database';
import { redis, RedisKeys } from '../../config/redis';
import { sendPush } from '../../services/pushService';
import { sendEmail } from '../../services/emailService';
import { sendSms } from '../../services/smsService';
import { logger } from '../../utils/logger';
import type { NotificationJobPayload } from '../../services/notification';

// ─────────────────────────────────────────────
// Notification Job Processor — Phase 15
// Called by BullMQ worker when a notification job is dequeued
// ─────────────────────────────────────────────

export async function processNotificationJob(job: Job<NotificationJobPayload>): Promise<void> {
  const { userId, eventType, title, body, data } = job.data;

  logger.debug({ msg: 'Processing notification job', jobId: job.id, userId, eventType });

  // Fetch user preferences for this event type
  const [pref, user] = await Promise.all([
    prisma.notificationPreference.findUnique({
      where: { user_id_event_type: { user_id: userId, event_type: eventType } },
    }),
    prisma.user.findUnique({
      where:  { id: userId },
      select: { email: true, phone: true, first_name: true },
    }),
  ]);

  // Defaults if no preference row exists
  const pushEnabled  = pref?.push_enabled  ?? true;
  const emailEnabled = pref?.email_enabled ?? true;
  const smsEnabled   = pref?.sms_enabled   ?? false;

  const tasks: Promise<void>[] = [];

  // Push notification
  if (pushEnabled) {
    const rawTokens = await redis.smembers(RedisKeys.deviceTokens(userId));
    if (rawTokens.length > 0) {
      const dataAsStrings: Record<string, string> = data
        ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))
        : {};
      tasks.push(sendPush(rawTokens, title, body, dataAsStrings));
    }
  }

  // Email notification
  if (emailEnabled && user?.email) {
    tasks.push(
      sendEmail({ to: user.email, subject: title, html: `<p>${body}</p>` })
    );
  }

  // SMS — critical events only
  const SMS_EVENTS = new Set(['payment_failed', 'booking_confirmed', 'booking_cancelled']);
  if (smsEnabled && SMS_EVENTS.has(eventType) && user?.phone) {
    tasks.push(sendSms(user.phone, `JustPark: ${body}`));
  }

  await Promise.allSettled(tasks);
}

// ─────────────────────────────────────────────
// Worker factory — call startNotificationWorker() in server startup (Phase 15)
// ─────────────────────────────────────────────
export function startNotificationWorker(): Worker {
  return new Worker<NotificationJobPayload>(
    'notifications',
    processNotificationJob,
    {
      connection: {
        host:     env.REDIS_HOST,
        port:     env.REDIS_PORT,
        password: env.REDIS_PASSWORD,
        db:       env.REDIS_DB,
      },
      concurrency: 10,
    }
  );
}
