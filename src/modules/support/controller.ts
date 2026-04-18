import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import * as service from './service';
import type { UploadedFile } from '../../services/fileUpload';
import {
  FaqQuerySchema,
  CreateTicketSchema,
  ListTicketsQuerySchema,
  TicketIdParamSchema,
  AddTicketMessageSchema,
  CreateDisputeSchema,
  AdminListTicketsQuerySchema,
  AdminUpdateTicketSchema,
  AdminResolveDisputeSchema,
  DisputeIdParamSchema,
} from './validators';

// ─────────────────────────────────────────────
// GET /support/faq
// ─────────────────────────────────────────────
export async function getFaqs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = FaqQuerySchema.parse(req.query);
    const result = await service.getFaqs(query);
    Respond.ok(res, result);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /support/tickets
// ─────────────────────────────────────────────
export async function createTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = CreateTicketSchema.parse(req.body);
    const ticket = await service.createTicket(
      req.user!.sub,
      body,
      req.file as UploadedFile | undefined
    );
    Respond.created(res, ticket, 'Support ticket created');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /support/tickets
// ─────────────────────────────────────────────
export async function listTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = ListTicketsQuerySchema.parse(req.query);
    const { tickets, meta } = await service.listTickets(req.user!.sub, query);
    Respond.ok(res, tickets, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /support/tickets/:id
// ─────────────────────────────────────────────
export async function getTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = TicketIdParamSchema.parse(req.params);
    const ticket = await service.getTicket(req.user!.sub, id);
    Respond.ok(res, ticket);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /support/tickets/:id/messages
// ─────────────────────────────────────────────
export async function addMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = TicketIdParamSchema.parse(req.params);
    const body = AddTicketMessageSchema.parse(req.body);
    const senderRole = req.user!.role;
    const message = await service.addTicketMessage(req.user!.sub, id, body, senderRole);
    Respond.created(res, message, 'Message sent');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /support/disputes
// ─────────────────────────────────────────────
export async function createDispute(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = CreateDisputeSchema.parse(req.body);
    const result = await service.createDispute(req.user!.sub, body);
    Respond.created(res, result, 'Dispute raised successfully');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// Admin — GET /admin/tickets
// ─────────────────────────────────────────────
export async function adminListTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = AdminListTicketsQuerySchema.parse(req.query);
    const { tickets, meta } = await service.adminListTickets(query);
    Respond.ok(res, tickets, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// Admin — PATCH /admin/tickets/:id
// ─────────────────────────────────────────────
export async function adminUpdateTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = TicketIdParamSchema.parse(req.params);
    const body = AdminUpdateTicketSchema.parse(req.body);
    const ticket = await service.adminUpdateTicket(req.user!.sub, id, body);
    Respond.ok(res, ticket, 'Ticket updated');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// Admin — GET /admin/disputes
// ─────────────────────────────────────────────
export async function adminListDisputes(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page  = Math.max(1, Number(req.query['page'])  || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query['limit']) || 20));
    const status = req.query['status'] as string | undefined;
    const { disputes, meta } = await service.adminListDisputes({ status, page, limit });
    Respond.ok(res, disputes, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// Admin — PATCH /admin/disputes/:id/resolve
// ─────────────────────────────────────────────
export async function adminResolveDispute(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = DisputeIdParamSchema.parse(req.params);
    const body = AdminResolveDisputeSchema.parse(req.body);
    const result = await service.adminResolveDispute(req.user!.sub, id, body);
    Respond.ok(res, result, 'Dispute resolved');
  } catch (err) { next(err); }
}
