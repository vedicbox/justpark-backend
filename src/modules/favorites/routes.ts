import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './controller';
import { ListFavoritesQuerySchema, SpaceIdParamSchema } from './validators';

export const favoritesRouter = Router();

// All favorites routes require authentication
favoritesRouter.use(authenticate);

/**
 * GET /favorites
 * List saved spaces. Optionally pass ?lat=&lng= for distance sorting.
 */
favoritesRouter.get(
  '/',
  validate(ListFavoritesQuerySchema, 'query'),
  controller.listFavorites
);

/**
 * POST /favorites/:spaceId
 * Save a space to favorites. Idempotent — duplicate saves are ignored.
 */
favoritesRouter.post(
  '/:spaceId',
  validate(SpaceIdParamSchema, 'params'),
  controller.addFavorite
);

/**
 * DELETE /favorites/:spaceId
 * Remove a space from favorites.
 */
favoritesRouter.delete(
  '/:spaceId',
  validate(SpaceIdParamSchema, 'params'),
  controller.removeFavorite
);
