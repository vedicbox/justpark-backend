import { Job } from 'bullmq';
import { prisma } from '../../config/database';
import { checkRedisMemory } from '../../config/redis';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────
// cleanup-expired-otps
// Cron: hourly
// Deletes OTP records past their expiry to keep the table lean
// ─────────────────────────────────────────────
export async function cleanupExpiredOtps(_job: Job): Promise<void> {
  const now = new Date();

  const result = await prisma.otpToken.deleteMany({
    where: { expires_at: { lt: now } },
  });

  logger.info({ msg: 'cleanup-expired-otps', deleted: result.count });
}

// ─────────────────────────────────────────────
// check-redis-memory
// Cron: every 5 minutes
// Calls checkRedisMemory() which logs warn/error when thresholds are crossed.
// ─────────────────────────────────────────────
async function checkRedisMemoryJob(_job: Job): Promise<void> {
  const stats = await checkRedisMemory();
  logger.info({ msg: 'check-redis-memory', ...stats });
}

// ─────────────────────────────────────────────
// Job dispatcher
// ─────────────────────────────────────────────
export async function maintenanceJobDispatcher(job: Job): Promise<void> {
  switch (job.name) {
    case 'cleanup-expired-otps': return cleanupExpiredOtps(job);
    case 'check-redis-memory':   return checkRedisMemoryJob(job);
    default:
      logger.warn({ msg: 'Unknown maintenance job type', name: job.name });
  }
}
