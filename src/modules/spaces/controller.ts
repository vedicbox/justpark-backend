import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import * as spacesService from './service';
import type {
  SearchSpacesQuery,
  AutocompleteQuery,
  SpaceDetailQuery,
  SpaceIdParam,
  AvailabilityQuery,
  ReviewsQuery,
} from './validators';

// ─────────────────────────────────────────────
// GET /spaces/search
// ─────────────────────────────────────────────
export async function searchSpaces(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as SearchSpacesQuery;
    const result = await spacesService.searchSpaces(query, req.user?.sub);
    Respond.ok(res, result.spaces, undefined, result.meta);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// GET /spaces/autocomplete
// ─────────────────────────────────────────────
export async function autocomplete(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as AutocompleteQuery;
    const suggestions = await spacesService.autocomplete(query);
    Respond.ok(res, suggestions);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// GET /spaces/:id
// ─────────────────────────────────────────────
export async function getSpaceDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const query = req.query as unknown as SpaceDetailQuery;
    const space = await spacesService.getSpaceDetail(id, query, req.user?.sub);
    Respond.ok(res, space);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// GET /spaces/:id/availability
// ─────────────────────────────────────────────
export async function getAvailability(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const query = req.query as unknown as AvailabilityQuery;
    const availability = await spacesService.getAvailability(id, query);
    Respond.ok(res, availability);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// GET /spaces/:id/reviews
// ─────────────────────────────────────────────
export async function getReviews(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const query = req.query as unknown as ReviewsQuery;
    const result = await spacesService.getReviews(id, query);
    Respond.ok(res, result.reviews, undefined, result.meta);
  } catch (err) {
    next(err);
  }
}
