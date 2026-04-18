import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import * as service from './service';
import type { ListFavoritesQuery, SpaceIdParam } from './validators';

// ─────────────────────────────────────────────
// GET /favorites
// ─────────────────────────────────────────────
export async function listFavorites(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as ListFavoritesQuery;
    const { favorites, meta } = await service.listFavorites(req.user!.sub, query);
    Respond.ok(res, favorites, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /favorites/:spaceId
// ─────────────────────────────────────────────
export async function addFavorite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { spaceId } = req.params as unknown as SpaceIdParam;
    const favorite = await service.addFavorite(req.user!.sub, spaceId);
    Respond.created(res, favorite, 'Space saved to favorites');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// DELETE /favorites/:spaceId
// ─────────────────────────────────────────────
export async function removeFavorite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { spaceId } = req.params as unknown as SpaceIdParam;
    await service.removeFavorite(req.user!.sub, spaceId);
    Respond.noContent(res);
  } catch (err) { next(err); }
}
