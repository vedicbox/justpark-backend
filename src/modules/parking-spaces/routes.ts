import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../middleware/errorHandler';
import { ErrorCode } from '../../types';
import * as controller from './controller';
import { CreateParkingSpaceSchema, ParkingSpaceIdSchema } from './validators';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});

export const parkingSpacesRouter = Router();

/**
 * POST /parking-spaces
 * Create a new parking space (requires authentication).
 */
parkingSpacesRouter.post(
  '/',
  authenticate,
  validate(CreateParkingSpaceSchema, 'body'),
  controller.createParkingSpace
);

/**
 * GET /parking-spaces/:id
 * Retrieve details for a specific parking space.
 */
parkingSpacesRouter.get(
  '/:id',
  validate(ParkingSpaceIdSchema, 'params'),
  controller.getParkingSpace
);

/**
 * POST /parking-spaces/:id/images
 * Upload up to 5 images directly to MinIO and link to the space.
 */
parkingSpacesRouter.post(
  '/:id/images',
  authenticate,
  validate(ParkingSpaceIdSchema, 'params'),
  upload.array('images', 5),
  controller.uploadImages
);

/**
 * DELETE /parking-spaces/:id/images
 * Remove explicitly targeted URLs natively from MinIO and Database bindings.
 */
parkingSpacesRouter.delete(
  '/:id/images',
  authenticate,
  validate(ParkingSpaceIdSchema, 'params'),
  controller.deleteImages
);
