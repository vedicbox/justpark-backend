import { z } from 'zod';

// ─────────────────────────────────────────────
// GET /support/faq — searchable FAQ list
// ─────────────────────────────────────────────
export const FaqQuerySchema = z.object({
  q:        z.string().max(200).optional(),
  category: z.string().max(100).optional(),
});
export type FaqQuery = z.infer<typeof FaqQuerySchema>;

// ─────────────────────────────────────────────
// POST /support/tickets — create ticket
// ─────────────────────────────────────────────
export const CreateTicketSchema = z.object({
  category:   z.enum(['booking', 'payment', 'account', 'space', 'dispute', 'other']),
  subject:    z.string({ required_error: 'Subject is required' }).min(5).max(255).trim(),
  description: z.string({ required_error: 'Description is required' }).min(10).max(5000).trim(),
  booking_id: z.string().uuid('Invalid booking ID').optional(),
});
export type CreateTicketDto = z.infer<typeof CreateTicketSchema>;

// ─────────────────────────────────────────────
// GET /support/tickets — list query
// ─────────────────────────────────────────────
export const ListTicketsQuerySchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  page:   z.string().optional().transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit:  z.string().optional().transform((v) => Math.min(50, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type ListTicketsQuery = z.infer<typeof ListTicketsQuerySchema>;

// ─────────────────────────────────────────────
// Route param — :id (ticket)
// ─────────────────────────────────────────────
export const TicketIdParamSchema = z.object({
  id: z.string().uuid('Invalid ticket ID'),
});
export type TicketIdParam = z.infer<typeof TicketIdParamSchema>;

// ─────────────────────────────────────────────
// POST /support/tickets/:id/messages — add message
// ─────────────────────────────────────────────
export const AddTicketMessageSchema = z.object({
  message: z.string({ required_error: 'Message is required' }).min(1).max(5000).trim(),
});
export type AddTicketMessageDto = z.infer<typeof AddTicketMessageSchema>;

// ─────────────────────────────────────────────
// POST /support/disputes — raise dispute
// ─────────────────────────────────────────────
export const CreateDisputeSchema = z.object({
  booking_id: z.string({ required_error: 'Booking ID is required' }).uuid('Invalid booking ID'),
  reason:     z.string({ required_error: 'Reason is required' }).min(10).max(5000).trim(),
});
export type CreateDisputeDto = z.infer<typeof CreateDisputeSchema>;

// ─────────────────────────────────────────────
// Admin — GET /admin/tickets — list all tickets
// ─────────────────────────────────────────────
export const AdminListTicketsQuerySchema = z.object({
  status:      z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  priority:    z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  assigned_to: z.string().uuid('Invalid user ID').optional(),
  page:        z.string().optional().transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit:       z.string().optional().transform((v) => Math.min(100, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type AdminListTicketsQuery = z.infer<typeof AdminListTicketsQuerySchema>;

// ─────────────────────────────────────────────
// Admin — PATCH /admin/tickets/:id — assign / update ticket
// ─────────────────────────────────────────────
export const AdminUpdateTicketSchema = z.object({
  status:      z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  priority:    z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  assigned_to: z.string().uuid('Invalid admin ID').nullable().optional(),
  note:        z.string().max(2000).trim().optional(), // admin message appended to thread
}).refine(
  (d) => d.status !== undefined || d.priority !== undefined || d.assigned_to !== undefined || d.note !== undefined,
  { message: 'At least one field must be provided' }
);
export type AdminUpdateTicketDto = z.infer<typeof AdminUpdateTicketSchema>;

// ─────────────────────────────────────────────
// Admin — PATCH /admin/disputes/:id/resolve
// ─────────────────────────────────────────────
export const AdminResolveDisputeSchema = z.object({
  resolution:      z.string({ required_error: 'Resolution notes are required' }).min(10).max(5000).trim(),
  resolution_type: z.enum(['refund', 'partial_refund', 'no_action', 'credit']),
  refund_amount:   z.number().positive('Refund amount must be positive').optional(),
});
export type AdminResolveDisputeDto = z.infer<typeof AdminResolveDisputeSchema>;

// ─────────────────────────────────────────────
// Route param — :id (dispute)
// ─────────────────────────────────────────────
export const DisputeIdParamSchema = z.object({
  id: z.string().uuid('Invalid dispute ID'),
});
export type DisputeIdParam = z.infer<typeof DisputeIdParamSchema>;
