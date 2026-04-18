import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import * as bookingService from './service';
import type {
  CheckAvailabilityDto,
  LockSlotDto,
  CreateBookingDto,
  ListBookingsQuery,
  BookingIdParam,
  ModifyBookingDto,
  ExtendBookingDto,
  VerifyExtensionPaymentDto,
  CancelBookingDto,
  RebookDto,
} from './validators';

// ─────────────────────────────────────────────
// POST /bookings/check-availability
// ─────────────────────────────────────────────
export async function checkAvailability(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await bookingService.checkAvailabilityWithPricing(req.body as CheckAvailabilityDto);
    Respond.ok(res, result);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /bookings/lock
// ─────────────────────────────────────────────
export async function lockSlot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await bookingService.lockSlot(req.body as LockSlotDto, req.user!.sub);
    Respond.ok(res, result, result.message);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// DELETE /bookings/lock
// ─────────────────────────────────────────────
export async function releaseLock(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await bookingService.releaseLock(req.body as LockSlotDto, req.user!.sub);
    Respond.ok(res, result, result.message);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /bookings
// ─────────────────────────────────────────────
export async function createBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await bookingService.createBooking(req.body as CreateBookingDto, req.user!.sub);
    Respond.created(res, result, 'Booking created successfully');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /bookings
// ─────────────────────────────────────────────
export async function listBookings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as ListBookingsQuery;
    const { bookings, meta } = await bookingService.listBookings(req.user!.sub, query);
    Respond.ok(res, bookings, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /bookings/:id
// ─────────────────────────────────────────────
export async function getBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const booking = await bookingService.getBooking(req.user!.sub, id);
    Respond.ok(res, booking);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /bookings/:id
// ─────────────────────────────────────────────
export async function modifyBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const result = await bookingService.modifyBooking(req.user!.sub, id, req.body as ModifyBookingDto);
    Respond.ok(res, result, 'Booking modified successfully');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /bookings/:id/extend
// ─────────────────────────────────────────────
export async function extendBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const result = await bookingService.extendBooking(req.user!.sub, id, req.body as ExtendBookingDto);
    Respond.ok(res, result, 'Extension order created');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /bookings/:id/extend/verify
// ─────────────────────────────────────────────
export async function verifyExtensionPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const result = await bookingService.verifyExtensionPayment(req.user!.sub, id, req.body as VerifyExtensionPaymentDto);
    Respond.ok(res, result, 'Booking extended successfully');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /bookings/:id/cancel
// ─────────────────────────────────────────────
export async function cancelBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const result = await bookingService.cancelBooking(req.user!.sub, id, req.body as CancelBookingDto);
    Respond.ok(res, result, 'Booking cancelled');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /bookings/:id/rebook
// ─────────────────────────────────────────────
export async function rebookBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const result = await bookingService.rebookBooking(req.user!.sub, id, req.body as RebookDto);
    Respond.created(res, result, 'Booking created from rebook');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /bookings/:id/receipt
// ─────────────────────────────────────────────
export async function downloadReceipt(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const buffer = await bookingService.generateReceiptPdf(req.user!.sub, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="justpark-receipt-${id}.pdf"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) { next(err); }
}
