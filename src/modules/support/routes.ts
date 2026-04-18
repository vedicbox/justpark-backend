import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { ErrorCode } from '../../types';
import { validate } from '../../middleware/validate';
import * as controller from './controller';
import {
  FaqQuerySchema,
  CreateTicketSchema,
  ListTicketsQuerySchema,
  TicketIdParamSchema,
  AddTicketMessageSchema,
  CreateDisputeSchema,
} from './validators';

export const supportRouter = Router();

const ticketUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Only JPEG, PNG, and WebP images are allowed'));
  },
});

// ─────────────────────────────────────────────
// Public routes
// ─────────────────────────────────────────────

/**
 * GET /support/faq
 * Retrieve FAQ articles. Optional ?q= full-text search, ?category= filter.
 */
supportRouter.get('/faq', validate(FaqQuerySchema, 'query'), controller.getFaqs);

// ─────────────────────────────────────────────
// Authenticated routes
// ─────────────────────────────────────────────
supportRouter.use(authenticate);

/**
 * POST /support/tickets
 * Open a new support ticket. Optional bookingId links it to a specific booking.
 */
supportRouter.post(
  '/tickets',
  ticketUpload.single('attachment'),
  validate(CreateTicketSchema),
  controller.createTicket
);

/**
 * GET /support/tickets
 * List the authenticated user's tickets. Filter by ?status=
 */
supportRouter.get(
  '/tickets',
  validate(ListTicketsQuerySchema, 'query'),
  controller.listTickets
);

/**
 * GET /support/tickets/:id
 * Full ticket detail including message thread.
 */
supportRouter.get(
  '/tickets/:id',
  validate(TicketIdParamSchema, 'params'),
  controller.getTicket
);

/**
 * POST /support/tickets/:id/messages
 * Add a message to the ticket thread.
 */
supportRouter.post(
  '/tickets/:id/messages',
  validate(TicketIdParamSchema, 'params'),
  validate(AddTicketMessageSchema),
  controller.addMessage
);

/**
 * POST /support/disputes
 * Raise a dispute for a completed or cancelled booking.
 * Creates a linked SupportTicket + Dispute and puts host earnings on hold.
 */
supportRouter.post(
  '/disputes',
  validate(CreateDisputeSchema),
  controller.createDispute
);
