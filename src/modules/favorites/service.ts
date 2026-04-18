import { prisma } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { buildPaginationMeta } from '../../utils/pagination';
import { ErrorCode } from '../../types';
import type { ListFavoritesQuery } from './validators';

// ─────────────────────────────────────────────
// GET /favorites
// ─────────────────────────────────────────────
export async function listFavorites(userId: string, query: ListFavoritesQuery) {
  const { lat, lng, page, limit } = query;
  const skip = (page - 1) * limit;

  const [favorites, total] = await Promise.all([
    prisma.favorite.findMany({
      where:   { user_id: userId },
      select: {
        id:         true,
        created_at: true,
        space: {
          select: {
            id:            true,
            name:          true,
            address_line1: true,
            city:          true,
            state:         true,
            space_type:    true,
            status:        true,
            geohash:       true,
            instant_book:  true,
            photos: {
              select:  { url: true },
              orderBy: { display_order: 'asc' },
            },
            pricing_rules: {
              select:  { rate_type: true, base_rate: true },
              orderBy: { base_rate: 'asc' },
              take:    1,
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.favorite.count({ where: { user_id: userId } }),
  ]);

  // Optionally compute straight-line distance if lat/lng provided
  const items = favorites.map((fav) => {
    const base: typeof fav & { distance_km?: number } = fav;
    if (lat !== undefined && lng !== undefined && fav.space.geohash) {
      base.distance_km = approximateDistance(lat, lng, fav.space.geohash);
    }
    return base;
  });

  return { favorites: items, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// POST /favorites/:spaceId
// ─────────────────────────────────────────────
export async function addFavorite(userId: string, spaceId: string) {
  const space = await prisma.parkingSpace.findUnique({
    where:  { id: spaceId },
    select: { id: true, status: true, name: true },
  });
  if (!space) throw AppError.notFound('Space');

  if (!['active', 'paused'].includes(space.status)) {
    throw AppError.badRequest(ErrorCode.SPACE_NOT_ACTIVE, 'Only active or paused spaces can be saved');
  }

  // Upsert — unique constraint on (user_id, space_id) prevents duplicates
  const favorite = await prisma.favorite.upsert({
    where:  { user_id_space_id: { user_id: userId, space_id: spaceId } },
    create: { user_id: userId, space_id: spaceId },
    update: {},
    select: { id: true, user_id: true, space_id: true, created_at: true },
  });

  return favorite;
}

// ─────────────────────────────────────────────
// DELETE /favorites/:spaceId
// ─────────────────────────────────────────────
export async function removeFavorite(userId: string, spaceId: string): Promise<void> {
  const existing = await prisma.favorite.findUnique({
    where:  { user_id_space_id: { user_id: userId, space_id: spaceId } },
    select: { id: true },
  });
  if (!existing) throw AppError.notFound('Favorite');

  await prisma.favorite.delete({
    where: { user_id_space_id: { user_id: userId, space_id: spaceId } },
  });
}

// ─────────────────────────────────────────────
// Helper — approximate distance from geohash centroid
// Uses Haversine formula; geohash decoded to lat/lng bounding box centre
// ─────────────────────────────────────────────
function approximateDistance(lat: number, lng: number, geohash: string): number {
  const { lat: gLat, lng: gLng } = decodeGeohash(geohash);
  return haversine(lat, lng, gLat, gLng);
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

// Minimal geohash decoder (base-32 neighbours, returns centroid lat/lng)
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function decodeGeohash(hash: string): { lat: number; lng: number } {
  let minLat = -90, maxLat = 90, minLng = -180, maxLng = 180;
  let isLng = true;

  for (const char of hash) {
    const idx = BASE32.indexOf(char);
    if (idx < 0) break;
    for (let bits = 4; bits >= 0; bits--) {
      const bit = (idx >> bits) & 1;
      if (isLng) {
        const mid = (minLng + maxLng) / 2;
        bit ? (minLng = mid) : (maxLng = mid);
      } else {
        const mid = (minLat + maxLat) / 2;
        bit ? (minLat = mid) : (maxLat = mid);
      }
      isLng = !isLng;
    }
  }

  return {
    lat: Math.round(((minLat + maxLat) / 2) * 1e6) / 1e6,
    lng: Math.round(((minLng + maxLng) / 2) * 1e6) / 1e6,
  };
}
