import { z } from 'zod';

// ─────────────────────────────────────────────
// Shared field
// ─────────────────────────────────────────────
const isoDateField = (label: string) =>
  z.string({ required_error: `${label} is required` })
   .refine((v) => !isNaN(Date.parse(v)), `${label} must be a valid ISO date-time`);

// ─────────────────────────────────────────────
// POST /bookings/check-availability
// ─────────────────────────────────────────────
export const CheckAvailabilitySchema = z
  .object({
    space_id:   z.string({ required_error: 'space_id is required' }).uuid('Invalid space ID'),
    start_time: isoDateField('start_time'),
    end_time:   isoDateField('end_time'),
  })
  .refine((d) => new Date(d.start_time) < new Date(d.end_time), {
    message: 'end_time must be after start_time',
    path: ['end_time'],
  });
export type CheckAvailabilityDto = z.infer<typeof CheckAvailabilitySchema>;

// ─────────────────────────────────────────────
// POST /bookings/lock
// ─────────────────────────────────────────────
export const LockSlotSchema = z
  .object({
    space_id:   z.string({ required_error: 'space_id is required' }).uuid('Invalid space ID'),
    start_time: isoDateField('start_time'),
    end_time:   isoDateField('end_time'),
    // Optional: request a specific slot. If omitted, the first available slot is auto-assigned.
    slot_id:    z.string().uuid('Invalid slot ID').optional(),
  })
  .refine((d) => new Date(d.start_time) < new Date(d.end_time), {
    message: 'end_time must be after start_time',
    path: ['end_time'],
  })
  .refine((d) => new Date(d.start_time) > new Date(), {
    message: 'start_time must be in the future',
    path: ['start_time'],
  });
export type LockSlotDto = z.infer<typeof LockSlotSchema>;

// ─────────────────────────────────────────────
// POST /bookings
// ─────────────────────────────────────────────
export const CreateBookingSchema = z
  .object({
    space_id:   z.string({ required_error: 'space_id is required' }).uuid('Invalid space ID'),
    slot_id:    z.string({ required_error: 'slot_id is required — obtain it from the /bookings/lock response' }).uuid('Invalid slot ID'),
    vehicle_id: z.string({ required_error: 'vehicle_id is required' }).uuid('Invalid vehicle ID'),
    start_time: isoDateField('start_time'),
    end_time:   isoDateField('end_time'),
    promo_code: z.string().max(50).trim().toUpperCase().optional(),
    host_note:  z.string().max(500).trim().optional(),
  })
  .refine((d) => new Date(d.start_time) < new Date(d.end_time), {
    message: 'end_time must be after start_time',
    path: ['end_time'],
  })
  .refine((d) => new Date(d.start_time) > new Date(), {
    message: 'start_time must be in the future',
    path: ['start_time'],
  });
export type CreateBookingDto = z.infer<typeof CreateBookingSchema>;

// ─────────────────────────────────────────────
// GET /bookings — list query
// ─────────────────────────────────────────────
export const ListBookingsQuerySchema = z.object({
  status: z
    .enum(['pending', 'confirmed', 'active', 'completed', 'cancelled', 'no_show', 'disputed'])
    .optional(),
  filter: z.enum(['upcoming', 'past', 'active']).optional(),
  page:   z.string().optional().transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit:  z.string().optional().transform((v) => Math.min(100, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type ListBookingsQuery = z.infer<typeof ListBookingsQuerySchema>;

// ─────────────────────────────────────────────
// Route param — :id
// ─────────────────────────────────────────────
export const BookingIdParamSchema = z.object({
  id: z.string().uuid('Invalid booking ID'),
});
export type BookingIdParam = z.infer<typeof BookingIdParamSchema>;

// ─────────────────────────────────────────────
// PATCH /bookings/:id — modify (change end_time)
// ─────────────────────────────────────────────
export const ModifyBookingSchema = z.object({
  end_time: isoDateField('end_time'),
});
export type ModifyBookingDto = z.infer<typeof ModifyBookingSchema>;

// ─────────────────────────────────────────────
// POST /bookings/:id/extend
// ─────────────────────────────────────────────
export const ExtendBookingSchema = z.object({
  extension_hours: z
    .number({ required_error: 'extension_hours is required' })
    .int('extension_hours must be an integer')
    .min(1, 'Extension must be at least 1 hour')
    .max(3, 'Extension cannot exceed 3 hours'),
});
export type ExtendBookingDto = z.infer<typeof ExtendBookingSchema>;

// ─────────────────────────────────────────────
// POST /bookings/:id/extend/verify
// ─────────────────────────────────────────────
export const VerifyExtensionPaymentSchema = z.object({
  razorpay_order_id:   z.string({ required_error: 'razorpay_order_id is required' }).min(1),
  razorpay_payment_id: z.string({ required_error: 'razorpay_payment_id is required' }).min(1),
  razorpay_signature:  z.string({ required_error: 'razorpay_signature is required' }).min(1),
});
export type VerifyExtensionPaymentDto = z.infer<typeof VerifyExtensionPaymentSchema>;

// ─────────────────────────────────────────────
// POST /bookings/:id/cancel
// ─────────────────────────────────────────────
export const CancelBookingSchema = z.object({
  reason: z.string().max(500).trim().optional(),
});
export type CancelBookingDto = z.infer<typeof CancelBookingSchema>;

// ─────────────────────────────────────────────
// POST /bookings/:id/rebook
// ─────────────────────────────────────────────
export const RebookSchema = z
  .object({
    slot_id:    z.string({ required_error: 'slot_id is required — obtain it from POST /bookings/lock' }).uuid('Invalid slot ID'),
    start_time: isoDateField('start_time'),
    end_time:   isoDateField('end_time'),
  })
  .refine((d) => new Date(d.start_time) < new Date(d.end_time), {
    message: 'end_time must be after start_time',
    path: ['end_time'],
  })
  .refine((d) => new Date(d.start_time) > new Date(), {
    message: 'start_time must be in the future',
    path: ['start_time'],
  });
export type RebookDto = z.infer<typeof RebookSchema>;

// ─────────────────────────────────────────────
// Host: PATCH /host/bookings/:id/reject
// ─────────────────────────────────────────────
export const RejectBookingSchema = z.object({
  reason: z
    .string({ required_error: 'Rejection reason is required' })
    .min(1)
    .max(500)
    .trim(),
});
export type RejectBookingDto = z.infer<typeof RejectBookingSchema>;

// ─────────────────────────────────────────────
// Host: POST /host/bookings/:id/cancel
// ─────────────────────────────────────────────
export const HostCancelBookingSchema = z.object({
  reason: z
    .string({ required_error: 'Cancellation reason is required' })
    .min(1)
    .max(500)
    .trim(),
});
export type HostCancelBookingDto = z.infer<typeof HostCancelBookingSchema>;

// ─────────────────────────────────────────────
// Host: GET /host/bookings
// ─────────────────────────────────────────────
export const HostListBookingsQuerySchema = z.object({
  space_id: z.string().uuid().optional(),
  status:   z
    .enum(['pending', 'confirmed', 'active', 'completed', 'cancelled', 'no_show', 'disputed'])
    .optional(),
  page:  z.string().optional().transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit: z.string().optional().transform((v) => Math.min(100, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type HostListBookingsQuery = z.infer<typeof HostListBookingsQuerySchema>;
