import { PaginationMeta, PaginationParams, PaginationQuery } from '../types';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ─────────────────────────────────────────────
// Parse and clamp pagination query params
// ─────────────────────────────────────────────
export function parsePagination(query: PaginationQuery): PaginationParams {
  const page = Math.max(1, Number(query.page) || DEFAULT_PAGE);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT));
  const skip = (page - 1) * limit;

  return { page, limit, skip, take: limit };
}

// ─────────────────────────────────────────────
// Build pagination meta for response
// ─────────────────────────────────────────────
export function buildPaginationMeta(
  total: number,
  page: number,
  limit: number
): PaginationMeta {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasMore: page < totalPages,
    hasPrev: page > 1,
  };
}

// ─────────────────────────────────────────────
// Combined helper — parse + build in one call
// ─────────────────────────────────────────────
export function paginate(query: PaginationQuery, total: number) {
  const params = parsePagination(query);
  const meta = buildPaginationMeta(total, params.page, params.limit);
  return { params, meta };
}
