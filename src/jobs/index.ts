import { Queue } from 'bullmq';
import { env } from '../config/env';

function buildBullMqConnection() {
  const redisUrl = new URL(env.REDIS_URL);

  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || '6379'),
    password: redisUrl.password || undefined,
    db: Number(redisUrl.pathname.replace('/', '') || '0'),
  };
}

// ─────────────────────────────────────────────
// Shared BullMQ connection config (ioredis-compatible)
// ─────────────────────────────────────────────
export const connection = buildBullMqConnection();

// ─────────────────────────────────────────────
// Queue definitions
// ─────────────────────────────────────────────

/** Sends push / email / SMS notifications based on user preferences */
export const notificationQueue = new Queue('notifications', {
  connection,
  defaultJobOptions: {
    attempts:    3,
    backoff:     { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 500 },
    removeOnFail:    { count: 200 },
  },
});

/** Marks bookings as completed, triggers earnings calculation, sends reminders */
export const bookingQueue = new Queue('bookings', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff:  { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail:    { count: 100 },
  },
});

/** Processes host payout bank transfers and releases held earnings */
export const payoutQueue = new Queue('payouts', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff:  { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail:    { count: 100 },
  },
});

/** System maintenance: OTP cleanup, lock release */
export const maintenanceQueue = new Queue('maintenance', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff:  { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 50 },
    removeOnFail:    { count: 50 },
  },
});

/** Generates host tax reports (monthly / on-demand) */
export const reportsQueue = new Queue('reports', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff:  { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 100 },
    removeOnFail:    { count: 50 },
  },
});

/** Fraud detection scans */
export const fraudQueue = new Queue('fraud', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff:  { type: 'fixed', delay: 60_000 },
    removeOnComplete: { count: 50 },
    removeOnFail:    { count: 50 },
  },
});
