/**
 * EXPLAIN (ANALYZE, BUFFERS) for the 3 most-called list queries.
 *
 * Run:  npx ts-node scripts/explain-queries.ts
 *
 * Results are printed to stdout.  Use them to verify index usage and spot
 * sequential scans on large tables.
 *
 * The placeholder UUIDs intentionally return 0 rows so the script is safe
 * to run against any environment.  EXPLAIN ANALYZE still executes the query
 * and reports the real plan + I/O that the planner would use on real data.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: [] });

// ─────────────────────────────────────────────
// Helper — print section header + plan lines
// ─────────────────────────────────────────────
function printPlan(label: string, rows: Array<{ 'QUERY PLAN': string }>) {
  console.log('\n' + '═'.repeat(72));
  console.log(`  ${label}`);
  console.log('═'.repeat(72));
  rows.forEach((r) => console.log(r['QUERY PLAN']));
}

async function main() {
  // ── Query 1 ─────────────────────────────────────────────────────────────
  // listBookings — GET /bookings
  // Called on every page load for authenticated users.
  // Filters by user_id; JOINs parking_spaces + vehicles.
  // Prisma also issues a separate batched IN query for space_photos (take:1)
  // which is not represented here because it is O(1) queries regardless of
  // page size, and is covered by idx_space_photos_space_id.
  const q1 = await prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT
      b.id, b.user_id, b.space_id, b.slot_id, b.vehicle_id,
      b.start_time, b.end_time, b.status,
      b.base_price, b.platform_fee, b.tax_amount, b.discount_amount,
      b.total_price, b.cancellation_reason, b.cancelled_by,
      b.refund_amount, b.host_note, b.created_at, b.updated_at,
      s.id   AS s_id,   s.name,  s.address_line1, s.city,
      v.id   AS v_id,   v.plate_number, v.type
    FROM   bookings       b
    LEFT JOIN parking_spaces s ON s.id = b.space_id
    LEFT JOIN vehicles       v ON v.id = b.vehicle_id
    WHERE  b.user_id = '00000000-0000-0000-0000-000000000001'::uuid
    ORDER  BY b.created_at DESC
    LIMIT  20 OFFSET 0
  `;
  printPlan('Query 1 — listBookings  (GET /bookings, user booking history)', q1);

  // ── Query 2 ─────────────────────────────────────────────────────────────
  // listHostBookings — GET /host/bookings
  // Called on every host dashboard booking view.
  // Filters via the parking_spaces JOIN (host_id), so the planner must
  // navigate bookings → parking_spaces → filter, then back for the user/vehicle JOINs.
  // Key indexes: idx_spaces_host_id, idx_bookings_space_id, idx_bookings_user_id.
  const q2 = await prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT
      b.id, b.user_id, b.space_id, b.slot_id, b.vehicle_id,
      b.start_time, b.end_time, b.status,
      b.base_price, b.platform_fee, b.tax_amount, b.discount_amount,
      b.total_price, b.cancellation_reason, b.cancelled_by,
      b.refund_amount, b.host_note, b.created_at, b.updated_at,
      s.id   AS s_id,   s.name, s.address_line1,
      u.id   AS u_id,   u.first_name, u.last_name, u.avatar_url,
      v.id   AS v_id,   v.plate_number, v.type
    FROM   bookings       b
    JOIN   parking_spaces s ON s.id = b.space_id AND s.host_id = '00000000-0000-0000-0000-000000000002'::uuid
    LEFT JOIN users       u ON u.id = b.user_id
    LEFT JOIN vehicles    v ON v.id = b.vehicle_id
    ORDER  BY b.created_at DESC
    LIMIT  20 OFFSET 0
  `;
  printPlan('Query 2 — listHostBookings  (GET /host/bookings, host dashboard)', q2);

  // ── Query 3 ─────────────────────────────────────────────────────────────
  // getEarningsBreakdown — GET /host/earnings/breakdown
  // Three-level nested select: host_earnings → booking → (space + user).
  // Key indexes: idx_host_earnings_host_id, idx_host_earnings_status,
  //              idx_bookings_space_id (for the space join).
  const q3 = await prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT
      he.id,  he.gross_amount, he.commission_amount, he.net_amount,
      he.status, he.available_at, he.created_at,
      b.id    AS b_id,  b.start_time, b.end_time, b.status AS b_status,
      s.id    AS s_id,  s.name,
      u.id    AS u_id,  u.first_name, u.last_name
    FROM   host_earnings   he
    LEFT JOIN bookings       b ON b.id  = he.booking_id
    LEFT JOIN parking_spaces s ON s.id  = b.space_id
    LEFT JOIN users          u ON u.id  = b.user_id
    WHERE  he.host_id = '00000000-0000-0000-0000-000000000002'::uuid
    ORDER  BY he.created_at DESC
    LIMIT  20 OFFSET 0
  `;
  printPlan('Query 3 — getEarningsBreakdown  (GET /host/earnings/breakdown)', q3);

  console.log('\n' + '═'.repeat(72));
  console.log('  Done.');
  console.log('═'.repeat(72) + '\n');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
