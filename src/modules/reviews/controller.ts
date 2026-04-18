import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import * as service from './service';
import type {
  CreateReviewDto,
  UpdateReviewDto,
  ReviewIdParam,
  RespondToReviewDto,
  ReportReviewDto,
  ListFlaggedReviewsQuery,
} from './validators';

// ─────────────────────────────────────────────
// POST /reviews
// ─────────────────────────────────────────────
export async function submitReview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.submitReview(req.user!.sub, req.body as CreateReviewDto);
    Respond.created(res, result, result.auto_flagged
      ? 'Review submitted and flagged for moderation'
      : 'Review submitted successfully'
    );
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /reviews/:id
// ─────────────────────────────────────────────
export async function editReview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as ReviewIdParam;
    const review = await service.editReview(req.user!.sub, id, req.body as UpdateReviewDto);
    Respond.ok(res, review, 'Review updated');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /reviews/:id/respond
// ─────────────────────────────────────────────
export async function respondToReview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as ReviewIdParam;
    const response = await service.respondToReview(req.user!.sub, id, req.body as RespondToReviewDto);
    Respond.created(res, response, 'Response submitted');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /reviews/:id/report
// ─────────────────────────────────────────────
export async function reportReview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as ReviewIdParam;
    const result = await service.reportReview(req.user!.sub, id, req.body as ReportReviewDto);
    Respond.ok(res, result, 'Review reported and flagged for moderation');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// DELETE /admin/reviews/:id
// ─────────────────────────────────────────────
export async function adminRemoveReview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as ReviewIdParam;
    const result = await service.adminRemoveReview(req.user!.sub, id);
    Respond.ok(res, result, 'Review removed');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /admin/reviews/flagged
// ─────────────────────────────────────────────
export async function listFlaggedReviews(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as ListFlaggedReviewsQuery;
    const { reviews, meta } = await service.listFlaggedReviews(query);
    Respond.ok(res, reviews, undefined, meta);
  } catch (err) { next(err); }
}
