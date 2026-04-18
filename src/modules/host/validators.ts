import { z } from 'zod';

// ─────────────────────────────────────────────
// Reusable field types
// ─────────────────────────────────────────────
const vehicleTypeEnum = z.enum(['car', 'bike', 'ev', 'truck', 'van']);

// Amenity values match Prisma enum names (access_24x7 maps to DB value 24x7_access)
const amenityEnum = z.enum([
  'cctv',
  'ev_charging',
  'access_24x7',
  'gated',
  'covered',
  'security_guard',
  'lighting',
  'wheelchair_accessible',
  'ev_type1',
  'ev_type2',
  'ev_ccs',
  'ev_chademo',
]);

const spaceTypeEnum = z.enum(['open_air', 'covered', 'garage', 'indoor', 'underground']);
const cancellationPolicyEnum = z.enum(['flexible', 'moderate', 'strict']);

// India bounding box — covers mainland + all territories (A&N Islands, Lakshadweep)
const latField = z
  .number({ required_error: 'Latitude is required' })
  .min(6.4, 'Location must be within India')
  .max(37.6, 'Location must be within India');

const lngField = z
  .number({ required_error: 'Longitude is required' })
  .min(68.1, 'Location must be within India')
  .max(97.4, 'Location must be within India');

const timeField = z
  .string()
  .regex(/^\d{2}:\d{2}$/, 'Time must be in HH:mm format');

// ─────────────────────────────────────────────
// POST /host/spaces — Create listing
// ─────────────────────────────────────────────
export const CreateSpaceSchema = z.object({
  name: z
    .string({ required_error: 'Space name is required' })
    .min(3, 'Name must be at least 3 characters')
    .max(200)
    .trim(),
  description: z.string().max(5000).trim().optional(),
  address_line1: z
    .string({ required_error: 'Address is required' })
    .min(1)
    .max(255)
    .trim(),
  address_line2: z.string().max(255).trim().optional(),
  city: z.string({ required_error: 'City is required' }).min(1).max(100).trim(),
  state: z.string({ required_error: 'State is required' }).min(1).max(100).trim(),
  postal_code: z
    .string({ required_error: 'Postal code is required' })
    .min(1)
    .max(20)
    .trim(),
  country: z.string().length(2, 'Country must be a 2-letter ISO code').default('IN'),
  lat: latField,
  lng: lngField,
  space_type: spaceTypeEnum,
  total_capacity: z
    .number({ required_error: 'Capacity is required' })
    .int()
    .min(1, 'Capacity must be at least 1'),
  allowed_vehicles: z
    .array(vehicleTypeEnum)
    .min(1, 'At least one vehicle type must be allowed'),
  amenities: z.array(amenityEnum).optional(),
  cancellation_policy: cancellationPolicyEnum.default('flexible'),
  min_booking_duration_minutes: z.number().int().min(15).optional(),
  max_booking_duration_minutes: z.number().int().min(15).optional(),
  buffer_minutes: z.number().int().min(0).default(0),
  instant_book: z.boolean().default(true),
});
export type CreateSpaceDto = z.infer<typeof CreateSpaceSchema>;

// ─────────────────────────────────────────────
// PATCH /host/spaces/:id — Update listing
// ─────────────────────────────────────────────
export const UpdateSpaceSchema = z
  .object({
    name: z.string().min(3).max(200).trim().optional(),
    description: z.string().max(5000).trim().optional(),
    address_line1: z.string().min(1).max(255).trim().optional(),
    address_line2: z.string().max(255).trim().optional(),
    city: z.string().min(1).max(100).trim().optional(),
    state: z.string().min(1).max(100).trim().optional(),
    postal_code: z.string().min(1).max(20).trim().optional(),
    country: z.string().length(2).optional(),
    lat: latField.optional(),
    lng: lngField.optional(),
    space_type: spaceTypeEnum.optional(),
    total_capacity: z.number().int().min(1).optional(),
    allowed_vehicles: z.array(vehicleTypeEnum).min(1).optional(),
    amenities: z.array(amenityEnum).optional(),
    cancellation_policy: cancellationPolicyEnum.optional(),
    min_booking_duration_minutes: z.number().int().min(15).optional(),
    max_booking_duration_minutes: z.number().int().min(15).optional(),
    buffer_minutes: z.number().int().min(0).optional(),
    instant_book: z.boolean().optional(),
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: 'At least one field must be provided' }
  )
  .refine(
    (data) => {
      const hasLat = data.lat !== undefined;
      const hasLng = data.lng !== undefined;
      return hasLat === hasLng;
    },
    { message: 'lat and lng must be provided together', path: ['lat'] }
  );
export type UpdateSpaceDto = z.infer<typeof UpdateSpaceSchema>;

// ─────────────────────────────────────────────
// PUT /host/spaces/:id/schedule — Set weekly schedule
// ─────────────────────────────────────────────
const ScheduleDaySchema = z
  .object({
    day_of_week: z
      .number()
      .int()
      .min(0, 'day_of_week must be 0 (Sun) to 6 (Sat)')
      .max(6, 'day_of_week must be 0 (Sun) to 6 (Sat)'),
    open_time: timeField,
    close_time: timeField,
    is_closed: z.boolean().default(false),
  })
  .refine(
    (d) => d.is_closed || d.open_time < d.close_time,
    { message: 'open_time must be before close_time when the space is open', path: ['open_time'] }
  );

export const SetScheduleSchema = z.object({
  schedules: z
    .array(ScheduleDaySchema)
    .min(1, 'At least one schedule entry is required')
    .max(7, 'Maximum 7 schedule entries (one per day)')
    .refine(
      (arr) => {
        const days = arr.map((s) => s.day_of_week);
        return new Set(days).size === days.length;
      },
      { message: 'Duplicate day_of_week entries are not allowed' }
    ),
});
export type SetScheduleDto = z.infer<typeof SetScheduleSchema>;

// ─────────────────────────────────────────────
// POST /host/spaces/:id/blackout — Add blackout date
// ─────────────────────────────────────────────
export const AddBlackoutSchema = z.object({
  date: z
    .string({ required_error: 'Date is required' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .refine((d) => !isNaN(Date.parse(d)), { message: 'Invalid date' }),
  reason: z.string().max(255).trim().optional(),
});
export type AddBlackoutDto = z.infer<typeof AddBlackoutSchema>;

// ─────────────────────────────────────────────
// PUT /host/spaces/:id/pricing — Set pricing rules
// ─────────────────────────────────────────────
const PeakRuleSchema = z.object({
  start_time: timeField,
  end_time: timeField,
  multiplier: z
    .number()
    .min(1, 'Peak multiplier must be ≥ 1')
    .max(5, 'Peak multiplier cannot exceed 5'),
});

const DiscountRulesSchema = z
  .object({
    long_stay_hours: z.number().int().min(1).optional(),
    discount_pct: z.number().min(0).max(100).optional(),
    early_bird_hours: z.number().int().min(1).optional(),
    early_bird_discount: z.number().min(0).max(100).optional(),
  })
  .optional();

const PricingRuleInputSchema = z.object({
  rate_type: z.enum(['hourly', 'daily', 'monthly'], {
    required_error: 'Rate type is required',
  }),
  base_rate: z
    .number({ required_error: 'Base rate is required' })
    .positive('Base rate must be positive'),
  currency: z.string().length(3, 'Currency must be a 3-letter ISO code').default('INR'),
  peak_rules: z.array(PeakRuleSchema).optional(),
  weekend_multiplier: z.number().min(1).max(5).optional(),
  discount_rules: DiscountRulesSchema,
  min_price: z.number().positive().optional(),
});

export const SetPricingSchema = z.object({
  rules: z
    .array(PricingRuleInputSchema)
    .min(1, 'At least one pricing rule is required')
    .refine(
      (arr) => {
        const types = arr.map((r) => r.rate_type);
        return new Set(types).size === types.length;
      },
      { message: 'Duplicate rate_type entries are not allowed' }
    ),
});
export type SetPricingDto = z.infer<typeof SetPricingSchema>;

// ─────────────────────────────────────────────
// Route params
// ─────────────────────────────────────────────
export const SpaceIdParamSchema = z.object({
  id: z.string().uuid('Invalid space ID'),
});
export type SpaceIdParam = z.infer<typeof SpaceIdParamSchema>;

export const PhotoIdParamSchema = z.object({
  id: z.string().uuid('Invalid space ID'),
  photoId: z.string().uuid('Invalid photo ID'),
});
export type PhotoIdParam = z.infer<typeof PhotoIdParamSchema>;

export const BlackoutIdParamSchema = z.object({
  id: z.string().uuid('Invalid space ID'),
  dateId: z.string().uuid('Invalid blackout date ID'),
});
export type BlackoutIdParam = z.infer<typeof BlackoutIdParamSchema>;

// ─────────────────────────────────────────────
// GET /host/spaces — List spaces query
// ─────────────────────────────────────────────
export const ListSpacesQuerySchema = z.object({
  status: z
    .enum(['draft', 'pending_review', 'active', 'paused', 'rejected', 'deleted'])
    .optional(),
  page: z.string().optional().transform((v) => (v ? Math.max(1, parseInt(v, 10)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, parseInt(v, 10)) : 20)),
});
export type ListSpacesQuery = z.infer<typeof ListSpacesQuerySchema>;

// ─────────────────────────────────────────────
// GET /host/earnings — Earnings dashboard
// ─────────────────────────────────────────────
export const EarningsDashboardQuerySchema = z.object({
  period: z.enum(['daily', 'weekly', 'monthly']).optional().default('monthly'),
});
export type EarningsDashboardQuery = z.infer<typeof EarningsDashboardQuerySchema>;

// ─────────────────────────────────────────────
// GET /host/earnings/breakdown — Per-booking breakdown
// ─────────────────────────────────────────────
export const EarningsBreakdownQuerySchema = z.object({
  status: z.enum(['pending', 'available', 'paid_out', 'on_hold']).optional(),
  from:   z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'from must be a valid ISO date' }),
  to:     z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'to must be a valid ISO date' }),
  page:   z.string().optional().transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit:  z.string().optional().transform((v) => Math.min(100, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type EarningsBreakdownQuery = z.infer<typeof EarningsBreakdownQuerySchema>;

// ─────────────────────────────────────────────
// GET /host/earnings/tax-summary — Annual tax summary
// ─────────────────────────────────────────────
export const TaxSummaryQuerySchema = z.object({
  year: z
    .string({ required_error: 'year is required' })
    .regex(/^\d{4}$/, 'year must be a 4-digit number')
    .transform((v) => parseInt(v, 10))
    .refine((v) => v >= 2020 && v <= 2100, 'year must be between 2020 and 2100'),
});
export type TaxSummaryQuery = z.infer<typeof TaxSummaryQuerySchema>;

// ─────────────────────────────────────────────
// GET /host/payouts — Payout history query
// ─────────────────────────────────────────────
export const PayoutListQuerySchema = z.object({
  status: z.enum(['requested', 'processing', 'completed', 'failed']).optional(),
  page:   z.string().optional().transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit:  z.string().optional().transform((v) => Math.min(100, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type PayoutListQuery = z.infer<typeof PayoutListQuerySchema>;

// ─────────────────────────────────────────────
// POST /host/payouts/request — Request payout
// ─────────────────────────────────────────────
export const PayoutRequestSchema = z.object({
  bank_account_id: z.string({ required_error: 'bank_account_id is required' }).uuid('Invalid bank account ID'),
  amount:          z.number().positive('Amount must be positive').optional(),
});
export type PayoutRequestDto = z.infer<typeof PayoutRequestSchema>;

// ─────────────────────────────────────────────
// Route param — :id (payout)
// ─────────────────────────────────────────────
export const PayoutIdParamSchema = z.object({
  id: z.string().uuid('Invalid payout ID'),
});
export type PayoutIdParam = z.infer<typeof PayoutIdParamSchema>;

// ─────────────────────────────────────────────
// POST /host/bank-accounts — Add bank account
// ─────────────────────────────────────────────
export const AddBankAccountSchema = z.object({
  account_holder_name: z.string({ required_error: 'account_holder_name is required' }).min(2).max(200).trim(),
  account_number:      z.string({ required_error: 'account_number is required' }).min(8).max(20).regex(/^\d+$/, 'Account number must contain only digits'),
  ifsc_code:           z.string({ required_error: 'ifsc_code is required' }).length(11, 'IFSC code must be exactly 11 characters').regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code format'),
  bank_name:           z.string({ required_error: 'bank_name is required' }).min(2).max(100).trim(),
  is_default:          z.boolean().default(false),
});
export type AddBankAccountDto = z.infer<typeof AddBankAccountSchema>;

// ─────────────────────────────────────────────
// PATCH /host/bank-accounts/:id — Update bank account
// ─────────────────────────────────────────────
export const UpdateBankAccountSchema = z
  .object({
    account_holder_name: z.string().min(2).max(200).trim().optional(),
    bank_name:           z.string().min(2).max(100).trim().optional(),
    is_default:          z.boolean().optional(),
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: 'At least one field must be provided' }
  );
export type UpdateBankAccountDto = z.infer<typeof UpdateBankAccountSchema>;

// ─────────────────────────────────────────────
// Route param — :id (bank account)
// ─────────────────────────────────────────────
export const BankAccountIdParamSchema = z.object({
  id: z.string().uuid('Invalid bank account ID'),
});
export type BankAccountIdParam = z.infer<typeof BankAccountIdParamSchema>;

// ─────────────────────────────────────────────
// Slot management
// ─────────────────────────────────────────────

export const CreateSlotSchema = z.object({
  slot_number: z
    .string({ required_error: 'slot_number is required' })
    .min(1)
    .max(20)
    .trim()
    .toUpperCase(),
  notes: z.string().max(500).trim().optional(),
});
export type CreateSlotDto = z.infer<typeof CreateSlotSchema>;

export const UpdateSlotSchema = z
  .object({
    slot_number: z.string().min(1).max(20).trim().toUpperCase().optional(),
    is_active:   z.boolean().optional(),
    notes:       z.string().max(500).trim().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });
export type UpdateSlotDto = z.infer<typeof UpdateSlotSchema>;

// Combined :spaceId + :slotId param
export const SlotParamSchema = z.object({
  id:     z.string().uuid('Invalid space ID'),
  slotId: z.string().uuid('Invalid slot ID'),
});
export type SlotParam = z.infer<typeof SlotParamSchema>;
