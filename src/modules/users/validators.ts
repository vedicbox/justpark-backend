import { z } from 'zod';

// ─────────────────────────────────────────────
// POST /users/me/kyc
// ─────────────────────────────────────────────
export const SubmitKycSchema = z.object({
  document_type: z.enum(
    ['id_card', 'passport', 'driving_license', 'business_registration'],
    { required_error: 'document_type is required' }
  ),
});
export type SubmitKycDto = z.infer<typeof SubmitKycSchema>;

// ─────────────────────────────────────────────
// PATCH /users/me
// ─────────────────────────────────────────────
export const UpdateProfileSchema = z
  .object({
    first_name: z
      .string({ invalid_type_error: 'First name must be a string' })
      .min(1, 'First name cannot be empty')
      .max(100, 'First name must be 100 characters or fewer')
      .trim()
      .optional(),

    last_name: z
      .string({ invalid_type_error: 'Last name must be a string' })
      .min(1, 'Last name cannot be empty')
      .max(100, 'Last name must be 100 characters or fewer')
      .trim()
      .optional(),

    // E.164 format: leading +, country code (1 digit, no leading 0), then 7–13 digits.
    // Examples: +919876543210, +14155552671
    phone: z
      .string({ invalid_type_error: 'Phone must be a string' })
      .regex(
        /^\+[1-9]\d{7,14}$/,
        'Phone must be in E.164 format (e.g. +919876543210)',
      )
      .optional(),

    email: z
      .string({ invalid_type_error: 'Email must be a string' })
      .email('Must be a valid email address')
      .max(255, 'Email must be 255 characters or fewer')
      .toLowerCase()
      .optional(),
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: 'At least one field must be provided' },
  );
export type UpdateProfileDto = z.infer<typeof UpdateProfileSchema>;

// ─────────────────────────────────────────────
// POST /users/me/vehicles
// ─────────────────────────────────────────────
export const CreateVehicleSchema = z.object({
  plate_number: z
    .string({ required_error: 'Plate number is required' })
    .min(1)
    .max(20)
    .trim()
    .toUpperCase(),
  type: z.enum(['car', 'bike', 'ev', 'truck', 'van'], {
    required_error: 'Vehicle type is required',
  }),
  make: z.string().min(1).max(100).trim().optional(),
  model: z.string().min(1).max(100).trim().optional(),
  color: z.string().min(1).max(50).trim().optional(),
  is_default: z.boolean().default(false),
});
export type CreateVehicleDto = z.infer<typeof CreateVehicleSchema>;

// ─────────────────────────────────────────────
// PATCH /users/me/vehicles/:id
// ─────────────────────────────────────────────
export const UpdateVehicleSchema = z
  .object({
    plate_number: z.string().min(1).max(20).trim().toUpperCase().optional(),
    type: z.enum(['car', 'bike', 'ev', 'truck', 'van']).optional(),
    make: z.string().min(1).max(100).trim().optional(),
    model: z.string().min(1).max(100).trim().optional(),
    color: z.string().min(1).max(50).trim().optional(),
    is_default: z.boolean().optional(),
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: 'At least one field must be provided' }
  );
export type UpdateVehicleDto = z.infer<typeof UpdateVehicleSchema>;

// ─────────────────────────────────────────────
// Route param — :id (UUID)
// ─────────────────────────────────────────────
export const VehicleIdParamSchema = z.object({
  id: z.string().uuid('Invalid vehicle ID'),
});
export type VehicleIdParam = z.infer<typeof VehicleIdParamSchema>;
