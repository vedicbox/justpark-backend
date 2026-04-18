import { z } from 'zod';

// ─────────────────────────────────────────────
// POST /reviews — submit review
// ─────────────────────────────────────────────
export const CreateReviewSchema = z.object({
  booking_id: z.string({ required_error: 'booking_id is required' }).uuid('Invalid booking ID'),
  rating:     z.number({ required_error: 'rating is required' })
               .int('Rating must be an integer')
               .min(1, 'Rating must be at least 1')
               .max(5, 'Rating must be at most 5'),
  body:       z.string().max(1000, 'Review body must not exceed 1000 characters').trim().optional(),
});
export type CreateReviewDto = z.infer<typeof CreateReviewSchema>;

// ─────────────────────────────────────────────
// PATCH /reviews/:id — edit review
// ─────────────────────────────────────────────
export const UpdateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  body:   z.string().max(1000).trim().optional(),
}).refine((d) => d.rating !== undefined || d.body !== undefined, {
  message: 'At least one of rating or body must be provided',
});
export type UpdateReviewDto = z.infer<typeof UpdateReviewSchema>;

// ─────────────────────────────────────────────
// Route param — :id
// ─────────────────────────────────────────────
export const ReviewIdParamSchema = z.object({
  id: z.string().uuid('Invalid review ID'),
});
export type ReviewIdParam = z.infer<typeof ReviewIdParamSchema>;

// ─────────────────────────────────────────────
// POST /reviews/:id/respond
// ─────────────────────────────────────────────
export const RespondToReviewSchema = z.object({
  body: z.string({ required_error: 'Response body is required' })
         .min(1, 'Response cannot be empty')
         .max(1000)
         .trim(),
});
export type RespondToReviewDto = z.infer<typeof RespondToReviewSchema>;

// ─────────────────────────────────────────────
// POST /reviews/:id/report
// ─────────────────────────────────────────────
export const ReportReviewSchema = z.object({
  reason: z.string({ required_error: 'Reason is required' })
           .min(1, 'Reason cannot be empty')
           .max(500)
           .trim(),
});
export type ReportReviewDto = z.infer<typeof ReportReviewSchema>;

// ─────────────────────────────────────────────
// GET /admin/reviews/flagged — list flagged reviews
// ─────────────────────────────────────────────
export const ListFlaggedReviewsQuerySchema = z.object({
  page:  z.string().optional().transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit: z.string().optional().transform((v) => Math.min(50, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type ListFlaggedReviewsQuery = z.infer<typeof ListFlaggedReviewsQuerySchema>;
