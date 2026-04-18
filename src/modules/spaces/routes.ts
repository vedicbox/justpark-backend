import { Router } from 'express';
import { optionalAuthenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './controller';
import {
  SearchSpacesQuerySchema,
  AutocompleteQuerySchema,
  SpaceDetailQuerySchema,
  SpaceIdParamSchema,
  AvailabilityQuerySchema,
  ReviewsQuerySchema,
} from './validators';

export const spacesRouter = Router();

// All routes are public. optionalAuthenticate attaches req.user if a valid
// Bearer token is present — used to mark favorites without requiring login.
spacesRouter.use(optionalAuthenticate);

// ─────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────

/**
 * GET /spaces/search
 * PostGIS radius search with filtering, availability checking, and sorting.
 *
 * Required: lat, lng
 * Optional: radius (m, default 2000, max 10000), type, vehicle_type,
 *           amenities (comma-separated), min_price, max_price,
 *           available_from, available_to (ISO8601), sort, page, limit
 */
spacesRouter.get(
  '/search',
  validate(SearchSpacesQuerySchema, 'query'),
  controller.searchSpaces
);

/**
 * GET /spaces/autocomplete?q=...
 * Fuzzy address/city/name search using PostgreSQL pg_trgm.
 * Returns up to 5 suggestions.
 *
 * NOTE: must be registered before /spaces/:id to avoid ":id" capturing "autocomplete"
 */
spacesRouter.get(
  '/autocomplete',
  validate(AutocompleteQuerySchema, 'query'),
  controller.autocomplete
);

// ─────────────────────────────────────────────
// Space detail (public)
// ─────────────────────────────────────────────

/**
 * GET /spaces/:id
 * Full public details: photos, amenities, schedule, pricing,
 * host info, aggregate rating, review count.
 * Optional ?lat=&lng= to include distance_meters in response.
 * If authenticated, includes is_favorite flag.
 */
spacesRouter.get(
  '/:id',
  validate(SpaceIdParamSchema, 'params'),
  validate(SpaceDetailQuerySchema, 'query'),
  controller.getSpaceDetail
);

/**
 * GET /spaces/:id/availability?from=ISO&to=ISO
 * Returns booked slots, weekly schedule, and blackout dates
 * for the requested window so the frontend can render a calendar.
 */
spacesRouter.get(
  '/:id/availability',
  validate(SpaceIdParamSchema, 'params'),
  validate(AvailabilityQuerySchema, 'query'),
  controller.getAvailability
);

/**
 * GET /spaces/:id/reviews?page=&limit=
 * Paginated active reviews for the space, newest first.
 * Includes reviewer name/avatar and host response if present.
 */
spacesRouter.get(
  '/:id/reviews',
  validate(SpaceIdParamSchema, 'params'),
  validate(ReviewsQuerySchema, 'query'),
  controller.getReviews
);
