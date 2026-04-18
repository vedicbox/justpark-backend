import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { buildPaginationMeta } from '../../utils/pagination';
import { ErrorCode } from '../../types';
import { notifySpaceApproved, notifySpaceRejected, notifyKycApproved, notifyKycRejected, sendNotification } from '../../services/notification';
import { creditWallet } from '../../services/wallet';
import { logger } from '../../utils/logger';
import type {
  AdminListSpacesQuery,
  RejectSpaceDto,
  AdminListPayoutsQuery,
  ProcessPayoutDto,
  AdminListUsersQuery,
  AdminUpdateUserStatusDto,
  AdminUpdateUserRoleDto,
  AdminListKycQuery,
  KycRejectDto,
  AdminListBookingsQuery,
  AdminListTransactionsQuery,
  UpdatePlatformConfigDto,
  AdminListPromoCodesQuery,
  CreatePromoCodeDto,
  UpdatePromoCodeDto,
  BroadcastNotificationDto,
  AuditLogQuery,
  AdminListBankAccountsQuery,
} from './validators';

// ─────────────────────────────────────────────
// Select (excludes Unsupported location field)
// ─────────────────────────────────────────────
const SPACE_ADMIN_SELECT = {
  id: true,
  host_id: true,
  name: true,
  address_line1: true,
  city: true,
  state: true,
  country: true,
  geohash: true,
  space_type: true,
  total_capacity: true,
  status: true,
  cancellation_policy: true,
  instant_book: true,
  created_at: true,
  updated_at: true,
  host: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
    },
  },
  _count: {
    select: { photos: true, bookings: true },
  },
} as const;

// ─────────────────────────────────────────────
// GET /admin/spaces — List all spaces
// ─────────────────────────────────────────────
export async function listAllSpaces(query: AdminListSpacesQuery) {
  const { search, status, city, host_id, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.ParkingSpaceWhereInput = {
    ...(status ? { status } : {}),
    ...(city ? { city: { contains: city, mode: 'insensitive' as const } } : {}),
    ...(host_id ? { host_id } : {}),
  };

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { city: { contains: search, mode: 'insensitive' } },
      { host: { first_name: { contains: search, mode: 'insensitive' } } },
    ];
  }

  const [spaces, total] = await Promise.all([
    prisma.parkingSpace.findMany({
      where,
      select: SPACE_ADMIN_SELECT,
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.parkingSpace.count({ where }),
  ]);

  return { spaces, total, page, limit };
}

// ─────────────────────────────────────────────
// GET /admin/spaces/:id — Admin space detail (any status)
// ─────────────────────────────────────────────
export async function getSpaceById(spaceId: string) {
  const space = await prisma.parkingSpace.findUnique({
    where: { id: spaceId },
    select: {
      id: true,
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
      cancellation_policy: true,
      min_booking_duration_minutes: true,
      max_booking_duration_minutes: true,
      buffer_minutes: true,
      instant_book: true,
      status: true,
      host_id: true,
      created_at: true,
      photos:        { orderBy: { display_order: 'asc' } },
      amenities:     true,
      schedules:     { orderBy: { day_of_week: 'asc' } },
      pricing_rules: true,
      host: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          avatar_url: true,
          phone: true,
        },
      },
    },
  });
  if (!space) throw AppError.notFound('Space');
  return space;
}

// ─────────────────────────────────────────────
// PATCH /admin/spaces/:id/approve — Approve listing
// ─────────────────────────────────────────────
export async function approveSpace(spaceId: string, adminId: string) {
  const space = await prisma.parkingSpace.findUnique({
    where: { id: spaceId },
    select: { id: true, status: true, name: true, host_id: true },
  });
  if (!space) throw AppError.notFound('Space');

  if (space.status !== 'pending_review') {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      `Only spaces in 'pending_review' can be approved. Current status: '${space.status}'.`
    );
  }

  const [updated] = await Promise.all([
    prisma.parkingSpace.update({
      where: { id: spaceId },
      data: { status: 'active' },
      select: { id: true, status: true, name: true, host_id: true, updated_at: true },
    }),
    // Audit log
    prisma.auditLog.create({
      data: {
        actor_id: adminId,
        action: 'space.approved',
        entity_type: 'parking_space',
        entity_id: spaceId,
        metadata: { space_name: space.name, host_id: space.host_id },
      },
    }),
  ]);

  notifySpaceApproved(space.host_id, spaceId, space.name).catch(() => {});

  return updated;
}

// ─────────────────────────────────────────────
// PATCH /admin/spaces/:id/reject — Reject listing with reason
// ─────────────────────────────────────────────
export async function rejectSpace(spaceId: string, adminId: string, dto: RejectSpaceDto) {
  const space = await prisma.parkingSpace.findUnique({
    where: { id: spaceId },
    select: { id: true, status: true, name: true, host_id: true },
  });
  if (!space) throw AppError.notFound('Space');

  if (space.status !== 'pending_review') {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      `Only spaces in 'pending_review' can be rejected. Current status: '${space.status}'.`
    );
  }

  const [updated] = await Promise.all([
    prisma.parkingSpace.update({
      where: { id: spaceId },
      data: { status: 'rejected' },
      select: { id: true, status: true, name: true, host_id: true, updated_at: true },
    }),
    // Audit log preserves the rejection reason
    prisma.auditLog.create({
      data: {
        actor_id: adminId,
        action: 'space.rejected',
        entity_type: 'parking_space',
        entity_id: spaceId,
        metadata: { reason: dto.reason, space_name: space.name, host_id: space.host_id },
      },
    }),
  ]);

  notifySpaceRejected(space.host_id, spaceId, space.name, dto.reason).catch(() => {});

  return { ...updated, rejection_reason: dto.reason };
}

// ─────────────────────────────────────────────
// GET /admin/payouts — List all payouts
// ─────────────────────────────────────────────
export async function listAllPayouts(query: AdminListPayoutsQuery) {
  const { status, host_id, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.PayoutWhereInput = {};
  if (status)  where.status  = status;
  if (host_id) where.host_id = host_id;

  const [payouts, total] = await Promise.all([
    prisma.payout.findMany({
      where,
      select: {
        id:           true,
        amount:       true,
        status:       true,
        processed_at: true,
        created_at:   true,
        host: {
          select: { id: true, first_name: true, last_name: true, email: true },
        },
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
// POST /admin/payouts/:id/process
// ─────────────────────────────────────────────
export async function processPayout(payoutId: string, adminId: string, dto: ProcessPayoutDto) {
  const payout = await prisma.payout.findUnique({
    where:  { id: payoutId },
    select: { id: true, status: true, host_id: true, amount: true },
  });
  if (!payout) throw AppError.notFound('Payout');

  if (payout.status === 'completed' || payout.status === 'failed') {
    throw AppError.conflict(
      ErrorCode.VALIDATION_ERROR,
      `Payout is already ${payout.status} and cannot be updated`
    );
  }

  if (dto.status === 'processing') {
    await prisma.payout.update({
      where: { id: payoutId },
      data:  { status: 'processing' },
    });
  } else if (dto.status === 'completed') {
    const { completePayout } = await import('../../jobs/processors/payoutProcessor');
    await completePayout(payout.id, payout.host_id, Number(payout.amount), null, null);
  } else {
    const { failPayout } = await import('../../jobs/processors/payoutProcessor');
    await failPayout(
      payout.id,
      payout.host_id,
      Number(payout.amount),
      dto.note?.trim() || 'Marked failed by admin'
    );
  }

  const updated = await prisma.payout.findUnique({
    where:  { id: payoutId },
    select: { id: true, status: true, amount: true, processed_at: true },
  });
  if (!updated) throw AppError.notFound('Payout');

  // Audit log
  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      `payout.${dto.status}`,
      entity_type: 'payout',
      entity_id:   payoutId,
      metadata:    { amount: Number(payout.amount), note: dto.note },
    },
  }).catch((e) => logger.error(e, 'AUDIT_LOG_WRITE_FAILED'));

  return updated;
}

// ═════════════════════════════════════════════
// USER MANAGEMENT
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /admin/users
// ─────────────────────────────────────────────
export async function listAllUsers(query: AdminListUsersQuery) {
  const { search, role, status, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.UserWhereInput = {};
  if (role)   where.role   = role;
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { email:      { contains: search, mode: 'insensitive' } },
      { phone:      { contains: search } },
      { first_name: { contains: search, mode: 'insensitive' } },
      { last_name:  { contains: search, mode: 'insensitive' } },
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id:             true,
        first_name:     true,
        last_name:      true,
        email:          true,
        phone:          true,
        role:           true,
        status:         true,
        email_verified: true,
        phone_verified: true,
        avatar_url:     true,
        created_at:     true,
        _count: { select: { bookings: true, parking_spaces: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  return { users, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// GET /admin/users/:id
// ─────────────────────────────────────────────
export async function getUserDetail(userId: string) {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: {
      id:             true,
      first_name:     true,
      last_name:      true,
      email:          true,
      phone:          true,
      role:           true,
      status:         true,
      email_verified: true,
      phone_verified: true,
      avatar_url:     true,
      created_at:     true,
      updated_at:     true,
      kyc_documents: {
        select: { id: true, document_type: true, status: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 5,
      },
      _count: {
        select: {
          bookings:       true,
          parking_spaces: true,
          reviews_given:  true,
        },
      },
    },
  });

  if (!user) throw AppError.notFound('User');

  // Wallet balance
  const wallet = await prisma.wallet.findUnique({
    where:  { user_id: userId },
    select: { balance: true, currency: true },
  });

  // Recent bookings summary
  const recentBookings = await prisma.booking.findMany({
    where:   { user_id: userId },
    select:  { id: true, status: true, total_price: true, created_at: true },
    orderBy: { created_at: 'desc' },
    take:    5,
  });

  return {
    ...user,
    wallet: wallet ?? { balance: 0, currency: 'INR' },
    recent_bookings: recentBookings,
  };
}

// ─────────────────────────────────────────────
// PATCH /admin/users/:id/status
// ─────────────────────────────────────────────
export async function updateUserStatus(targetUserId: string, adminId: string, dto: AdminUpdateUserStatusDto) {
  const user = await prisma.user.findUnique({
    where:  { id: targetUserId },
    select: { id: true, status: true, first_name: true, last_name: true, email: true },
  });
  if (!user) throw AppError.notFound('User');

  if (user.status === dto.status) {
    throw AppError.conflict(ErrorCode.ALREADY_EXISTS, `User is already ${dto.status}`);
  }

  // If suspending/deactivating: cancel all active bookings with full wallet refund
  if (['suspended', 'deactivated'].includes(dto.status)) {
    const activeBookings = await prisma.booking.findMany({
      where:  { user_id: targetUserId, status: { in: ['pending', 'confirmed', 'active'] } },
      select: {
        id:          true,
        total_price: true,
        space:       { select: { name: true } },
        transactions: {
          where:  { status: { in: ['completed', 'partially_refunded'] } },
          select: { id: true, amount: true },
          take:   1,
        },
      },
    });

    for (const booking of activeBookings) {
      await prisma.booking.update({
        where: { id: booking.id },
        data:  {
          status:              'cancelled',
          cancelled_by:        'admin',
          cancellation_reason: `Account ${dto.status}: ${dto.reason ?? 'Admin action'}`,
          refund_amount:       booking.total_price,
        },
      });

      await prisma.hostEarning.updateMany({
        where: { booking_id: booking.id, status: { in: ['pending', 'available'] } },
        data:  { status: 'on_hold' },
      });

      // Full wallet refund
      const txAmount = booking.transactions[0] ? Number(booking.transactions[0].amount) : Number(booking.total_price);
      if (txAmount > 0) {
        await creditWallet({
          userId:        targetUserId,
          amount:        txAmount,
          type:          'refund',
          referenceType: 'booking',
          referenceId:   booking.id,
          description:   `Full refund — account ${dto.status}`,
        }).catch(() => {});
      }
    }
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data:  { status: dto.status },
    select: { id: true, status: true, email: true, updated_at: true },
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      `user.status.${dto.status}`,
      entity_type: 'user',
      entity_id:   targetUserId,
      metadata:    { reason: dto.reason, previous_status: user.status } as any,
    },
  });

  return updated;
}

export async function updateUserRole(targetUserId: string, adminId: string, dto: AdminUpdateUserRoleDto) {
  if (targetUserId === adminId) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Admins cannot change their own role');
  }

  const user = await prisma.user.findUnique({
    where:  { id: targetUserId },
    select: { id: true, role: true, email: true },
  });
  if (!user) throw AppError.notFound('User');

  if (user.role === dto.role) {
    throw AppError.conflict(ErrorCode.ALREADY_EXISTS, `User already has role '${dto.role}'`);
  }

  const updated = await prisma.user.update({
    where:  { id: targetUserId },
    data:   { role: dto.role },
    select: { id: true, role: true, email: true, updated_at: true },
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      `user.role.${dto.role}`,
      entity_type: 'user',
      entity_id:   targetUserId,
      metadata:    { reason: dto.reason, previous_role: user.role } as any,
    },
  }).catch((e) => logger.error(e, 'AUDIT_LOG_WRITE_FAILED'));

  return updated;
}

// ═════════════════════════════════════════════
// KYC MANAGEMENT
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /admin/kyc/pending
// ─────────────────────────────────────────────
export async function listPendingKyc(query: AdminListKycQuery) {
  const { page, limit } = query;
  const skip = (page - 1) * limit;

  const [docs, total] = await Promise.all([
    prisma.kycDocument.findMany({
      where:   { status: 'pending' },
      select: {
        id:            true,
        document_type: true,
        document_url:  true,
        status:        true,
        admin_notes:   true,
        created_at:    true,
        user: { select: { id: true, first_name: true, last_name: true, email: true } },
      },
      orderBy: { created_at: 'asc' },
      skip,
      take: limit,
    }),
    prisma.kycDocument.count({ where: { status: 'pending' } }),
  ]);

  return { docs, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// PATCH /admin/kyc/:id/approve
// ─────────────────────────────────────────────
export async function approveKyc(kycId: string, adminId: string) {
  const doc = await prisma.kycDocument.findUnique({
    where:  { id: kycId },
    select: { id: true, status: true, user_id: true },
  });
  if (!doc) throw AppError.notFound('KYC document');

  if (doc.status !== 'pending') {
    throw AppError.conflict(ErrorCode.ALREADY_EXISTS, `KYC document is already ${doc.status}`);
  }

  const updated = await prisma.kycDocument.update({
    where: { id: kycId },
    data: {
      status:      'approved',
      reviewed_by: adminId,
      reviewed_at: new Date(),
    },
    select: { id: true, status: true, document_type: true, user_id: true },
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      'kyc.approved',
      entity_type: 'kyc_document',
      entity_id:   kycId,
      metadata:    { user_id: doc.user_id } as any,
    },
  });

  notifyKycApproved(doc.user_id).catch(() => {});

  return updated;
}

// ─────────────────────────────────────────────
// PATCH /admin/kyc/:id/reject
// ─────────────────────────────────────────────
export async function rejectKyc(kycId: string, adminId: string, dto: KycRejectDto) {
  const doc = await prisma.kycDocument.findUnique({
    where:  { id: kycId },
    select: { id: true, status: true, user_id: true },
  });
  if (!doc) throw AppError.notFound('KYC document');

  if (doc.status !== 'pending') {
    throw AppError.conflict(ErrorCode.ALREADY_EXISTS, `KYC document is already ${doc.status}`);
  }

  const updated = await prisma.kycDocument.update({
    where: { id: kycId },
    data: {
      status:      'rejected',
      admin_notes: dto.reason,
      reviewed_by: adminId,
      reviewed_at: new Date(),
    },
    select: { id: true, status: true, document_type: true, admin_notes: true },
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      'kyc.rejected',
      entity_type: 'kyc_document',
      entity_id:   kycId,
      metadata:    { reason: dto.reason, user_id: doc.user_id } as any,
    },
  });

  notifyKycRejected(doc.user_id, dto.reason).catch(() => {});

  return updated;
}

// ═════════════════════════════════════════════
// BOOKING OVERSIGHT
// ═════════════════════════════════════════════

export async function listAllBookings(query: AdminListBookingsQuery) {
  const { search, status, space_id, user_id, from, to, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.BookingWhereInput = {};
  if (status)   where.status   = status;
  if (space_id) where.space_id = space_id;
  if (user_id)  where.user_id  = user_id;
  if (from || to) {
    where.created_at = {
      ...(from && { gte: new Date(from) }),
      ...(to   && { lte: new Date(to)   }),
    };
  }

  if (search) {
    where.OR = [
      { space: { name: { contains: search, mode: 'insensitive' } } },
      { user: { first_name: { contains: search, mode: 'insensitive' } } },
      { user: { email: { contains: search, mode: 'insensitive' } } },
    ];
  }

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      select: {
        id:          true,
        status:      true,
        start_time:  true,
        end_time:    true,
        total_price: true,
        created_at:  true,
        user:  { select: { id: true, first_name: true, last_name: true, email: true } },
        space: { select: { id: true, name: true, city: true } },
        _count: { select: { transactions: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.booking.count({ where }),
  ]);

  return { bookings, meta: buildPaginationMeta(total, page, limit) };
}

export async function adminCancelBooking(bookingId: string, reason?: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { space: true, user: true }
  });
  if (!booking) throw AppError.notFound('Booking');

  if (booking.status === 'completed' || booking.status === 'cancelled') {
    throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Booking is already completed or cancelled');
  }

  const updatedBooking = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: 'cancelled'
    }
  });

  if (booking.status === 'confirmed' || booking.status === 'active') {
    await adminRefundBooking(bookingId, undefined, 'system');
  }

  await prisma.auditLog.create({
    data: {
      action: 'booking.cancelled',
      entity_type: 'booking',
      entity_id: bookingId
    }
  });

  await sendNotification(booking.user_id, 'booking_cancelled', 'Booking Cancelled', `Your booking at ${booking.space.name} was cancelled by an admin.${reason ? ` Reason: ${reason}` : ''}`);
  await sendNotification(booking.space.host_id, 'booking_cancelled', 'Booking Cancelled', `A booking at ${booking.space.name} was cancelled by an admin.`);

  return updatedBooking;
}

export async function adminRefundBooking(bookingId: string, amountOverride?: number, adminId: string = 'system') {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { user: true }
  });
  if (!booking) throw AppError.notFound('Booking');

  const transaction = await prisma.transaction.findFirst({
    where: { booking_id: bookingId, status: 'completed' },
    orderBy: { created_at: 'desc' }
  });
  
  if (!transaction) throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'No completed payment found for this booking.');

  const { initiateRefund } = await import('../../services/refund');
  const result = await initiateRefund({
    transactionId: transaction.id,
    reason: 'Admin Override/Cancellation',
    initiatedBy: adminId === 'system' ? 'system' : adminId,
    amountOverride
  });

  const refundAmount = amountOverride ? amountOverride : Number(booking.total_price);
  const currentRefund = Number(booking.refund_amount ?? 0);
  
  await prisma.booking.update({
    where: { id: bookingId },
    data: { refund_amount: currentRefund + refundAmount }
  });

  await prisma.auditLog.create({
    data: {
      actor_id: adminId === 'system' ? null : adminId,
      action: 'booking.refunded',
      entity_type: 'booking',
      entity_id: bookingId
    }
  });

  await sendNotification(booking.user_id, 'refund_processed', 'Refund Processed', `A refund of ₹${refundAmount} has been processed for your booking.`);

  return result;
}

// ═════════════════════════════════════════════
// TRANSACTION MANAGEMENT
// ═════════════════════════════════════════════

export async function listAllTransactions(query: AdminListTransactionsQuery) {
  const { status, method, from, to, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.TransactionWhereInput = {};
  if (status) where.status         = status;
  if (method) where.payment_method = method;
  if (from || to) {
    where.created_at = {
      ...(from && { gte: new Date(from) }),
      ...(to   && { lte: new Date(to)   }),
    };
  }

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      select: {
        id:              true,
        amount:          true,
        currency:        true,
        payment_method:  true,
        status:          true,
        gateway:         true,
        gateway_ref:     true,
        idempotency_key: true,
        created_at:      true,
        user:    { select: { id: true, first_name: true, last_name: true, email: true } },
        booking: { select: { id: true, status: true } },
        refunds: { select: { id: true, amount: true, status: true, refund_to: true }, take: 3 },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.transaction.count({ where }),
  ]);

  return { transactions, meta: buildPaginationMeta(total, page, limit) };
}

// ═════════════════════════════════════════════
// PLATFORM CONFIG
// ═════════════════════════════════════════════

const DEFAULT_CONFIG: Record<string, unknown> = {
  commission_rate:         0.10,
  tax_rate:                0,
  dispute_window_hours:    48,
  max_slot_lock_minutes:   10,
  min_payout_amount:       100,
  platform_name:           'JustPark',
  support_email:           'support@justpark.in',
  feature_flags: {
    instant_book_enabled:  true,
    wallet_payments:       true,
    promo_codes:           true,
    kyc_required_for_host: true,
  },
};

export async function getPlatformConfig() {
  const rows = await prisma.platformConfig.findMany({
    orderBy: { key: 'asc' },
  });

  // Merge DB rows with defaults (DB wins)
  const config: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const row of rows) {
    // Skip internal keys used by the app (faq_articles, space_rating:*)
    if (!row.key.startsWith('space_rating:') && row.key !== 'faq_articles') {
      config[row.key] = row.value;
    }
  }

  return config;
}

export async function updatePlatformConfig(adminId: string, dto: UpdatePlatformConfigDto) {
  const { updates } = dto;

  // Upsert each key
  await Promise.all(
    Object.entries(updates).map(([key, value]) =>
      prisma.platformConfig.upsert({
        where:  { key },
        create: { key, value: value as any },
        update: { value: value as any },
      })
    )
  );

  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      'config.updated',
      entity_type: 'platform_config',
      entity_id:   null,
      metadata:    { keys: Object.keys(updates) } as any,
    },
  });

  return getPlatformConfig();
}

// ═════════════════════════════════════════════
// ANALYTICS
// ═════════════════════════════════════════════

export async function getAnalytics() {
  const now    = new Date();
  const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week   = new Date(today.getTime() - 7  * 24 * 60 * 60 * 1000);
  const month  = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const day30  = month;

  const [
    totalUsers,
    totalHosts,
    activeListings,
    bookingsToday,
    bookingsWeek,
    bookingsMonth,
    totalBookings,
    revenueResult,
    commissionResult,
    monthRevenueResult,
    bookingDistribution,
    topSpaces,
    signups30d,
    bookings30d,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: 'host' } }),
    prisma.parkingSpace.count({ where: { status: 'active' } }),
    prisma.booking.count({ where: { created_at: { gte: today } } }),
    prisma.booking.count({ where: { created_at: { gte: week  } } }),
    prisma.booking.count({ where: { created_at: { gte: month } } }),
    prisma.booking.count(),
    prisma.transaction.aggregate({
      where:  { status: 'completed' },
      _sum:   { amount: true },
    }),
    prisma.hostEarning.aggregate({
      _sum: { commission_amount: true },
    }),
    prisma.transaction.aggregate({
      where:  { status: 'completed', created_at: { gte: month } },
      _sum:   { amount: true },
    }),
    prisma.booking.groupBy({
      by:     ['status'],
      _count: { id: true },
    }),
    prisma.booking.groupBy({
      by:     ['space_id'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take:   5,
    }),
    // Signups per day for last 30 days — using raw query
    prisma.$queryRaw<{ date: Date; count: bigint }[]>`
      SELECT DATE_TRUNC('day', created_at) AS date, COUNT(*) AS count
      FROM users
      WHERE created_at >= ${day30}
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    prisma.$queryRaw<{ date: Date; count: bigint }[]>`
      SELECT DATE_TRUNC('day', created_at) AS date, COUNT(*) AS count
      FROM bookings
      WHERE created_at >= ${day30}
      GROUP BY 1
      ORDER BY 1 ASC
    `,
  ]);

  // Enrich top spaces with names
  const spaceIds   = topSpaces.map((s) => s.space_id);
  const spaceNames = await prisma.parkingSpace.findMany({
    where:  { id: { in: spaceIds } },
    select: { id: true, name: true, city: true },
  });
  const spaceMap = Object.fromEntries(spaceNames.map((s) => [s.id, s]));

  return {
    users: {
      total:           totalUsers,
      hosts:           totalHosts,
      regular_users:   totalUsers - totalHosts,
      active_listings: activeListings,
    },
    bookings: {
      today:    bookingsToday,
      week:     bookingsWeek,
      month:    bookingsMonth,
      total:    totalBookings,
      distribution: Object.fromEntries(
        bookingDistribution.map((b) => [b.status, b._count.id])
      ),
    },
    revenue: {
      total:               Number(revenueResult._sum.amount ?? 0),
      platform_commission: Number(commissionResult._sum.commission_amount ?? 0),
      month:               Number(monthRevenueResult._sum.amount ?? 0),
    },
    top_spaces: topSpaces.map((s) => ({
      space_id:       s.space_id,
      name:           spaceMap[s.space_id]?.name ?? 'Unknown',
      city:           spaceMap[s.space_id]?.city ?? '',
      booking_count:  s._count.id,
    })),
    growth: {
      signups_30d:  signups30d.map((r) => ({
        date:  r.date.toISOString().slice(0, 10),
        count: Number(r.count),
      })),
      bookings_30d: bookings30d.map((r) => ({
        date:  r.date.toISOString().slice(0, 10),
        count: Number(r.count),
      })),
    },
  };
}

// ═════════════════════════════════════════════
// PROMO CODES
// ═════════════════════════════════════════════

export async function listPromoCodes(query: AdminListPromoCodesQuery) {
  const { active, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.PromoCodeWhereInput = {};
  if (active === 'true')  where.active = true;
  if (active === 'false') where.active = false;

  const [codes, total] = await Promise.all([
    prisma.promoCode.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.promoCode.count({ where }),
  ]);

  return { codes, meta: buildPaginationMeta(total, page, limit) };
}

export async function createPromoCode(adminId: string, dto: CreatePromoCodeDto) {
  const existing = await prisma.promoCode.findUnique({
    where: { code: dto.code },
    select: { id: true },
  });
  if (existing) throw AppError.conflict(ErrorCode.ALREADY_EXISTS, `Promo code '${dto.code}' already exists`);

  const code = await prisma.promoCode.create({
    data: {
      code:               dto.code,
      discount_type:      dto.discount_type,
      discount_value:     dto.discount_value,
      max_discount:       dto.max_discount        ?? null,
      min_booking_amount: dto.min_booking_amount  ?? null,
      usage_limit:        dto.usage_limit         ?? null,
      valid_from:         new Date(dto.valid_from),
      valid_until:        new Date(dto.valid_until),
      active:             true,
    },
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      'promo_code.created',
      entity_type: 'promo_code',
      entity_id:   code.id,
      metadata:    { code: dto.code } as any,
    },
  });

  return code;
}

export async function updatePromoCode(adminId: string, promoId: string, dto: UpdatePromoCodeDto) {
  const existing = await prisma.promoCode.findUnique({
    where:  { id: promoId },
    select: { id: true, code: true },
  });
  if (!existing) throw AppError.notFound('Promo code');

  const updated = await prisma.promoCode.update({
    where: { id: promoId },
    data:  {
      ...(dto.discount_type      !== undefined && { discount_type:      dto.discount_type }),
      ...(dto.discount_value     !== undefined && { discount_value:     dto.discount_value }),
      ...(dto.max_discount       !== undefined && { max_discount:       dto.max_discount }),
      ...(dto.min_booking_amount !== undefined && { min_booking_amount: dto.min_booking_amount }),
      ...(dto.usage_limit        !== undefined && { usage_limit:        dto.usage_limit }),
      ...(dto.valid_from         !== undefined && { valid_from:         new Date(dto.valid_from) }),
      ...(dto.valid_until        !== undefined && { valid_until:        new Date(dto.valid_until) }),
      ...(dto.active             !== undefined && { active:             dto.active }),
    },
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      'promo_code.updated',
      entity_type: 'promo_code',
      entity_id:   promoId,
      metadata:    { code: existing.code, changes: Object.keys(dto) } as any,
    },
  });

  return updated;
}

export async function deactivatePromoCode(adminId: string, promoId: string) {
  const existing = await prisma.promoCode.findUnique({
    where:  { id: promoId },
    select: { id: true, code: true, active: true },
  });
  if (!existing) throw AppError.notFound('Promo code');
  if (!existing.active) throw AppError.conflict(ErrorCode.ALREADY_EXISTS, 'Promo code is already inactive');

  const updated = await prisma.promoCode.update({
    where: { id: promoId },
    data:  { active: false },
    select: { id: true, code: true, active: true },
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      'promo_code.deactivated',
      entity_type: 'promo_code',
      entity_id:   promoId,
      metadata:    { code: existing.code } as any,
    },
  });

  return updated;
}

// ═════════════════════════════════════════════
// BROADCAST NOTIFICATION
// ═════════════════════════════════════════════

export async function broadcastNotification(adminId: string, dto: BroadcastNotificationDto) {
  const where: Prisma.UserWhereInput = { status: 'active' };
  if (dto.filter?.role)   where.role   = dto.filter.role;
  if (dto.filter?.status) where.status = dto.filter.status;

  // Fetch target user IDs in batches to avoid huge memory usage
  const users = await prisma.user.findMany({
    where,
    select: { id: true },
  });

  // Fire-and-forget in batches of 50
  const BATCH = 50;
  let dispatched = 0;
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH);
    await Promise.all(
      batch.map((u) =>
        sendNotification(u.id, 'system_broadcast', dto.title, dto.body, dto.data as Record<string,unknown> | undefined)
          .catch(() => {})
      )
    );
    dispatched += batch.length;
  }

  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      'notification.broadcast',
      entity_type: 'notification',
      entity_id:   null,
      metadata:    { title: dto.title, filter: dto.filter, dispatched } as any,
    },
  });

  return { dispatched };
}

// ═════════════════════════════════════════════
// AUDIT LOGS
// ═════════════════════════════════════════════

export async function listAuditLogs(query: AuditLogQuery) {
  const { actor_id, action, entity_type, entity_id, from, to, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.AuditLogWhereInput = {};
  if (actor_id)    where.actor_id    = actor_id;
  if (entity_type) where.entity_type = entity_type;
  if (entity_id)   where.entity_id   = entity_id;
  if (action)      where.action      = { contains: action, mode: 'insensitive' };
  if (from || to) {
    where.created_at = {
      ...(from && { gte: new Date(from) }),
      ...(to   && { lte: new Date(to)   }),
    };
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      select: {
        id:          true,
        action:      true,
        entity_type: true,
        entity_id:   true,
        metadata:    true,
        ip_address:  true,
        created_at:  true,
        actor: { select: { id: true, first_name: true, last_name: true, email: true, role: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// GET /admin/bank-accounts
// Lists all bank accounts with host info and verification status.
// ─────────────────────────────────────────────
export async function listBankAccounts(query: AdminListBankAccountsQuery) {
  const { host_id, is_verified, page, limit } = query;

  const where: Prisma.BankAccountWhereInput = {
    ...(host_id     ? { host_id }                                    : {}),
    ...(is_verified !== undefined ? { is_verified: is_verified === 'true' } : {}),
  };

  const [accounts, total] = await Promise.all([
    prisma.bankAccount.findMany({
      where,
      select: {
        id:                       true,
        account_holder_name:      true,
        ifsc_code:                true,
        bank_name:                true,
        is_default:               true,
        is_verified:              true,
        razorpay_fund_account_id: true,
        created_at:               true,
        host: {
          select: {
            id:         true,
            first_name: true,
            last_name:  true,
            email:      true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.bankAccount.count({ where }),
  ]);

  return { accounts, total, page, limit };
}

// ─────────────────────────────────────────────
// PATCH /admin/bank-accounts/:id/verify
// Re-registers a bank account with Razorpay X — creates (or re-creates)
// the Contact and Fund Account and persists the resulting IDs.
// Use when the async registration in addBankAccount() silently failed.
// ─────────────────────────────────────────────
export async function adminRegisterBankAccountWithRazorpayX(
  bankAccountId: string,
  adminId: string
): Promise<{ razorpay_contact_id: string; razorpay_fund_account_id: string }> {
  const {
    isRazorpayXConfigured,
    createContact,
    createFundAccount,
  } = await import('../../services/razorpayXService');
  const { decrypt } = await import('../../utils/crypto');
  const { logger }  = await import('../../utils/logger');

  if (!isRazorpayXConfigured()) {
    throw AppError.badRequest(
      ErrorCode.SERVICE_UNAVAILABLE,
      'Razorpay X is not configured on this instance'
    );
  }

  const account = await prisma.bankAccount.findUnique({
    where:   { id: bankAccountId },
    include: {
      host: { select: { id: true, first_name: true, last_name: true, email: true, phone: true } },
    },
  });
  if (!account) throw AppError.notFound('Bank account');

  const hostId      = account.host_id;
  const host        = account.host;
  const contactName = host
    ? `${host.first_name} ${host.last_name}`
    : account.account_holder_name;

  // Re-create contact (Razorpay X is idempotent by reference_id in some modes,
  // but the safest approach is to always create a fresh contact + fund account
  // so we have verified, live IDs in our DB).
  const contact = await createContact({
    hostId,
    name:  contactName,
    email: host.email,
    phone: host.phone ?? undefined,
  });

  const fundAccount = await createFundAccount({
    contactId:         contact.id,
    accountHolderName: account.account_holder_name,
    accountNumber:     decrypt(account.account_number_encrypted),
    ifscCode:          account.ifsc_code,
  });

  // Mark verified only after both Razorpay X calls succeed — no false positives.
  await prisma.bankAccount.update({
    where: { id: bankAccountId },
    data: {
      razorpay_contact_id:      contact.id,
      razorpay_fund_account_id: fundAccount.id,
      is_verified:              true,
    },
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      'bank_account.razorpay_x_registered',
      entity_type: 'bank_account',
      entity_id:   bankAccountId,
      metadata: {
        razorpay_contact_id:    contact.id,
        razorpay_fund_account_id: fundAccount.id,
      },
    },
  }).catch((e) => logger.error(e, 'AUDIT_LOG_WRITE_FAILED'));

  logger.info({
    msg:                    'admin:bank-account-razorpay-x-registered',
    bankAccountId,
    adminId,
    razorpayContactId:      contact.id,
    razorpayFundAccountId:  fundAccount.id,
  });

  return {
    razorpay_contact_id:      contact.id,
    razorpay_fund_account_id: fundAccount.id,
  };
}

// ─────────────────────────────────────────────
// adminMarkBankAccountVerified
// Dev/staging fallback — only callable when Razorpay X is NOT configured.
// Allows admins to manually mark a bank account as verified after
// offline/manual verification, without requiring live Razorpay X credentials.
// Throws in production (when Razorpay X is configured) to prevent bypassing
// the fund-account registration check.
// ─────────────────────────────────────────────
export async function adminMarkBankAccountVerified(
  bankAccountId: string,
  adminId:       string
): Promise<{ id: string; is_verified: true }> {
  const { isRazorpayXConfigured } = await import('../../services/razorpayXService');
  const { logger }                = await import('../../utils/logger');

  if (isRazorpayXConfigured()) {
    throw AppError.badRequest(
      ErrorCode.VALIDATION_ERROR,
      'Use PATCH /admin/bank-accounts/:id/verify to verify accounts when Razorpay X is configured.'
    );
  }

  const account = await prisma.bankAccount.findUnique({
    where:  { id: bankAccountId },
    select: { id: true, is_verified: true },
  });
  if (!account) throw AppError.notFound('Bank account');

  await prisma.bankAccount.update({
    where: { id: bankAccountId },
    data:  { is_verified: true },
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      'bank_account.manually_verified',
      entity_type: 'bank_account',
      entity_id:   bankAccountId,
      metadata:    { note: 'Manually verified — Razorpay X not configured (dev/staging)' },
    },
  }).catch((e) => logger.error(e, 'AUDIT_LOG_WRITE_FAILED'));

  logger.info({ msg: 'admin:bank-account-manually-verified', bankAccountId, adminId });

  return { id: bankAccountId, is_verified: true };
}
