import {
  bookingQueue,
  payoutQueue,
  maintenanceQueue,
  fraudQueue,
  reportsQueue,
} from './index';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// setupSchedulers
// Registers all cron-based repeatable jobs using BullMQ's upsertJobScheduler.
// Safe to call on every startup — upsert is idempotent.
// ─────────────────────────────────────────────
export async function setupSchedulers(): Promise<void> {
  logger.info('Setting up BullMQ job schedulers…');

  await Promise.all([
    // ── Booking jobs ────────────────────────────────────────────────

    // Cron: every 5 minutes — mark active bookings past end_time as completed
    bookingQueue.upsertJobScheduler(
      'scheduler:process-booking-completion',
      { pattern: '*/5 * * * *' },
      { name: 'process-booking-completion', data: {} }
    ),

    // Cron: every 1 minute — clean up expired Redis slot locks and DB booking locks
    bookingQueue.upsertJobScheduler(
      'scheduler:release-expired-locks',
      { pattern: '* * * * *' },
      { name: 'release-expired-locks', data: {} }
    ),

    // Cron: every 5 minutes — cancel pending bookings unpaid for > 30 min
    bookingQueue.upsertJobScheduler(
      'scheduler:auto-cancel-unconfirmed',
      { pattern: '*/5 * * * *' },
      { name: 'auto-cancel-unconfirmed', data: {} }
    ),

    // Cron: every 5 minutes — send 1-hour-before booking reminders
    bookingQueue.upsertJobScheduler(
      'scheduler:send-booking-reminder',
      { pattern: '*/5 * * * *' },
      { name: 'send-booking-reminder', data: {} }
    ),

    // Cron: every 5 minutes — send 30-minute expiry warnings
    bookingQueue.upsertJobScheduler(
      'scheduler:send-expiry-warning',
      { pattern: '*/5 * * * *' },
      { name: 'send-expiry-warning', data: {} }
    ),

    // Cron: every 5 minutes — send 15-minute extend-booking prompt for active bookings
    bookingQueue.upsertJobScheduler(
      'scheduler:send-extension-prompt',
      { pattern: '*/5 * * * *' },
      { name: 'send-extension-prompt', data: {} }
    ),

    // Cron: every 5 minutes — transition confirmed bookings to active once start_time passes
    bookingQueue.upsertJobScheduler(
      'scheduler:activate-confirmed-bookings',
      { pattern: '*/5 * * * *' },
      { name: 'activate-confirmed-bookings', data: {} }
    ),

    // Cron: every 5 minutes — mark confirmed bookings as no_show after 30-min grace period
    bookingQueue.upsertJobScheduler(
      'scheduler:detect-no-shows',
      { pattern: '*/5 * * * *' },
      { name: 'detect-no-shows', data: {} }
    ),

    // ── Payout jobs ─────────────────────────────────────────────────

    // Cron: daily at 2 AM — process pending payout requests
    payoutQueue.upsertJobScheduler(
      'scheduler:process-payouts',
      { pattern: '0 2 * * *' },
      { name: 'process-payouts', data: {} }
    ),

    // Cron: daily at 3 AM — move pending earnings past dispute window → available
    payoutQueue.upsertJobScheduler(
      'scheduler:release-held-earnings',
      { pattern: '0 3 * * *' },
      { name: 'release-held-earnings', data: {} }
    ),

    // ── Maintenance jobs ─────────────────────────────────────────────

    // Cron: hourly — delete expired OTP tokens
    maintenanceQueue.upsertJobScheduler(
      'scheduler:cleanup-expired-otps',
      { pattern: '0 * * * *' },
      { name: 'cleanup-expired-otps', data: {} }
    ),

    // Cron: every 5 minutes — check Redis memory usage and alert if thresholds exceeded
    maintenanceQueue.upsertJobScheduler(
      'scheduler:check-redis-memory',
      { pattern: '*/5 * * * *' },
      { name: 'check-redis-memory', data: {} }
    ),

    // ── Fraud detection ──────────────────────────────────────────────

    // Cron: every 6 hours — scan for suspicious patterns
    fraudQueue.upsertJobScheduler(
      'scheduler:fraud-detection-scan',
      { pattern: '0 */6 * * *' },
      { name: 'fraud-detection-scan', data: {} }
    ),

    // ── Reports — monthly tax report (1st of each month at 4 AM) ────
    reportsQueue.upsertJobScheduler(
      'scheduler:generate-tax-report-monthly',
      { pattern: '0 4 1 * *' },
      {
        name: 'generate-tax-report',
        data: {
          // year/month resolved at job execution time by the processor
          year:  new Date().getFullYear(),
          month: new Date().getMonth() === 0 ? 12 : new Date().getMonth(), // previous month
        },
      }
    ),
  ]);

  logger.info('✅  BullMQ schedulers registered');
}
