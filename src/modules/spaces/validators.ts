import { z } from 'zod';

// ─────────────────────────────────────────────
// GET /spaces/search
// ─────────────────────────────────────────────
export const SearchSpacesQuerySchema = z.object({
  lat: z
    .string({ required_error: 'lat is required' })
    .transform(Number)
    .refine((v) => !isNaN(v) && v >= -90 && v <= 90, 'lat must be between -90 and 90'),
  lng: z
    .string({ required_error: 'lng is required' })
    .transform(Number)
    .refine((v) => !isNaN(v) && v >= -180 && v <= 180, 'lng must be between -180 and 180'),
  radius: z
    .string()
    .optional()
    .transform((v) => Math.min(10000, Math.max(1, v ? Number(v) : 2000)))
    .refine((v) => !isNaN(v), 'radius must be a number'),
  type: z.enum(['open_air', 'covered', 'garage', 'indoor', 'underground']).optional(),
  vehicle_type: z.enum(['car', 'bike', 'ev', 'truck', 'van']).optional(),
  // comma-separated amenity values
  amenities: z
    .string()
    .optional()
    .transform((v) =>
      v ? v.split(',').map((a) => a.trim()).filter(Boolean) : undefined
    ),
  min_price: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : undefined))
    .refine((v) => v === undefined || (!isNaN(v) && v >= 0), 'min_price must be ≥ 0'),
  max_price: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : undefined))
    .refine((v) => v === undefined || (!isNaN(v) && v > 0), 'max_price must be > 0'),
  available_from: z
    .string()
    .optional()
    .refine((v) => !v || !isNaN(Date.parse(v)), 'available_from must be a valid ISO date-time'),
  available_to: z
    .string()
    .optional()
    .refine((v) => !v || !isNaN(Date.parse(v)), 'available_to must be a valid ISO date-time'),
  sort: z.enum(['distance', 'price_asc', 'price_desc', 'rating']).default('distance'),
  page: z
    .string()
    .optional()
    .transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.min(50, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type SearchSpacesQuery = z.infer<typeof SearchSpacesQuerySchema>;

// ─────────────────────────────────────────────
// GET /spaces/autocomplete
// ─────────────────────────────────────────────
export const AutocompleteQuerySchema = z.object({
  q: z
    .string({ required_error: 'q is required' })
    .min(2, 'Query must be at least 2 characters')
    .max(200)
    .trim(),
});
export type AutocompleteQuery = z.infer<typeof AutocompleteQuerySchema>;

// ─────────────────────────────────────────────
// GET /spaces/:id  (optional lat/lng for distance)
// ─────────────────────────────────────────────
export const SpaceDetailQuerySchema = z.object({
  lat: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : undefined))
    .refine((v) => v === undefined || (!isNaN(v) && v >= -90 && v <= 90), 'Invalid lat'),
  lng: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : undefined))
    .refine((v) => v === undefined || (!isNaN(v) && v >= -180 && v <= 180), 'Invalid lng'),
});
export type SpaceDetailQuery = z.infer<typeof SpaceDetailQuerySchema>;

// ─────────────────────────────────────────────
// Route param
// ─────────────────────────────────────────────
export const SpaceIdParamSchema = z.object({
  id: z.string().uuid('Invalid space ID'),
});
export type SpaceIdParam = z.infer<typeof SpaceIdParamSchema>;

// ─────────────────────────────────────────────
// GET /spaces/:id/availability
// ─────────────────────────────────────────────
export const AvailabilityQuerySchema = z.object({
  from: z
    .string({ required_error: 'from is required' })
    .refine((v) => !isNaN(Date.parse(v)), 'from must be a valid ISO date-time'),
  to: z
    .string({ required_error: 'to is required' })
    .refine((v) => !isNaN(Date.parse(v)), 'to must be a valid ISO date-time'),
});
export type AvailabilityQuery = z.infer<typeof AvailabilityQuerySchema>;

// ─────────────────────────────────────────────
// GET /spaces/:id/reviews
// ─────────────────────────────────────────────
export const ReviewsQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.min(50, Math.max(1, v ? parseInt(v, 10) : 10))),
});
export type ReviewsQuery = z.infer<typeof ReviewsQuerySchema>;
