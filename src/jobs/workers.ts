import { Worker } from 'bullmq';
import { connection } from './index';
import { processNotificationJob } from './processors/notificationProcessor';
import { bookingJobDispatcher }    from './processors/bookingProcessor';
import { payoutJobDispatcher }     from './processors/payoutProcessor';
import { maintenanceJobDispatcher } from './processors/maintenanceProcessor';
import { reportJobDispatcher }     from './processors/reportProcessor';
import { fraudJobDispatcher }      from './processors/fraudProcessor';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// Worker factory — creates all BullMQ workers
// Returns workers array for graceful shutdown
// ─────────────────────────────────────────────
export function startAllWorkers(): Worker[] {
  const workers: Worker[] = [];

  // ── Notification worker (push/email/SMS delivery) ──
  const notificationWorker = new Worker(
    'notifications',
    processNotificationJob,
    { connection, concurrency: 10 }
  );

  // ── Booking worker (completion, reminders, earnings, locks) ──
  const bookingWorker = new Worker(
    'bookings',
    bookingJobDispatcher,
    { connection, concurrency: 5 }
  );

  // ── Payout worker (bank transfers, release held earnings) ──
  const payoutWorker = new Worker(
    'payouts',
    payoutJobDispatcher,
    { connection, concurrency: 2 }  // low concurrency — financial ops
  );

  // ── Maintenance worker (OTP cleanup) ──
  const maintenanceWorker = new Worker(
    'maintenance',
    maintenanceJobDispatcher,
    { connection, concurrency: 2 }
  );

  // ── Reports worker (tax reports) ──
  const reportsWorker = new Worker(
    'reports',
    reportJobDispatcher,
    { connection, concurrency: 1 }  // serialised — DB-heavy aggregations
  );

  // ── Fraud detection worker ──
  const fraudWorker = new Worker(
    'fraud',
    fraudJobDispatcher,
    { connection, concurrency: 1 }
  );

  workers.push(
    notificationWorker,
    bookingWorker,
    payoutWorker,
    maintenanceWorker,
    reportsWorker,
    fraudWorker
  );

  // Attach error handlers to all workers
  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      logger.error(
        { jobId: job?.id, jobName: job?.name, queue: worker.name, err },
        'Job failed'
      );
    });

    worker.on('error', (err) => {
      logger.error({ queue: worker.name, err }, 'Worker error');
    });
  }

  logger.info({ msg: 'All BullMQ workers started', count: workers.length });
  return workers;
}

// ─────────────────────────────────────────────
// Graceful shutdown — waits for active jobs to finish
// ─────────────────────────────────────────────
export async function stopAllWorkers(workers: Worker[]): Promise<void> {
  logger.info({ msg: 'Stopping BullMQ workers…', count: workers.length });

  await Promise.allSettled(
    workers.map((w) => w.close())  // close() waits for active job to complete
  );

  logger.info('✅  All BullMQ workers stopped');
}
