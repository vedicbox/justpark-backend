import { Job } from 'bullmq';
import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { sendNotification } from '../../services/notification';

// How many admin alerts to cap per scan cycle
const MAX_ALERTS = 20;

// ─────────────────────────────────────────────
// fraud-detection-scan
// Cron: every 6 hours
// Flags suspicious patterns and creates admin alert notifications
// ─────────────────────────────────────────────
export async function fraudDetectionScan(_job: Job): Promise<void> {
  const alerts: string[] = [];
  const now = new Date();
  const last24h  = new Date(now.getTime() - 24 * 3600_000);
  const last1h   = new Date(now.getTime() -       3600_000);
  const last7d   = new Date(now.getTime() - 7 * 24 * 3600_000);

  // ── 1. Users with > 5 failed payments in last 24 hours ──
  const failedPaymentGroups = await prisma.transaction.groupBy({
    by:    ['user_id'],
    where: { status: 'failed', created_at: { gte: last24h } },
    _count: { id: true },
  });
  const suspiciousPaymentUsers = failedPaymentGroups.filter((g) => g._count.id > 5);

  for (const group of suspiciousPaymentUsers.slice(0, MAX_ALERTS)) {
    const msg = `User ${group.user_id} had ${group._count.id} failed transactions in the last 24h`;
    alerts.push(msg);
    logger.warn({ msg: 'fraud-alert:failed-payments', userId: group.user_id, count: group._count.id });
  }

  // ── 2. Users with unusually high booking frequency (> 10 in last 1 hour) ──
  const highFrequencyGroups = await prisma.booking.groupBy({
    by:    ['user_id'],
    where: { created_at: { gte: last1h } },
    _count: { id: true },
  });
  const highFrequencyUsers = highFrequencyGroups.filter((g) => g._count.id > 10);

  for (const group of highFrequencyUsers.slice(0, MAX_ALERTS)) {
    const msg = `User ${group.user_id} made ${group._count.id} bookings in the last hour`;
    alerts.push(msg);
    logger.warn({ msg: 'fraud-alert:high-booking-frequency', userId: group.user_id, count: group._count.id });
  }

  // ── 3. Hosts with unusually high cancellation rate in last 7 days ──
  // Find hosts who cancelled > 5 bookings and have cancellation rate > 50%
  const hostCancellations = await prisma.booking.groupBy({
    by:    ['space_id'],
    where: { cancelled_by: 'host', updated_at: { gte: last7d } },
    _count: { id: true },
    having: { id: { _count: { gte: 5 } } },
  });

  for (const group of hostCancellations.slice(0, MAX_ALERTS)) {
    const total = await prisma.booking.count({
      where: { space_id: group.space_id, created_at: { gte: last7d } },
    });
    const rate = total > 0 ? group._count.id / total : 0;

    if (rate > 0.5) {
      const space = await prisma.parkingSpace.findUnique({
        where:  { id: group.space_id },
        select: { host_id: true, name: true },
      });
      const msg = `Space "${space?.name}" (host ${space?.host_id}) has ${Math.round(rate * 100)}% cancellation rate in last 7d`;
      alerts.push(msg);
      logger.warn({ msg: 'fraud-alert:high-cancellation-rate', spaceId: group.space_id, rate });
    }
  }

  // ── Notify all admins of flagged patterns ──
  if (alerts.length > 0) {
    const admins = await prisma.user.findMany({
      where:  { role: 'admin', status: 'active' },
      select: { id: true },
    });

    const summary = `Fraud scan detected ${alerts.length} suspicious pattern(s):\n${alerts.slice(0, 5).join('\n')}${alerts.length > 5 ? `\n…and ${alerts.length - 5} more` : ''}`;

    for (const admin of admins) {
      await sendNotification(
        admin.id,
        'system_broadcast',
        'Fraud Detection Alert',
        summary,
        { alert_count: alerts.length, alerts: alerts.slice(0, 10) }
      ).catch(() => {});
    }

    // Log to audit trail
    await prisma.auditLog.create({
      data: {
        actor_id:    null,
        action:      'fraud_scan.completed',
        entity_type: 'fraud_scan',
        entity_id:   null,
        metadata:    { alert_count: alerts.length, alerts } as never,
      },
    }).catch(() => {});
  }

  logger.info({ msg: 'fraud-detection-scan', alertsGenerated: alerts.length });
}

// ─────────────────────────────────────────────
// Job dispatcher
// ─────────────────────────────────────────────
export async function fraudJobDispatcher(job: Job): Promise<void> {
  switch (job.name) {
    case 'fraud-detection-scan': return fraudDetectionScan(job);
    default:
      logger.warn({ msg: 'Unknown fraud job type', name: job.name });
  }
}
