import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { buildPaginationMeta } from '../../utils/pagination';
import type {
  SearchSpacesQuery,
  AutocompleteQuery,
  SpaceDetailQuery,
  AvailabilityQuery,
  ReviewsQuery,
} from './validators';

// ─────────────────────────────────────────────
// Raw SQL result types
// ─────────────────────────────────────────────
interface SpaceSearchRow {
  id: string;
  name: string;
  description: string | null;
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  space_type: string;
  total_capacity: number;
  allowed_vehicles: string[];
  status: string;
  cancellation_policy: string;
  instant_book: boolean;
  geohash: string | null;
  lat: number;
  lng: number;
  distance: number;
  base_hourly_rate: string | null;
  avg_rating: string | null;
  review_count: string;
  photo_url: string | null;
}

interface AutocompleteRow {
  id: string;
  name: string;
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  geohash: string | null;
  similarity: number;
}

// ─────────────────────────────────────────────
// GET /spaces/search
// ─────────────────────────────────────────────
export async function searchSpaces(query: SearchSpacesQuery, userId?: string) {
  const {
    lat,
    lng,
    radius,
    type,
    vehicle_type,
    amenities,
    min_price,
    max_price,
    available_from,
    available_to,
    sort,
    page,
    limit,
  } = query;

  const offset = (page - 1) * limit;

  // ── Build dynamic WHERE fragments ──────────────────
  // We use an array of SQL fragments combined with AND
  // All user values go through Prisma.sql parameterisation — never string-interpolated.

  const conditions: Prisma.Sql[] = [
    Prisma.sql`ps.status = 'active'`,
    Prisma.sql`ps.location IS NOT NULL`,
    Prisma.sql`ST_DWithin(
      ps.location,
      ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography,
      ${radius}::float8
    )`,
  ];

  if (type) {
    conditions.push(Prisma.sql`ps.space_type = ${type}::"SpaceType"`);
  }

  if (vehicle_type) {
    // allowed_vehicles is a varchar[] — check if vehicle_type is in the array
    conditions.push(Prisma.sql`${vehicle_type} = ANY(ps.allowed_vehicles)`);
  }

  if (amenities && amenities.length > 0) {
    // Space must have ALL requested amenities
    // amenities in Prisma use the enum name (e.g. 'access_24x7'), map to DB value via cast
    conditions.push(
      Prisma.sql`(
        SELECT COUNT(*) FROM space_amenities sa
        WHERE sa.space_id = ps.id
          AND sa.amenity::text = ANY(${amenities}::text[])
      ) = ${amenities.length}::bigint`
    );
  }

  if (min_price !== undefined) {
    conditions.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM space_pricing_rules spr
        WHERE spr.space_id = ps.id
          AND spr.rate_type = 'hourly'::"RateType"
          AND spr.base_rate >= ${min_price}::numeric
      )`
    );
  }

  if (max_price !== undefined) {
    conditions.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM space_pricing_rules spr
        WHERE spr.space_id = ps.id
          AND spr.rate_type = 'hourly'::"RateType"
          AND spr.base_rate <= ${max_price}::numeric
      )`
    );
  }

  if (available_from && available_to) {
    // Exclude spaces that have overlapping confirmed/active bookings
    conditions.push(
      Prisma.sql`NOT EXISTS (
        SELECT 1 FROM bookings b
        WHERE b.space_id = ps.id
          AND b.status IN ('confirmed', 'active')
          AND tstzrange(b.start_time, b.end_time, '[)') &&
              tstzrange(${available_from}::timestamptz, ${available_to}::timestamptz, '[)')
      )`
    );
  }

  const whereClause = Prisma.join(conditions, ' AND ');

  // ── Sorting ────────────────────────────────────────
  let orderClause: Prisma.Sql;
  switch (sort) {
    case 'price_asc':
      orderClause = Prisma.sql`COALESCE(base_hourly_rate::numeric, 999999) ASC, distance ASC`;
      break;
    case 'price_desc':
      orderClause = Prisma.sql`COALESCE(base_hourly_rate::numeric, 0) DESC, distance ASC`;
      break;
    case 'rating':
      orderClause = Prisma.sql`COALESCE(avg_rating::numeric, 0) DESC, distance ASC`;
      break;
    default: // distance
      orderClause = Prisma.sql`distance ASC`;
  }

  // ── Main query (with count in a CTE) ───────────────
  const rows = await prisma.$queryRaw<SpaceSearchRow[]>`
    SELECT
      ps.id,
      ps.name,
      ps.description,
      ps.address_line1,
      ps.city,
      ps.state,
      ps.postal_code,
      ps.country,
      ps.space_type,
      ps.total_capacity,
      ps.allowed_vehicles,
      ps.status,
      ps.cancellation_policy,
      ps.instant_book,
      ps.geohash,
      ST_Y(ps.location::geometry) AS lat,
      ST_X(ps.location::geometry) AS lng,
      ST_Distance(
        ps.location,
        ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography
      ) AS distance,
      (
        SELECT spr.base_rate::text
        FROM space_pricing_rules spr
        WHERE spr.space_id = ps.id AND spr.rate_type = 'hourly'::"RateType"
        LIMIT 1
      ) AS base_hourly_rate,
      (
        SELECT AVG(r.rating)::text
        FROM reviews r
        WHERE r.space_id = ps.id AND r.status = 'active'::"ReviewStatus"
      ) AS avg_rating,
      (
        SELECT COUNT(*)::text
        FROM reviews r
        WHERE r.space_id = ps.id AND r.status = 'active'::"ReviewStatus"
      ) AS review_count,
      (
        SELECT sp.url
        FROM space_photos sp
        WHERE sp.space_id = ps.id
        ORDER BY sp.display_order ASC
        LIMIT 1
      ) AS photo_url
    FROM parking_spaces ps
    WHERE ${whereClause}
    ORDER BY ${orderClause}
    LIMIT ${limit}::int
    OFFSET ${offset}::int
  `;

  // ── Count query ────────────────────────────────────
  const countRows = await prisma.$queryRaw<[{ total: bigint }]>`
    SELECT COUNT(*) AS total
    FROM parking_spaces ps
    WHERE ${whereClause}
  `;
  const total = Number(countRows[0]?.total ?? 0);

  // ── Optional: mark favorites for authenticated user ─
  let favoriteSpaceIds = new Set<string>();
  if (userId && rows.length > 0) {
    const spaceIds = rows.map((r) => r.id);
    const favorites = await prisma.favorite.findMany({
      where: { user_id: userId, space_id: { in: spaceIds } },
      select: { space_id: true },
    });
    favoriteSpaceIds = new Set(favorites.map((f) => f.space_id));
  }

  const spaces = rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    address_line1: row.address_line1,
    city: row.city,
    state: row.state,
    postal_code: row.postal_code,
    country: row.country,
    space_type: row.space_type,
    total_capacity: Number(row.total_capacity),
    allowed_vehicles: row.allowed_vehicles,
    status: row.status,
    cancellation_policy: row.cancellation_policy,
    instant_book: row.instant_book,
    lat: Number(row.lat),
    lng: Number(row.lng),
    distance_meters: Math.round(Number(row.distance)),
    base_hourly_rate: row.base_hourly_rate ? Number(row.base_hourly_rate) : null,
    avg_rating: row.avg_rating ? parseFloat(Number(row.avg_rating).toFixed(1)) : null,
    review_count: Number(row.review_count),
    photo_url: row.photo_url,
    is_favorite: favoriteSpaceIds.has(row.id),
  }));

  return { spaces, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// GET /spaces/autocomplete?q=...
// Uses pg_trgm similarity for fuzzy matching on name, address, city
// ─────────────────────────────────────────────
export async function autocomplete(query: AutocompleteQuery) {
  const { q } = query;

  const rows = await prisma.$queryRaw<AutocompleteRow[]>`
    SELECT
      ps.id,
      ps.name,
      ps.address_line1,
      ps.city,
      ps.state,
      ps.postal_code,
      ps.country,
      ps.geohash,
      GREATEST(
        similarity(ps.name, ${q}),
        similarity(ps.city, ${q}),
        similarity(ps.address_line1, ${q}),
        similarity(ps.postal_code, ${q})
      ) AS similarity
    FROM parking_spaces ps
    WHERE
      ps.status = 'active'
      AND (
        ps.name        % ${q}
        OR ps.city     % ${q}
        OR ps.address_line1 % ${q}
        OR ps.postal_code   % ${q}
      )
    ORDER BY similarity DESC
    LIMIT 5
  `;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    address: `${row.address_line1}, ${row.city}, ${row.state} ${row.postal_code}`,
    city: row.city,
    state: row.state,
    postal_code: row.postal_code,
    country: row.country,
    geohash: row.geohash,
  }));
}

// ─────────────────────────────────────────────
// GET /spaces/:id — Public space details
// ─────────────────────────────────────────────
export async function getSpaceDetail(
  spaceId: string,
  query: SpaceDetailQuery,
  userId?: string
) {
  // Fetch the space (excluding location column)
  const space = await prisma.parkingSpace.findFirst({
    where: { id: spaceId, status: 'active' },
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
        },
      },
    },
  });

  if (!space) throw AppError.notFound('Space');

  // Aggregate rating
  const ratingAgg = await prisma.review.aggregate({
    where: { space_id: spaceId, status: 'active' },
    _avg: { rating: true },
    _count: { id: true },
  });

  // Distance (optional)
  let distance_meters: number | null = null;
  if (query.lat !== undefined && query.lng !== undefined) {
    const distRows = await prisma.$queryRaw<[{ dist: number }]>`
      SELECT ST_Distance(
        location,
        ST_SetSRID(ST_MakePoint(${query.lng}::float8, ${query.lat}::float8), 4326)::geography
      ) AS dist
      FROM parking_spaces
      WHERE id = ${spaceId}::uuid
    `;
    distance_meters = distRows[0] ? Math.round(Number(distRows[0].dist)) : null;
  }

  // Is the space in the user's favorites?
  let is_favorite = false;
  if (userId) {
    const fav = await prisma.favorite.findUnique({
      where: { user_id_space_id: { user_id: userId, space_id: spaceId } },
      select: { id: true },
    });
    is_favorite = !!fav;
  }

  return {
    ...space,
    avg_rating: ratingAgg._avg.rating
      ? parseFloat(ratingAgg._avg.rating.toFixed(1))
      : null,
    review_count: ratingAgg._count.id,
    distance_meters,
    is_favorite,
  };
}

// ─────────────────────────────────────────────
// GET /spaces/:id/availability
// Returns booked slots in the requested date range
// ─────────────────────────────────────────────
export async function getAvailability(spaceId: string, query: AvailabilityQuery) {
  const space = await prisma.parkingSpace.findFirst({
    where: { id: spaceId, status: 'active' },
    select: {
      id: true,
      schedules:     { orderBy: { day_of_week: 'asc' } },
      blackout_dates: {
        where: {
          date: {
            gte: new Date(query.from),
            lte: new Date(query.to),
          },
        },
        orderBy: { date: 'asc' },
      },
      buffer_minutes: true,
      min_booking_duration_minutes: true,
      max_booking_duration_minutes: true,
    },
  });
  if (!space) throw AppError.notFound('Space');

  // Fetch confirmed/active bookings that overlap the window
  const bookings = await prisma.booking.findMany({
    where: {
      space_id: spaceId,
      status: { in: ['confirmed', 'active'] },
      start_time: { lt: new Date(query.to) },
      end_time:   { gt: new Date(query.from) },
    },
    select: { id: true, start_time: true, end_time: true, status: true },
    orderBy: { start_time: 'asc' },
  });

  return {
    space_id: spaceId,
    from: query.from,
    to: query.to,
    buffer_minutes: space.buffer_minutes,
    min_booking_duration_minutes: space.min_booking_duration_minutes,
    max_booking_duration_minutes: space.max_booking_duration_minutes,
    schedules: space.schedules,
    blackout_dates: space.blackout_dates.map((b) => ({
      id: b.id,
      date: b.date,
      reason: b.reason,
    })),
    booked_slots: bookings.map((b) => ({
      id: b.id,
      start_time: b.start_time,
      end_time: b.end_time,
      status: b.status,
    })),
  };
}

// ─────────────────────────────────────────────
// GET /spaces/:id/reviews
// ─────────────────────────────────────────────
export async function getReviews(spaceId: string, query: ReviewsQuery) {
  const space = await prisma.parkingSpace.findFirst({
    where: { id: spaceId, status: 'active' },
    select: { id: true },
  });
  if (!space) throw AppError.notFound('Space');

  const { page, limit } = query;
  const skip = (page - 1) * limit;

  const [reviews, total] = await Promise.all([
    prisma.review.findMany({
      where: { space_id: spaceId, status: 'active' },
      select: {
        id: true,
        rating: true,
        body: true,
        created_at: true,
        reviewer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            avatar_url: true,
          },
        },
        response: {
          select: { body: true, created_at: true },
        },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.review.count({ where: { space_id: spaceId, status: 'active' } }),
  ]);

  return { reviews, meta: buildPaginationMeta(total, page, limit) };
}
