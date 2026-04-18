import { prisma } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { buildPaginationMeta } from '../../utils/pagination';
import { ErrorCode } from '../../types';
import { notifyNewReview } from '../../services/notification';
import type {
  CreateReviewDto,
  UpdateReviewDto,
  RespondToReviewDto,
  ReportReviewDto,
  ListFlaggedReviewsQuery,
} from './validators';

// ─────────────────────────────────────────────
// Profanity filter — basic word list
// ─────────────────────────────────────────────
const PROFANITY_LIST = [
  'badword1', 'badword2', 'spam', 'scam', 'idiot', 'stupid', 'moron',
];

function containsProfanity(text: string): boolean {
  const lower = text.toLowerCase();
  return PROFANITY_LIST.some((word) => lower.includes(word));
}

// ─────────────────────────────────────────────
// Reusable select
// ─────────────────────────────────────────────
const REVIEW_SELECT = {
  id:          true,
  booking_id:  true,
  reviewer_id: true,
  reviewee_id: true,
  space_id:    true,
  rating:      true,
  body:        true,
  status:      true,
  created_at:  true,
  updated_at:  true,
  reviewer: { select: { id: true, first_name: true, last_name: true, avatar_url: true } },
  reviewee: { select: { id: true, first_name: true, last_name: true } },
  space:    { select: { id: true, name: true } },
  response: { select: { id: true, body: true, created_at: true } },
} as const;

// ─────────────────────────────────────────────
// Recompute space average rating in PlatformConfig
// ─────────────────────────────────────────────
async function refreshSpaceRating(spaceId: string): Promise<void> {
  const agg = await prisma.review.aggregate({
    where: { space_id: spaceId, status: 'active' },
    _avg:  { rating: true },
    _count: { id: true },
  });

  await prisma.platformConfig.upsert({
    where: { key: `space_rating:${spaceId}` },
    create: {
      key:   `space_rating:${spaceId}`,
      value: { avg: agg._avg.rating ?? 0, count: agg._count.id },
    },
    update: {
      value: { avg: agg._avg.rating ?? 0, count: agg._count.id },
    },
  });
}

// ─────────────────────────────────────────────
// POST /reviews
// ─────────────────────────────────────────────
export async function submitReview(userId: string, dto: CreateReviewDto) {
  // Verify booking belongs to user and is completed
  const booking = await prisma.booking.findFirst({
    where:  { id: dto.booking_id, user_id: userId },
    select: {
      id:       true,
      status:   true,
      space_id: true,
      space:    { select: { host_id: true, name: true } },
    },
  });
  if (!booking) throw AppError.notFound('Booking');

  if (booking.status !== 'completed') {
    throw AppError.conflict(
      ErrorCode.INVALID_BOOKING_STATE,
      'Reviews can only be submitted for completed bookings'
    );
  }

  // One review per booking (unique constraint)
  const existing = await prisma.review.findUnique({
    where:  { booking_id: dto.booking_id },
    select: { id: true },
  });
  if (existing) {
    throw AppError.conflict(ErrorCode.ALREADY_EXISTS, 'You have already reviewed this booking');
  }

  // Profanity check — auto-flag if detected
  const hasProfanity = dto.body ? containsProfanity(dto.body) : false;
  const initialStatus = hasProfanity ? 'flagged' : 'active';

  const review = await prisma.review.create({
    data: {
      booking_id:  dto.booking_id,
      reviewer_id: userId,
      reviewee_id: booking.space?.host_id ?? null,
      space_id:    booking.space_id ?? null,
      rating:      dto.rating,
      body:        dto.body,
      status:      initialStatus,
    },
    select: REVIEW_SELECT,
  });

  // Refresh space aggregate rating
  if (booking.space_id && initialStatus === 'active') {
    refreshSpaceRating(booking.space_id).catch(() => {});
  }

  // Notify host of new review
  if (booking.space?.host_id && booking.space_id) {
    notifyNewReview(booking.space.host_id, review.id, booking.space.name).catch(() => {});
  }

  return { review, auto_flagged: hasProfanity };
}

// ─────────────────────────────────────────────
// PATCH /reviews/:id
// ─────────────────────────────────────────────
export async function editReview(userId: string, reviewId: string, dto: UpdateReviewDto) {
  const review = await prisma.review.findFirst({
    where:  { id: reviewId, reviewer_id: userId },
    select: { id: true, status: true, space_id: true, created_at: true, body: true },
  });
  if (!review) throw AppError.notFound('Review');

  if (review.status === 'removed') {
    throw AppError.conflict(ErrorCode.VALIDATION_ERROR, 'Removed reviews cannot be edited');
  }

  const hoursSinceCreation = (Date.now() - review.created_at.getTime()) / (1000 * 60 * 60);
  if (hoursSinceCreation > 24) {
    throw AppError.conflict(
      ErrorCode.VALIDATION_ERROR,
      'Reviews can only be edited within 24 hours of submission'
    );
  }

  const newBody = dto.body ?? (review.body ?? undefined);
  const hasProfanity = newBody ? containsProfanity(newBody) : false;
  const newStatus = hasProfanity ? 'flagged' : 'active';

  const updated = await prisma.review.update({
    where: { id: reviewId },
    data: {
      ...(dto.rating !== undefined && { rating: dto.rating }),
      ...(dto.body   !== undefined && { body: dto.body }),
      status: newStatus,
    },
    select: REVIEW_SELECT,
  });

  if (review.space_id && newStatus === 'active') {
    refreshSpaceRating(review.space_id).catch(() => {});
  }

  return updated;
}

// ─────────────────────────────────────────────
// POST /reviews/:id/respond
// ─────────────────────────────────────────────
export async function respondToReview(hostId: string, reviewId: string, dto: RespondToReviewDto) {
  const review = await prisma.review.findUnique({
    where:  { id: reviewId },
    select: {
      id:       true,
      status:   true,
      space:    { select: { host_id: true } },
      response: { select: { id: true } },
    },
  });
  if (!review) throw AppError.notFound('Review');

  if (review.status === 'removed') {
    throw AppError.conflict(ErrorCode.VALIDATION_ERROR, 'Cannot respond to a removed review');
  }

  if (review.space?.host_id !== hostId) {
    throw AppError.forbidden('Only the space owner can respond to this review');
  }

  if (review.response) {
    throw AppError.conflict(ErrorCode.ALREADY_EXISTS, 'A response has already been submitted for this review');
  }

  return prisma.reviewResponse.create({
    data:   { review_id: reviewId, body: dto.body },
    select: { id: true, review_id: true, body: true, created_at: true },
  });
}

// ─────────────────────────────────────────────
// POST /reviews/:id/report
// ─────────────────────────────────────────────
export async function reportReview(userId: string, reviewId: string, dto: ReportReviewDto) {
  const review = await prisma.review.findUnique({
    where:  { id: reviewId },
    select: { id: true, status: true },
  });
  if (!review) throw AppError.notFound('Review');

  if (review.status === 'removed') {
    throw AppError.conflict(ErrorCode.VALIDATION_ERROR, 'This review has already been removed');
  }

  await Promise.all([
    prisma.review.update({ where: { id: reviewId }, data: { status: 'flagged' } }),
    prisma.auditLog.create({
      data: {
        actor_id:    userId,
        action:      'review.reported',
        entity_type: 'review',
        entity_id:   reviewId,
        metadata:    { reason: dto.reason },
      },
    }),
  ]);

  return { reported: true, review_id: reviewId };
}

// ─────────────────────────────────────────────
// DELETE /admin/reviews/:id
// ─────────────────────────────────────────────
export async function adminRemoveReview(adminId: string, reviewId: string) {
  const review = await prisma.review.findUnique({
    where:  { id: reviewId },
    select: { id: true, status: true, space_id: true },
  });
  if (!review) throw AppError.notFound('Review');

  if (review.status === 'removed') {
    throw AppError.conflict(ErrorCode.VALIDATION_ERROR, 'Review is already removed');
  }

  const [updated] = await Promise.all([
    prisma.review.update({
      where:  { id: reviewId },
      data:   { status: 'removed' },
      select: { id: true, status: true, updated_at: true },
    }),
    prisma.auditLog.create({
      data: {
        actor_id:    adminId,
        action:      'review.removed',
        entity_type: 'review',
        entity_id:   reviewId,
        metadata:    {},
      },
    }),
  ]);

  if (review.space_id) refreshSpaceRating(review.space_id).catch(() => {});

  return updated;
}

// ─────────────────────────────────────────────
// GET /admin/reviews/flagged
// ─────────────────────────────────────────────
export async function listFlaggedReviews(query: ListFlaggedReviewsQuery) {
  const { page, limit } = query;
  const skip = (page - 1) * limit;

  const [reviews, total] = await Promise.all([
    prisma.review.findMany({
      where:   { status: 'flagged' },
      select:  REVIEW_SELECT,
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.review.count({ where: { status: 'flagged' } }),
  ]);

  return { reviews, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// Public helper — get cached space rating
// ─────────────────────────────────────────────
export async function getSpaceRating(spaceId: string): Promise<{ avg: number; count: number }> {
  const config = await prisma.platformConfig.findUnique({
    where: { key: `space_rating:${spaceId}` },
  });
  if (config) {
    const val = config.value as { avg: number; count: number };
    return { avg: val.avg ?? 0, count: val.count ?? 0 };
  }
  const agg = await prisma.review.aggregate({
    where: { space_id: spaceId, status: 'active' },
    _avg:  { rating: true },
    _count: { id: true },
  });
  return { avg: agg._avg.rating ?? 0, count: agg._count.id };
}
