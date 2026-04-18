import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { Prisma, Amenity } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { uploadImage, deleteFile, extractKeyFromUrl, type UploadedFile } from '../../services/fileUpload';
import { encodeGeohash } from '../../utils/geohash';
import { encrypt, decrypt } from '../../utils/crypto';
import { buildPaginationMeta } from '../../utils/pagination';
import { ErrorCode } from '../../types';
import {
  isRazorpayXConfigured,
  createContact,
  createFundAccount,
} from '../../services/razorpayXService';
import { logger } from '../../utils/logger';
import type {
  CreateSpaceDto,
  UpdateSpaceDto,
  SetScheduleDto,
  AddBlackoutDto,
  SetPricingDto,
  ListSpacesQuery,
  EarningsBreakdownQuery,
  TaxSummaryQuery,
  PayoutListQuery,
  PayoutRequestDto,
  AddBankAccountDto,
  UpdateBankAccountDto,
  CreateSlotDto,
  UpdateSlotDto,
} from './validators';

// ─────────────────────────────────────────────
// Select (excludes Unsupported location field)
// ─────────────────────────────────────────────
const SPACE_SELECT = {
  id: true,
  host_id: true,
  name: true,
  description: true,
  address_line1: true,
  address_line2: true,
  city: true,
  state: true,
  postal_code: true,
  country: true,
  geohash: true,
  space_type: true,
  total_capacity: true,
  allowed_vehicles: true,
  status: true,
  cancellation_policy: true,
  min_booking_duration_minutes: true,
  max_booking_duration_minutes: true,
  buffer_minutes: true,
  instant_book: true,
  created_at: true,
  updated_at: true,
} as const;

const SPACE_DETAIL_SELECT = {
  ...SPACE_SELECT,
  photos: { orderBy: { display_order: 'asc' as const } },
  amenities: true,
  schedules: { orderBy: { day_of_week: 'asc' as const } },
  pricing_rules: true,
};

// ─────────────────────────────────────────────
// Ownership guard — throws 404 if not found or not owned
// ─────────────────────────────────────────────
async function assertOwnership(hostId: string, spaceId: string) {
  const space = await prisma.parkingSpace.findFirst({
    where: { id: spaceId, host_id: hostId },
    select: { id: true, status: true },
  });
  if (!space) throw AppError.notFound('Space');
  return space;
}

// ─────────────────────────────────────────────
// Set PostGIS location + geohash via raw SQL
// ─────────────────────────────────────────────
async function setLocation(spaceId: string, lat: number, lng: number): Promise<void> {
  const geohash = encodeGeohash(lat, lng, 9);
  await prisma.$executeRaw`
    UPDATE parking_spaces
    SET location = ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography,
        geohash  = ${geohash}
    WHERE id = ${spaceId}::uuid
  `;
}

// ─────────────────────────────────────────────
// POST /host/spaces — Create listing (status: draft)
// ─────────────────────────────────────────────
export async function createSpace(hostId: string, dto: CreateSpaceDto) {
  const kycDoc = await prisma.kycDocument.findFirst({
    where: { user_id: hostId },
    orderBy: { created_at: 'desc' },
    select: { status: true },
  });

  if (kycDoc?.status !== 'approved') {
    throw AppError.forbidden('KYC verification required to list spaces');
  }

  const { lat, lng, amenities, ...spaceFields } = dto;

  const space = await prisma.$transaction(async (tx) => {
    const created = await tx.parkingSpace.create({
      data: {
        ...spaceFields,
        host_id: hostId,
        status: 'draft',
        geohash: encodeGeohash(lat, lng, 9),
        ...(amenities && amenities.length > 0
          ? {
              amenities: {
                create: amenities.map((a) => ({ amenity: a as Amenity })),
              },
            }
          : {}),
        slots: {
          create: Array.from({ length: spaceFields.total_capacity }).map((_, i) => ({
            slot_number: `Slot ${i + 1}`,
          })),
        },
      },
      select: SPACE_DETAIL_SELECT,
    });

    return created;
  });

  // Set PostGIS location outside the Prisma transaction (raw SQL)
  await setLocation(space.id, lat, lng);

  return space;
}

// ─────────────────────────────────────────────
// GET /host/spaces — List host's spaces
// ─────────────────────────────────────────────
export async function listSpaces(hostId: string, query: ListSpacesQuery) {
  const { status, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.ParkingSpaceWhereInput = {
    host_id: hostId,
    ...(status ? { status } : {}),
  };

  const [spaces, total] = await Promise.all([
    prisma.parkingSpace.findMany({
      where,
      select: {
        ...SPACE_SELECT,
        photos: { select: { url: true }, orderBy: { display_order: 'asc' }, take: 1 },
        _count: { select: { bookings: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.parkingSpace.count({ where }),
  ]);

  return { spaces, total, page, limit };
}

// ─────────────────────────────────────────────
// GET /host/spaces/:id — Get space details
// ─────────────────────────────────────────────
export async function getSpace(hostId: string, spaceId: string) {
  const space = await prisma.parkingSpace.findFirst({
    where: { id: spaceId, host_id: hostId },
    select: SPACE_DETAIL_SELECT,
  });
  if (!space) throw AppError.notFound('Space');
  return space;
}

// ─────────────────────────────────────────────
// PATCH /host/spaces/:id — Update listing
// ─────────────────────────────────────────────
export async function updateSpace(hostId: string, spaceId: string, dto: UpdateSpaceDto) {
  await assertOwnership(hostId, spaceId);

  const { lat, lng, amenities, ...fields } = dto;

  await prisma.$transaction(async (tx) => {
    await tx.parkingSpace.update({
      where: { id: spaceId },
      data: {
        ...(fields.name !== undefined && { name: fields.name }),
        ...(fields.description !== undefined && { description: fields.description }),
        ...(fields.address_line1 !== undefined && { address_line1: fields.address_line1 }),
        ...(fields.address_line2 !== undefined && { address_line2: fields.address_line2 }),
        ...(fields.city !== undefined && { city: fields.city }),
        ...(fields.state !== undefined && { state: fields.state }),
        ...(fields.postal_code !== undefined && { postal_code: fields.postal_code }),
        ...(fields.country !== undefined && { country: fields.country }),
        ...(fields.space_type !== undefined && { space_type: fields.space_type }),
        ...(fields.total_capacity !== undefined && { total_capacity: fields.total_capacity }),
        ...(fields.allowed_vehicles !== undefined && { allowed_vehicles: fields.allowed_vehicles }),
        ...(fields.cancellation_policy !== undefined && { cancellation_policy: fields.cancellation_policy }),
        ...(fields.min_booking_duration_minutes !== undefined && { min_booking_duration_minutes: fields.min_booking_duration_minutes }),
        ...(fields.max_booking_duration_minutes !== undefined && { max_booking_duration_minutes: fields.max_booking_duration_minutes }),
        ...(fields.buffer_minutes !== undefined && { buffer_minutes: fields.buffer_minutes }),
        ...(fields.instant_book !== undefined && { instant_book: fields.instant_book }),
      },
    });

    // Replace amenities if provided
    if (amenities !== undefined) {
      await tx.spaceAmenity.deleteMany({ where: { space_id: spaceId } });
      if (amenities.length > 0) {
        await tx.spaceAmenity.createMany({
          data: amenities.map((a) => ({
            space_id: spaceId,
            amenity: a as Amenity,
          })),
          skipDuplicates: true,
        });
      }
    }
  });

  // Update location if lat/lng provided
  if (lat !== undefined && lng !== undefined) {
    await setLocation(spaceId, lat, lng);
  }

  return getSpace(hostId, spaceId);
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/submit — Submit for review
// Requires: ≥3 photos, ≥1 pricing rule, location set
// ─────────────────────────────────────────────
export async function submitSpace(hostId: string, spaceId: string) {
  const space = await prisma.parkingSpace.findFirst({
    where: { id: spaceId, host_id: hostId },
    select: {
      ...SPACE_SELECT,
      _count: { select: { photos: true, pricing_rules: true } },
    },
  });
  if (!space) throw AppError.notFound('Space');

  if (space.status !== 'draft' && space.status !== 'rejected') {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      `Space cannot be submitted from status '${space.status}'. Only draft or rejected spaces can be submitted.`
    );
  }

  if (space._count.photos < 3) {
    throw AppError.badRequest(
      ErrorCode.VALIDATION_ERROR,
      `A minimum of 3 photos is required before submission. Currently ${space._count.photos} photo(s) uploaded.`
    );
  }

  if (space._count.pricing_rules < 1) {
    throw AppError.badRequest(
      ErrorCode.VALIDATION_ERROR,
      'At least one pricing rule must be set before submission.'
    );
  }

  if (!space.geohash) {
    throw AppError.badRequest(
      ErrorCode.VALIDATION_ERROR,
      'Space location (lat/lng) must be set before submission.'
    );
  }

  return prisma.parkingSpace.update({
    where: { id: spaceId },
    data: { status: 'pending_review' },
    select: SPACE_SELECT,
  });
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/pause
// ─────────────────────────────────────────────
export async function pauseSpace(hostId: string, spaceId: string) {
  const space = await assertOwnership(hostId, spaceId);

  if (space.status !== 'active') {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      `Only active spaces can be paused. Current status: '${space.status}'.`
    );
  }

  return prisma.parkingSpace.update({
    where: { id: spaceId },
    data: { status: 'paused' },
    select: SPACE_SELECT,
  });
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/unpause
// ─────────────────────────────────────────────
export async function unpauseSpace(hostId: string, spaceId: string) {
  const space = await assertOwnership(hostId, spaceId);

  if (space.status !== 'paused') {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      `Only paused spaces can be unpaused. Current status: '${space.status}'.`
    );
  }

  return prisma.parkingSpace.update({
    where: { id: spaceId },
    data: { status: 'active' },
    select: SPACE_SELECT,
  });
}

// ─────────────────────────────────────────────
// DELETE /host/spaces/:id — Soft-delete (status → deleted)
// Blocked if confirmed/active bookings exist
// ─────────────────────────────────────────────
export async function deleteSpace(hostId: string, spaceId: string): Promise<void> {
  await assertOwnership(hostId, spaceId);

  const activeBooking = await prisma.booking.findFirst({
    where: { space_id: spaceId, status: { in: ['pending', 'confirmed', 'active'] } },
    select: { id: true },
  });
  if (activeBooking) {
    throw AppError.conflict(
      ErrorCode.SPACE_HAS_ACTIVE_BOOKINGS,
      'Cannot delete a space with active or confirmed bookings.'
    );
  }

  await prisma.parkingSpace.update({
    where: { id: spaceId },
    data: { status: 'deleted' },
  });
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/photos — Upload photo to S3
// ─────────────────────────────────────────────
export async function addPhoto(hostId: string, spaceId: string, file: UploadedFile) {
  await assertOwnership(hostId, spaceId);

  const { url } = await uploadImage(file, `spaces/host_${hostId}/space_${spaceId}`);

  // Get next display_order
  const last = await prisma.spacePhoto.findFirst({
    where: { space_id: spaceId },
    orderBy: { display_order: 'desc' },
    select: { display_order: true },
  });

  return prisma.spacePhoto.create({
    data: {
      space_id: spaceId,
      url,
      display_order: (last?.display_order ?? -1) + 1,
    },
  });
}

// ─────────────────────────────────────────────
// DELETE /host/spaces/:id/photos/:photoId
// ─────────────────────────────────────────────
export async function removePhoto(
  hostId: string,
  spaceId: string,
  photoId: string
): Promise<void> {
  await assertOwnership(hostId, spaceId);

  const photo = await prisma.spacePhoto.findFirst({
    where: { id: photoId, space_id: spaceId },
  });
  if (!photo) throw AppError.notFound('Photo');

  // Delete from S3 (best-effort)
  const key = extractKeyFromUrl(photo.url);
  if (key) deleteFile(key).catch(() => {/* S3 cleanup is best-effort */});

  await prisma.spacePhoto.delete({ where: { id: photoId } });
}

// ─────────────────────────────────────────────
// GET /host/spaces/:id/schedule
// ─────────────────────────────────────────────
export async function getSchedule(hostId: string, spaceId: string) {
  await assertOwnership(hostId, spaceId);

  return prisma.spaceSchedule.findMany({
    where: { space_id: spaceId },
    orderBy: { day_of_week: 'asc' },
  });
}

// ─────────────────────────────────────────────
// PUT /host/spaces/:id/schedule — Replace all schedule days
// ─────────────────────────────────────────────
export async function setSchedule(hostId: string, spaceId: string, dto: SetScheduleDto) {
  await assertOwnership(hostId, spaceId);

  return prisma.$transaction(async (tx) => {
    await tx.spaceSchedule.deleteMany({ where: { space_id: spaceId } });
    await tx.spaceSchedule.createMany({
      data: dto.schedules.map((s) => ({
        space_id: spaceId,
        day_of_week: s.day_of_week,
        open_time: s.open_time,
        close_time: s.close_time,
        is_closed: s.is_closed,
      })),
    });
    return tx.spaceSchedule.findMany({
      where: { space_id: spaceId },
      orderBy: { day_of_week: 'asc' },
    });
  });
}

// ─────────────────────────────────────────────
// GET /host/spaces/:id/blackout
// ─────────────────────────────────────────────
export async function getBlackoutDates(hostId: string, spaceId: string) {
  await assertOwnership(hostId, spaceId);

  return prisma.spaceBlackoutDate.findMany({
    where: { space_id: spaceId },
    orderBy: { date: 'asc' },
  });
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/blackout — Add blackout date
// ─────────────────────────────────────────────
export async function addBlackout(hostId: string, spaceId: string, dto: AddBlackoutDto) {
  await assertOwnership(hostId, spaceId);

  // Check for duplicate
  const existing = await prisma.spaceBlackoutDate.findFirst({
    where: { space_id: spaceId, date: new Date(dto.date) },
  });
  if (existing) {
    throw AppError.conflict(
      ErrorCode.ALREADY_EXISTS,
      `Blackout date ${dto.date} already exists for this space.`
    );
  }

  return prisma.spaceBlackoutDate.create({
    data: {
      space_id: spaceId,
      date: new Date(dto.date),
      reason: dto.reason,
    },
  });
}

// ─────────────────────────────────────────────
// DELETE /host/spaces/:id/blackout/:dateId
// ─────────────────────────────────────────────
export async function removeBlackout(
  hostId: string,
  spaceId: string,
  dateId: string
): Promise<void> {
  await assertOwnership(hostId, spaceId);

  const record = await prisma.spaceBlackoutDate.findFirst({
    where: { id: dateId, space_id: spaceId },
  });
  if (!record) throw AppError.notFound('Blackout date');

  await prisma.spaceBlackoutDate.delete({ where: { id: dateId } });
}

// ─────────────────────────────────────────────
// GET /host/spaces/:id/pricing
// ─────────────────────────────────────────────
export async function getPricing(hostId: string, spaceId: string) {
  await assertOwnership(hostId, spaceId);

  return prisma.spacePricingRule.findMany({
    where: { space_id: spaceId },
    orderBy: { rate_type: 'asc' },
  });
}

// ─────────────────────────────────────────────
// PUT /host/spaces/:id/pricing — Upsert pricing rules
// One rule per rate_type (unique constraint). Replace all.
// ─────────────────────────────────────────────
export async function setPricing(hostId: string, spaceId: string, dto: SetPricingDto) {
  await assertOwnership(hostId, spaceId);

  return prisma.$transaction(async (tx) => {
    await tx.spacePricingRule.deleteMany({ where: { space_id: spaceId } });
    await tx.spacePricingRule.createMany({
      data: dto.rules.map((r) => ({
        space_id: spaceId,
        rate_type: r.rate_type,
        base_rate: r.base_rate,
        currency: r.currency,
        peak_rules: r.peak_rules ?? Prisma.JsonNull,
        weekend_multiplier: r.weekend_multiplier,
        discount_rules: r.discount_rules ?? Prisma.JsonNull,
        min_price: r.min_price,
      })),
    });

    return tx.spacePricingRule.findMany({
      where: { space_id: spaceId },
      orderBy: { rate_type: 'asc' },
    });
  });
}

// ═════════════════════════════════════════════
// EARNINGS & PAYOUTS
// ═════════════════════════════════════════════

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function releaseMaturedHostEarnings(hostId: string): Promise<void> {
  await prisma.hostEarning.updateMany({
    where: {
      host_id:      hostId,
      status:       'pending',
      available_at: { lte: new Date(), not: null },
    },
    data: { status: 'available' },
  });
}

async function getPayoutAvailabilitySummary(hostId: string) {
  const [statusGroups, payoutReservedEarnings, payoutReservedCount, payoutGroups] = await Promise.all([
    prisma.hostEarning.groupBy({
      by:    ['status'],
      where: { host_id: hostId },
      _sum:  { net_amount: true },
      _count: { id: true },
    }),
    prisma.hostEarning.aggregate({
      where: {
        host_id:   hostId,
        status:    'on_hold',
        payout_id: { not: null },
      },
      _sum: { net_amount: true },
    }),
    prisma.hostEarning.count({
      where: {
        host_id:   hostId,
        status:    'on_hold',
        payout_id: { not: null },
      },
    }),
    prisma.payout.groupBy({
      by:    ['status'],
      where: { host_id: hostId },
      _sum:  { amount: true },
      _count: { id: true },
    }),
  ]);

  const summary: Record<string, { count: number; amount: number }> = {
    pending:   { count: 0, amount: 0 },
    available: { count: 0, amount: 0 },
    paid_out:  { count: 0, amount: 0 },
    on_hold:   { count: 0, amount: 0 },
  };

  for (const group of statusGroups) {
    summary[group.status] = {
      count:  group._count.id,
      amount: round2(Number(group._sum.net_amount ?? 0)),
    };
  }

  const payoutTotals = {
    requested:  { count: 0, amount: 0 },
    processing: { count: 0, amount: 0 },
    completed:  { count: 0, amount: 0 },
    failed:     { count: 0, amount: 0 },
  };

  for (const group of payoutGroups) {
    payoutTotals[group.status] = {
      count:  group._count.id,
      amount: round2(Number(group._sum.amount ?? 0)),
    };
  }

  const payoutReservedAmount = round2(Number(payoutReservedEarnings._sum.net_amount ?? 0));
  const completedPayoutAmount = payoutTotals.completed.amount;
  const inFlightPayoutAmount = round2(
    payoutTotals.requested.amount + payoutTotals.processing.amount
  );
  const disputeHoldAmount = round2(
    Math.max(0, summary.on_hold.amount - payoutReservedAmount)
  );
  const maturedEarningsAmount = round2(
    summary.available.amount + summary.paid_out.amount + payoutReservedAmount
  );
  const availableForPayout = round2(
    Math.max(maturedEarningsAmount - completedPayoutAmount - inFlightPayoutAmount, 0)
  );

  summary.available.amount = availableForPayout;
  summary.paid_out.amount = completedPayoutAmount;
  summary.paid_out.count = payoutTotals.completed.count;
  summary.on_hold.amount = round2(disputeHoldAmount + inFlightPayoutAmount);
  summary.on_hold.count = Math.max(summary.on_hold.count - payoutReservedCount, 0)
    + payoutTotals.requested.count
    + payoutTotals.processing.count;

  return { summary, availableForPayout };
}

// ─────────────────────────────────────────────
// GET /host/earnings — Dashboard summary
// ─────────────────────────────────────────────
export async function getEarningsDashboard(hostId: string) {
  await releaseMaturedHostEarnings(hostId);

  const now = new Date();
  const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), 1);
  const { summary, availableForPayout } = await getPayoutAvailabilitySummary(hostId);

  // Monthly trends — last 12 months
  const monthlyRows = await prisma.$queryRaw<Array<{ month: string; gross: number; commission: number; net: number }>>`
    SELECT
      TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
      COALESCE(SUM(gross_amount), 0)::float      AS gross,
      COALESCE(SUM(commission_amount), 0)::float AS commission,
      COALESCE(SUM(net_amount), 0)::float        AS net
    FROM host_earnings
    WHERE host_id      = ${hostId}::uuid
      AND created_at  >= ${twelveMonthsAgo}
    GROUP BY DATE_TRUNC('month', created_at)
    ORDER BY DATE_TRUNC('month', created_at)
  `;

  return {
    summary,
    available_for_payout: availableForPayout,
    monthly_trends: monthlyRows.map((r) => ({
      month:      r.month,
      gross:      round2(r.gross),
      commission: round2(r.commission),
      net:        round2(r.net),
    })),
  };
}

// ─────────────────────────────────────────────
// GET /host/earnings/breakdown — Per-booking breakdown
// ─────────────────────────────────────────────
export async function getEarningsBreakdown(hostId: string, query: EarningsBreakdownQuery) {
  await releaseMaturedHostEarnings(hostId);

  const { status, from, to, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.HostEarningWhereInput = { host_id: hostId };
  if (status) where.status = status;
  if (from || to) {
    where.created_at = {};
    if (from) where.created_at.gte = new Date(from);
    if (to)   where.created_at.lte = new Date(to);
  }

  const [earnings, total] = await Promise.all([
    prisma.hostEarning.findMany({
      where,
      select: {
        id:               true,
        gross_amount:     true,
        commission_amount: true,
        net_amount:       true,
        status:           true,
        available_at:     true,
        created_at:       true,
        booking: {
          select: {
            id:         true,
            start_time: true,
            end_time:   true,
            status:     true,
            space: { select: { id: true, name: true } },
            user:  { select: { id: true, first_name: true, last_name: true } },
          },
        },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.hostEarning.count({ where }),
  ]);

  return { earnings, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// GET /host/earnings/tax-summary — Annual tax summary
// ─────────────────────────────────────────────
export async function getTaxSummary(hostId: string, query: TaxSummaryQuery) {
  await releaseMaturedHostEarnings(hostId);

  const { year } = query;
  const from = new Date(year, 0, 1);
  const to   = new Date(year + 1, 0, 1);

  const monthlyRows = await prisma.$queryRaw<Array<{
    month: number; gross: number; commission: number; net: number; count: number;
  }>>`
    SELECT
      EXTRACT(MONTH FROM created_at)::int        AS month,
      COALESCE(SUM(gross_amount), 0)::float      AS gross,
      COALESCE(SUM(commission_amount), 0)::float AS commission,
      COALESCE(SUM(net_amount), 0)::float        AS net,
      COUNT(*)::int                              AS count
    FROM host_earnings
    WHERE host_id     = ${hostId}::uuid
      AND created_at >= ${from}
      AND created_at  < ${to}
      AND status     != 'on_hold'
    GROUP BY EXTRACT(MONTH FROM created_at)
    ORDER BY month
  `;

  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthlyBreakdown = Array.from({ length: 12 }, (_, i) => {
    const row = monthlyRows.find((r) => r.month === i + 1);
    return {
      month:         i + 1,
      month_name:    MONTH_NAMES[i],
      gross:         row ? round2(row.gross) : 0,
      commission:    row ? round2(row.commission) : 0,
      net:           row ? round2(row.net) : 0,
      booking_count: row ? row.count : 0,
    };
  });

  const totals = monthlyBreakdown.reduce(
    (acc, m) => ({
      total_gross:      round2(acc.total_gross + m.gross),
      total_commission: round2(acc.total_commission + m.commission),
      total_net:        round2(acc.total_net + m.net),
      total_bookings:   acc.total_bookings + m.booking_count,
    }),
    { total_gross: 0, total_commission: 0, total_net: 0, total_bookings: 0 }
  );

  return { year, ...totals, monthly_breakdown: monthlyBreakdown };
}

// ─────────────────────────────────────────────
// GET /host/payouts — Payout history
// ─────────────────────────────────────────────
export async function listPayouts(hostId: string, query: PayoutListQuery) {
  const { status, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.PayoutWhereInput = { host_id: hostId };
  if (status) where.status = status;

  const [payouts, total] = await Promise.all([
    prisma.payout.findMany({
      where,
      select: {
        id:           true,
        amount:       true,
        status:       true,
        processed_at: true,
        created_at:   true,
        bank_account: {
          select: { bank_name: true, account_holder_name: true, ifsc_code: true },
        },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.payout.count({ where }),
  ]);

  return { payouts, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// POST /host/payouts/request — Request payout
// ─────────────────────────────────────────────
export async function requestPayout(hostId: string, dto: PayoutRequestDto) {
  await releaseMaturedHostEarnings(hostId);

  // Verify bank account ownership, verification, and Razorpay X registration
  const bankAccount = await prisma.bankAccount.findFirst({
    where:  { id: dto.bank_account_id, host_id: hostId },
    select: {
      id:                       true,
      is_verified:              true,
      bank_name:                true,
      account_holder_name:      true,
      razorpay_fund_account_id: true,
    },
  });
  if (!bankAccount) throw AppError.notFound('Bank account');
  if (!bankAccount.is_verified) {
    throw AppError.conflict(
      ErrorCode.VALIDATION_ERROR,
      'Bank account is not verified. Please contact support to verify your bank account.'
    );
  }

  // When Razorpay X is configured, the fund account ID is mandatory for
  // automated payout processing. If missing, the bank account registration
  // with Razorpay X likely failed — admin can re-trigger via the verify endpoint.
  if (isRazorpayXConfigured() && !bankAccount.razorpay_fund_account_id) {
    throw AppError.conflict(
      ErrorCode.VALIDATION_ERROR,
      'Bank account has not been registered with the payout processor yet. ' +
      'Please contact support or ask an admin to re-verify the bank account.'
    );
  }

  // Prevent concurrent payouts. Two in-flight payouts for the same host would
  // cause completePayout/failPayout to cross-contaminate each other's earnings.
  const inFlight = await prisma.payout.findFirst({
    where:  { host_id: hostId, status: { in: ['requested', 'processing'] } },
    select: { id: true, status: true, amount: true },
  });
  if (inFlight) {
    throw AppError.conflict(
      ErrorCode.VALIDATION_ERROR,
      `A payout of ₹${Number(inFlight.amount).toFixed(2)} is already ${inFlight.status}. ` +
      `Wait for it to settle before requesting another.`
    );
  }

  const { availableForPayout } = await getPayoutAvailabilitySummary(hostId);
  if (availableForPayout <= 0) {
    throw AppError.conflict(ErrorCode.VALIDATION_ERROR, 'No available earnings to payout');
  }

  const payoutAmount = dto.amount ? round2(dto.amount) : availableForPayout;

  if (payoutAmount > availableForPayout) {
    throw AppError.conflict(
      ErrorCode.INSUFFICIENT_WALLET_BALANCE,
      `Requested payout (₹${payoutAmount}) exceeds available earnings (₹${availableForPayout})`
    );
  }
  if (payoutAmount < 100) {
    throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Minimum payout amount is ₹100');
  }

  // Generate idempotency key — stored on payout row and sent as header to
  // Razorpay X so repeated cron runs never create duplicate bank transfers.
  const idempotencyKey = crypto.randomUUID();

  // Record the payout request against the aggregate withdrawable balance so
  // hosts can request any valid amount without matching individual earnings rows.
  const payout = await prisma.payout.create({
    data: {
      host_id:          hostId,
      amount:           payoutAmount,
      bank_account_id:  dto.bank_account_id,
      status:           'requested',
      idempotency_key:  idempotencyKey,
    },
    select: {
      id:         true,
      amount:     true,
      status:     true,
      created_at: true,
      bank_account: { select: { bank_name: true, account_holder_name: true } },
    },
  });

  return {
    payout_id:  payout.id,
    amount:     payoutAmount,
    status:     payout.status,
    bank:       payout.bank_account,
    message:    'Payout request submitted. Processing within 2–3 business days.',
    created_at: payout.created_at,
  };
}

// ═════════════════════════════════════════════
// BANK ACCOUNTS
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /host/bank-accounts
// ─────────────────────────────────────────────
export async function listBankAccounts(hostId: string) {
  const accounts = await prisma.bankAccount.findMany({
    where:   { host_id: hostId },
    select: {
      id:                       true,
      account_holder_name:      true,
      account_number_encrypted: true,
      ifsc_code:                true,
      bank_name:                true,
      is_default:               true,
      is_verified:              true,
      verification_status:      true,
      verification_error:       true,
      created_at:               true,
    },
    orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
  });

  return accounts.map(({ account_number_encrypted, ...rest }) => ({
    ...rest,
    account_number_masked: '****' + decrypt(account_number_encrypted).slice(-4),
  }));
}

// ─────────────────────────────────────────────
// POST /host/bank-accounts
// ─────────────────────────────────────────────
export async function addBankAccount(hostId: string, dto: AddBankAccountDto) {
  // 1. Persist in DB first (always succeeds regardless of Razorpay X status)
  const created = await prisma.$transaction(async (tx) => {
    if (dto.is_default) {
      await tx.bankAccount.updateMany({
        where: { host_id: hostId, is_default: true },
        data:  { is_default: false },
      });
    }

    return tx.bankAccount.create({
      data: {
        host_id:                  hostId,
        account_holder_name:      dto.account_holder_name,
        account_number_encrypted: encrypt(dto.account_number),
        ifsc_code:                dto.ifsc_code,
        bank_name:                dto.bank_name,
        is_default:               dto.is_default,
      },
      select: {
        id:                  true,
        account_holder_name: true,
        ifsc_code:           true,
        bank_name:           true,
        is_default:          true,
        is_verified:         true,
        verification_status: true,
        verification_error:  true,
        created_at:          true,
      },
    });
  });

  // 2. Register with Razorpay X (non-fatal — bank account is still usable
  //    for manual payouts even if this step fails; admin can retry via the
  //    bank-account verify endpoint which re-triggers this registration).
  if (isRazorpayXConfigured()) {
    setImmediate(async () => {
      let razorpayContactId: string | undefined;
      try {
        // Fetch host details for the contact
        const host = await prisma.user.findUnique({
          where:  { id: hostId },
          select: { first_name: true, last_name: true, email: true, phone: true },
        });

        const contactName = host
          ? `${host.first_name} ${host.last_name}`
          : dto.account_holder_name;

        // Create Razorpay X Contact (represents the payee/vendor)
        const contact = await createContact({
          hostId,
          name:  contactName,
          email: host?.email,
          phone: host?.phone ?? undefined,
        });
        razorpayContactId = contact.id;

        // Create Razorpay X Fund Account (links bank details to the contact)
        const fundAccount = await createFundAccount({
          contactId:         contact.id,
          accountHolderName: dto.account_holder_name,
          accountNumber:     dto.account_number, // plain text — NOT stored; encrypted copy is in DB
          ifscCode:          dto.ifsc_code,
        });

        // Persist both IDs and mark verified — only reached if both Razorpay X
        // calls above succeed, so is_verified = true has no false positives.
        await prisma.bankAccount.update({
          where: { id: created.id },
          data: {
            razorpay_contact_id:      contact.id,
            razorpay_fund_account_id: fundAccount.id,
            is_verified:              true,
            verification_status:      'verified',
            verification_error:       null,
          },
        });

        logger.info({
          msg:                     'bank-account:razorpay-x-registered',
          bankAccountId:           created.id,
          razorpayContactId:       contact.id,
          razorpayFundAccountId:   fundAccount.id,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await prisma.bankAccount.update({
          where: { id: created.id },
          data: {
            verification_status: 'failed',
            verification_error:  errorMessage,
            ...(razorpayContactId && { razorpay_contact_id: razorpayContactId }),
          },
        }).catch(() => {});

        // Non-fatal: admin can trigger re-registration via verify endpoint
        logger.error({
          msg:           'bank-account:razorpay-x-registration-failed',
          bankAccountId: created.id,
          err,
        });
      }
    });
  }

  return created;
}

// ─────────────────────────────────────────────
// POST /host/bank-accounts/:id/retry
// ─────────────────────────────────────────────
export async function retryBankAccountVerification(hostId: string, bankAccountId: string) {
  const account = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, host_id: hostId },
  });
  if (!account) throw AppError.notFound('Bank account');

  if (account.is_verified) {
    throw AppError.conflict(
      ErrorCode.ALREADY_EXISTS,
      'Bank account is already verified'
    );
  }

  // Reset status to pending
  const updated = await prisma.bankAccount.update({
    where: { id: bankAccountId },
    data: {
      verification_status: 'pending',
      verification_error: null,
    },
    select: {
      id:                  true,
      account_holder_name: true,
      ifsc_code:           true,
      bank_name:           true,
      is_default:          true,
      is_verified:         true,
      verification_status: true,
      verification_error:  true,
      created_at:          true,
    },
  });

  if (isRazorpayXConfigured()) {
    setImmediate(async () => {
      let razorpayContactId = account.razorpay_contact_id;
      try {
        if (!razorpayContactId) {
          const host = await prisma.user.findUnique({
            where:  { id: hostId },
            select: { first_name: true, last_name: true, email: true, phone: true },
          });

          const contactName = host
            ? `${host.first_name} ${host.last_name}`
            : account.account_holder_name;

          const contact = await createContact({
            hostId,
            name:  contactName,
            email: host?.email,
            phone: host?.phone ?? undefined,
          });
          razorpayContactId = contact.id;
        }

        const fundAccount = await createFundAccount({
          contactId:         razorpayContactId,
          accountHolderName: account.account_holder_name,
          accountNumber:     decrypt(account.account_number_encrypted),
          ifscCode:          account.ifsc_code,
        });

        await prisma.bankAccount.update({
          where: { id: bankAccountId },
          data: {
            razorpay_contact_id:      razorpayContactId,
            razorpay_fund_account_id: fundAccount.id,
            is_verified:              true,
            verification_status:      'verified',
            verification_error:       null,
          },
        });

        logger.info({
          msg:                     'bank-account:razorpay-x-registered-retry',
          bankAccountId:           bankAccountId,
          razorpayContactId:       razorpayContactId,
          razorpayFundAccountId:   fundAccount.id,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await prisma.bankAccount.update({
          where: { id: bankAccountId },
          data: {
            verification_status: 'failed',
            verification_error:  errorMessage,
            ...(razorpayContactId && { razorpay_contact_id: razorpayContactId }),
          },
        }).catch(() => {});

        logger.error({
          msg:           'bank-account:razorpay-x-registration-failed-retry',
          bankAccountId: bankAccountId,
          err,
        });
      }
    });
  }

  return updated;
}

// ─────────────────────────────────────────────
// PATCH /host/bank-accounts/:id
// ─────────────────────────────────────────────
export async function updateBankAccount(hostId: string, bankAccountId: string, dto: UpdateBankAccountDto) {
  const account = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, host_id: hostId },
  });
  if (!account) throw AppError.notFound('Bank account');

  return prisma.$transaction(async (tx) => {
    if (dto.is_default) {
      await tx.bankAccount.updateMany({
        where: { host_id: hostId, is_default: true },
        data:  { is_default: false },
      });
    }

    return tx.bankAccount.update({
      where: { id: bankAccountId },
      data: {
        ...(dto.account_holder_name !== undefined ? { account_holder_name: dto.account_holder_name } : {}),
        ...(dto.bank_name           !== undefined ? { bank_name: dto.bank_name } : {}),
        ...(dto.is_default          !== undefined ? { is_default: dto.is_default } : {}),
      },
      select: {
        id:                  true,
        account_holder_name: true,
        ifsc_code:           true,
        bank_name:           true,
        is_default:          true,
        is_verified:         true,
        created_at:          true,
      },
    });
  });
}

// ─────────────────────────────────────────────
// DELETE /host/bank-accounts/:id
// ─────────────────────────────────────────────
export async function deleteBankAccount(hostId: string, bankAccountId: string): Promise<void> {
  const account = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, host_id: hostId },
  });
  if (!account) throw AppError.notFound('Bank account');

  // Block if pending payouts reference this account
  const pendingPayouts = await prisma.payout.count({
    where: { bank_account_id: bankAccountId, status: { in: ['requested', 'processing'] } },
  });
  if (pendingPayouts > 0) {
    throw AppError.conflict(
      ErrorCode.VALIDATION_ERROR,
      'Cannot delete a bank account with pending payouts. Wait for payouts to complete or be marked as failed.'
    );
  }

  await prisma.bankAccount.delete({ where: { id: bankAccountId } });
}

// ═════════════════════════════════════════════
// HOST ANALYTICS
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /host/analytics
// ─────────────────────────────────────────────
export async function getHostAnalytics(hostId: string) {
  const now = new Date();
  const thirtyDaysAgo  = new Date(now.getTime() - 30 * 24 * 3_600_000);
  const ninetyDaysAgo  = new Date(now.getTime() - 90 * 24 * 3_600_000);
  const oneYearAgo     = new Date(now.getFullYear() - 1, now.getMonth(), 1);

  // All active spaces for this host
  const spaces = await prisma.parkingSpace.findMany({
    where:  { host_id: hostId, status: 'active' },
    select: { id: true, name: true, total_capacity: true },
  });
  const spaceIds = spaces.map((s) => s.id);

  if (spaceIds.length === 0) {
    return {
      booking_count_30d:     0,
      occupancy_rate:        0,
      total_revenue:         0,
      average_rating:        null,
      review_count:          0,
      top_performing_spaces: [],
      monthly_revenue:       [],
    };
  }

  // Parallel aggregation queries
  const [
    recentBookingCount,
    ratingResult,
    totalRevenueResult,
    completedBookings,
    monthlyRows,
    topSpacesRaw,
  ] = await Promise.all([
    // Bookings in last 30 days
    prisma.booking.count({
      where: {
        space_id:   { in: spaceIds },
        status:     { in: ['completed', 'active', 'confirmed'] },
        created_at: { gte: thirtyDaysAgo },
      },
    }),

    // Average rating across all spaces
    prisma.review.aggregate({
      where: { space_id: { in: spaceIds }, status: 'active' },
      _avg:  { rating: true },
      _count: { id: true },
    }),

    // Total net revenue (available + paid_out)
    prisma.hostEarning.aggregate({
      where: { host_id: hostId, status: { in: ['available', 'paid_out'] } },
      _sum:  { net_amount: true },
    }),

    // Completed bookings last 30 days for occupancy calculation
    prisma.booking.findMany({
      where: {
        space_id:   { in: spaceIds },
        status:     'completed',
        created_at: { gte: thirtyDaysAgo },
      },
      select: { start_time: true, end_time: true },
    }),

    // Monthly revenue last 12 months
    prisma.$queryRaw<Array<{ month: string; revenue: number; bookings: number }>>`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
        COALESCE(SUM(net_amount), 0)::float AS revenue,
        COUNT(*)::int                       AS bookings
      FROM host_earnings
      WHERE host_id     = ${hostId}::uuid
        AND created_at >= ${oneYearAgo}
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at)
    `,

    // Top 5 spaces by net earnings last 90 days
    prisma.$queryRaw<Array<{ space_id: string; revenue: number; booking_count: number }>>`
      SELECT
        b.space_id,
        COALESCE(SUM(he.net_amount), 0)::float AS revenue,
        COUNT(he.id)::int                      AS booking_count
      FROM host_earnings he
      JOIN bookings b ON he.booking_id = b.id
      WHERE he.host_id     = ${hostId}::uuid
        AND he.created_at >= ${ninetyDaysAgo}
      GROUP BY b.space_id
      ORDER BY revenue DESC
      LIMIT 5
    `,
  ]);

  // Occupancy rate: booked hours / available hours in last 30 days
  const bookedHours = completedBookings.reduce((sum, b) => {
    return sum + (b.end_time.getTime() - b.start_time.getTime()) / 3_600_000;
  }, 0);
  const totalCapacity  = spaces.reduce((sum, s) => sum + s.total_capacity, 0);
  const availableHours = 30 * 24 * Math.max(totalCapacity, 1);
  const occupancyRate  = round2(Math.min(100, (bookedHours / availableHours) * 100));

  // Map space ID → name for top spaces
  const spaceMap = new Map(spaces.map((s) => [s.id, s.name]));

  return {
    booking_count_30d: recentBookingCount,
    occupancy_rate:    occupancyRate,
    total_revenue:     round2(Number(totalRevenueResult._sum.net_amount ?? 0)),
    average_rating:    ratingResult._avg.rating ? round2(ratingResult._avg.rating) : null,
    review_count:      ratingResult._count.id,
    top_performing_spaces: topSpacesRaw.map((r) => ({
      space_id:      r.space_id,
      space_name:    spaceMap.get(r.space_id) ?? 'Unknown',
      revenue:       round2(r.revenue),
      booking_count: r.booking_count,
    })),
    monthly_revenue: monthlyRows.map((r) => ({
      month:    r.month,
      revenue:  round2(r.revenue),
      bookings: r.bookings,
    })),
  };
}

// ═════════════════════════════════════════════
// SLOT MANAGEMENT
// ═════════════════════════════════════════════

/** Verify the space belongs to this host and return its id. */
async function assertSpaceOwnership(hostId: string, spaceId: string): Promise<void> {
  const space = await prisma.parkingSpace.findFirst({
    where: { id: spaceId, host_id: hostId },
    select: { id: true },
  });
  if (!space) throw AppError.notFound('Space');
}

// ─────────────────────────────────────────────
// GET /host/spaces/:id/slots
// ─────────────────────────────────────────────
export async function listSlots(hostId: string, spaceId: string) {
  await assertSpaceOwnership(hostId, spaceId);
  return prisma.parkingSlot.findMany({
    where:   { space_id: spaceId },
    orderBy: [{ is_active: 'desc' }, { slot_number: 'asc' }],
    select:  { id: true, slot_number: true, is_active: true, notes: true, created_at: true },
  });
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/slots
// ─────────────────────────────────────────────
export async function createSlot(hostId: string, spaceId: string, dto: CreateSlotDto) {
  await assertSpaceOwnership(hostId, spaceId);

  // Enforce: active slots must not exceed total_capacity
  const space = await prisma.parkingSpace.findUnique({
    where:  { id: spaceId },
    select: { total_capacity: true },
  });
  if (!space) throw AppError.notFound('Space');

  const activeCount = await prisma.parkingSlot.count({
    where: { space_id: spaceId, is_active: true },
  });
  if (activeCount >= space.total_capacity) {
    throw AppError.badRequest(
      ErrorCode.VALIDATION_ERROR,
      `Cannot exceed the space's total capacity of ${space.total_capacity} active slots. Update total_capacity first if you need more slots.`
    );
  }

  try {
    return await prisma.parkingSlot.create({
      data: {
        space_id:    spaceId,
        slot_number: dto.slot_number,
        notes:       dto.notes,
      },
      select: { id: true, slot_number: true, is_active: true, notes: true, created_at: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict(ErrorCode.ALREADY_EXISTS, `Slot '${dto.slot_number}' already exists for this space`);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// PATCH /host/spaces/:id/slots/:slotId
// ─────────────────────────────────────────────
export async function updateSlot(hostId: string, spaceId: string, slotId: string, dto: UpdateSlotDto) {
  await assertSpaceOwnership(hostId, spaceId);

  const slot = await prisma.parkingSlot.findFirst({
    where: { id: slotId, space_id: spaceId },
    select: { id: true },
  });
  if (!slot) throw AppError.notFound('Slot');

  // If re-activating, check capacity
  if (dto.is_active === true) {
    const space = await prisma.parkingSpace.findUnique({
      where:  { id: spaceId },
      select: { total_capacity: true },
    });
    if (space) {
      const activeCount = await prisma.parkingSlot.count({
        where: { space_id: spaceId, is_active: true, id: { not: slotId } },
      });
      if (activeCount >= space.total_capacity) {
        throw AppError.badRequest(
          ErrorCode.VALIDATION_ERROR,
          `Reactivating this slot would exceed total_capacity (${space.total_capacity}). Increase capacity or deactivate another slot first.`
        );
      }
    }
  }

  try {
    return await prisma.parkingSlot.update({
      where:  { id: slotId },
      data:   { slot_number: dto.slot_number, is_active: dto.is_active, notes: dto.notes },
      select: { id: true, slot_number: true, is_active: true, notes: true, updated_at: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict(ErrorCode.ALREADY_EXISTS, `Slot number '${dto.slot_number}' already exists for this space`);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// DELETE /host/spaces/:id/slots/:slotId
// Blocked if the slot has upcoming confirmed/active bookings.
// ─────────────────────────────────────────────
export async function deleteSlot(hostId: string, spaceId: string, slotId: string) {
  await assertSpaceOwnership(hostId, spaceId);

  const slot = await prisma.parkingSlot.findFirst({
    where: { id: slotId, space_id: spaceId },
    select: { id: true },
  });
  if (!slot) throw AppError.notFound('Slot');

  // Block if there are upcoming/active bookings on this slot
  const activeBookings = await prisma.booking.count({
    where: {
      slot_id:    slotId,
      status:     { in: ['pending', 'confirmed', 'active'] },
      end_time:   { gt: new Date() },
    },
  });
  if (activeBookings > 0) {
    throw AppError.conflict(
      ErrorCode.SPACE_HAS_ACTIVE_BOOKINGS,
      `Cannot delete slot: it has ${activeBookings} upcoming or active booking(s). Cancel or complete them first.`
    );
  }

  await prisma.parkingSlot.delete({ where: { id: slotId } });
  return { deleted: true };
}

// ─────────────────────────────────────────────
// Host Invoice PDF generation
// ─────────────────────────────────────────────
export async function generateHostInvoice(hostId: string, bookingId: string): Promise<Buffer> {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, space: { host_id: hostId } },
    select: {
      id: true,
      status: true,
      start_time: true,
      end_time: true,
      base_price: true,
      platform_fee: true,
      tax_amount: true,
      discount_amount: true,
      total_price: true,
      created_at: true,
      space: { select: { name: true, address_line1: true, city: true, state: true } },
      user: { select: { first_name: true, last_name: true } },
      transactions: {
        where: { status: 'completed' },
        select: { payment_method: true, gateway: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 1,
      },
    },
  });

  if (!booking) throw AppError.notFound('Booking');

  if (booking.status !== 'completed') {
    throw AppError.forbidden('Invoice is only available for completed bookings');
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fmt = (n: any) => `\u20B9${Number(n || 0).toFixed(2)}`;

    // Header
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#1d4ed8').text('JustPark', 50, 50);
    doc.fontSize(11).font('Helvetica').fillColor('#64748b').text('Earnings Invoice', 50, 78);
    doc.moveTo(50, 100).lineTo(545, 100).strokeColor('#e2e8f0').lineWidth(1).stroke();

    let y = 115;
    const row = (label: string, value: string, xL = 50, xV = 155) => {
      doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(label, xL, y);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text(value || '—', xV, y);
      y += 18;
    };
    const section = (title: string) => {
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#f1f5f9').lineWidth(1).stroke();
      y += 12;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text(title, 50, y);
      y += 18;
    };

    // Booking info
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('BOOKING DETAILS', 50, y); y += 18;
    row('Booking ID', `#${booking.id}`);
    row('Issue Date', new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }));
    row('Location', booking.space?.name || '—');

    const hours = Math.max(1, Math.round((new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) / 3_600_000));
    row('Duration', `${hours} hour${hours !== 1 ? 's' : ''}`);

    section('DRIVER');
    row('Name', `${booking.user?.first_name || ''} ${booking.user?.last_name || ''}`.trim() || '—');

    section('EARNINGS BREAKDOWN');
    const priceRow = (label: string, value: string, color = '#0f172a', isBold = false) => {
      doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#64748b').text(label, 50, y);
      doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color).text(value, 50, y, { align: 'right', width: 495 });
      y += 16;
    };

    const grossEarnings = Number(booking.base_price);
    const platformFee = 0; // Host receives 100% — platform fee is charged to user separately
    const netEarnings = grossEarnings;

    priceRow('Gross Amount', fmt(grossEarnings));
    priceRow('Platform Fee', `-${fmt(platformFee)}`, '#ef4444');

    y += 4;
    doc.rect(50, y, 495, 28).fillColor('#f0fdf4').fill();
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#15803d').text('Net Earnings', 60, y + 8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#15803d').text(fmt(netEarnings), 50, y + 8, { align: 'right', width: 488 });
    y += 40;

    doc.moveTo(50, y).lineTo(545, y).strokeColor('#e2e8f0').lineWidth(1).stroke();
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#0f172a')
      .text('Thank you for hosting with JustPark', 50, y + 15, { align: 'center', width: 495 });

    doc.end();
  });
}
