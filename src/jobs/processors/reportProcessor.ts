import { Job } from 'bullmq';
import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────
// generate-tax-report
// Monthly or on-demand
// Aggregates host earnings data for a given month/year
// ─────────────────────────────────────────────
export async function generateTaxReport(job: Job): Promise<void> {
  const { year, month, hostId } = job.data as {
    year:    number;
    month:   number;   // 1–12
    hostId?: string;
  };

  const from = new Date(year, month - 1, 1);           // first day of month
  const to   = new Date(year, month, 1);               // first day of next month

  const statusFilter = { in: ['available', 'paid_out'] as ('available' | 'paid_out')[] };
  const where = {
    created_at: { gte: from, lt: to },
    status: statusFilter,
    ...(hostId ? { host_id: hostId } : {}),
  };

  // Aggregate gross / commission / net for the period
  const totals = await prisma.hostEarning.aggregate({
    where,
    _sum:   { gross_amount: true, commission_amount: true, net_amount: true },
    _count: { _all: true },
  });

  // Per-host breakdown (for all-hosts report)
  const breakdown = hostId ? null : await prisma.hostEarning.groupBy({
    by:      ['host_id'],
    where,
    _sum:    { gross_amount: true, commission_amount: true, net_amount: true },
    _count:  { _all: true },
    orderBy: { _sum: { net_amount: 'desc' } },
    take:    100,
  });

  const report = {
    period:         `${year}-${String(month).padStart(2, '0')}`,
    hostId:         hostId ?? 'all',
    booking_count:  totals._count._all,
    gross_amount:   Number(totals._sum.gross_amount ?? 0),
    commission:     Number(totals._sum.commission_amount ?? 0),
    net_amount:     Number(totals._sum.net_amount ?? 0),
    breakdown:      breakdown?.map((b) => ({
      host_id:        b.host_id,
      booking_count:  b._count._all,
      gross_amount:   Number(b._sum.gross_amount ?? 0),
      commission:     Number(b._sum.commission_amount ?? 0),
      net_amount:     Number(b._sum.net_amount ?? 0),
    })) ?? null,
    generated_at:   new Date().toISOString(),
  };

  // Store in audit_log (actor_id nullable — system-generated)
  await prisma.auditLog.create({
    data: {
      actor_id:    null,
      action:      'tax_report.generated',
      entity_type: 'tax_report',
      entity_id:   null,
      metadata:    report as never,
    },
  });

  logger.info({ msg: 'generate-tax-report', ...report });
}

// ─────────────────────────────────────────────
// Job dispatcher
// ─────────────────────────────────────────────
export async function reportJobDispatcher(job: Job): Promise<void> {
  switch (job.name) {
    case 'generate-tax-report': return generateTaxReport(job);
    default:
      logger.warn({ msg: 'Unknown report job type', name: job.name });
  }
}
