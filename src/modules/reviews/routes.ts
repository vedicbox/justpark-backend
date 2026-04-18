import express, { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { isHost } from '../../middleware/roleGuard';
import { validate } from '../../middleware/validate';
import * as controller from './controller';
import {
  CreateReviewSchema,
  UpdateReviewSchema,
  ReviewIdParamSchema,
  RespondToReviewSchema,
  ReportReviewSchema,
} from './validators';

export const reviewsRouter = Router();

// Tighter body-size limit for data-only routes (rating + comment text — no files).
// Acts as a defence-in-depth backstop: effective immediately if the global 5 MB parser
// in app.ts is ever removed or re-scoped to upload routes only.
reviewsRouter.use(express.json({ limit: '10kb' }));

// All review routes require authentication
reviewsRouter.use(authenticate);

/**
 * POST /reviews
 * Submit a review for a completed booking.
 * One review per booking; auto-flagged if profanity detected.
 */
reviewsRouter.post(
  '/',
  validate(CreateReviewSchema),
  controller.submitReview
);

/**
 * PATCH /reviews/:id
 * Edit your own review within 24 hours of submission.
 */
reviewsRouter.patch(
  '/:id',
  validate(ReviewIdParamSchema, 'params'),
  validate(UpdateReviewSchema),
  controller.editReview
);

/**
 * POST /reviews/:id/respond
 * Host responds to a review on their space. One response per review.
 */
reviewsRouter.post(
  '/:id/respond',
  isHost,
  validate(ReviewIdParamSchema, 'params'),
  validate(RespondToReviewSchema),
  controller.respondToReview
);

/**
 * POST /reviews/:id/report
 * Flag a review as abusive. Creates a moderation queue entry.
 */
reviewsRouter.post(
  '/:id/report',
  validate(ReviewIdParamSchema, 'params'),
  validate(ReportReviewSchema),
  controller.reportReview
);
