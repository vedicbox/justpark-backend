import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../middleware/errorHandler';
import { ErrorCode } from '../../types';
import * as controller from './controller';
import {
  UpdateProfileSchema,
  CreateVehicleSchema,
  UpdateVehicleSchema,
  VehicleIdParamSchema,
  SubmitKycSchema,
} from './validators';

export const usersRouter = Router();

// Multer: memory storage, 5MB limit, images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});

// All users routes require a valid JWT
usersRouter.use(authenticate);

// ─────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────

/**
 * GET /users/me
 * Return the authenticated user's full profile.
 */
usersRouter.get('/me', controller.getProfile);

/**
 * PATCH /users/me
 * Update profile fields: first_name, last_name, phone.
 */
usersRouter.patch(
  '/me',
  validate(UpdateProfileSchema),
  controller.updateProfile
);

/**
 * POST /users/me/avatar
 * Upload a new avatar image (multipart/form-data, field: "avatar").
 * Replaces and deletes any existing avatar from S3.
 */
usersRouter.post(
  '/me/avatar',
  upload.single('avatar'),
  controller.uploadAvatar
);

// ─────────────────────────────────────────────
// KYC
// ─────────────────────────────────────────────

/**
 * POST /users/me/kyc
 * Submit a KYC document (photo of ID/passport/driving licence) for admin review.
 * Accepts multipart/form-data: field "document" (JPEG/PNG/WebP, max 5 MB) +
 * JSON field "document_type".
 * Blocks duplicate pending submissions for the same document_type.
 */
usersRouter.post(
  '/me/kyc',
  upload.single('document'),
  validate(SubmitKycSchema),
  controller.submitKyc
);

// ─────────────────────────────────────────────
// Vehicles
// ─────────────────────────────────────────────

/**
 * GET /users/me/vehicles
 * List all vehicles belonging to the authenticated user.
 * Default vehicle is listed first.
 */
usersRouter.get('/me/vehicles', controller.getVehicles);

/**
 * POST /users/me/vehicles
 * Add a new vehicle. First vehicle is automatically set as default.
 * If is_default: true, clears any existing default first.
 */
usersRouter.post(
  '/me/vehicles',
  validate(CreateVehicleSchema),
  controller.createVehicle
);

/**
 * PATCH /users/me/vehicles/:id
 * Update vehicle details. Setting is_default: true transfers
 * the default flag from any other vehicle.
 */
usersRouter.patch(
  '/me/vehicles/:id',
  validate(VehicleIdParamSchema, 'params'),
  validate(UpdateVehicleSchema),
  controller.updateVehicle
);

/**
 * DELETE /users/me/vehicles/:id
 * Remove a vehicle. Blocked if the vehicle has an active booking.
 * If the deleted vehicle was the default, the oldest remaining
 * vehicle is automatically promoted to default.
 */
usersRouter.delete(
  '/me/vehicles/:id',
  validate(VehicleIdParamSchema, 'params'),
  controller.deleteVehicle
);
