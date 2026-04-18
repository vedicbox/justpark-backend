import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import { buildPaginationMeta } from '../../utils/pagination';
import * as hostService from './service';
import * as bookingService from '../bookings/service';
import { AppError } from '../../middleware/errorHandler';
import type { UploadedFile } from '../../services/fileUpload';
import type {
  CreateSpaceDto,
  UpdateSpaceDto,
  SetScheduleDto,
  AddBlackoutDto,
  SetPricingDto,
  SpaceIdParam,
  PhotoIdParam,
  BlackoutIdParam,
  ListSpacesQuery,
  EarningsBreakdownQuery,
  TaxSummaryQuery,
  PayoutListQuery,
  PayoutRequestDto,
  AddBankAccountDto,
  UpdateBankAccountDto,
  BankAccountIdParam,
  CreateSlotDto,
  UpdateSlotDto,
  SlotParam,
} from './validators';
import type {
  HostListBookingsQuery,
  BookingIdParam,
  RejectBookingDto,
  HostCancelBookingDto,
} from '../bookings/validators';

// ─────────────────────────────────────────────
// POST /host/spaces
// ─────────────────────────────────────────────
export async function createSpace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const space = await hostService.createSpace(req.user!.sub, req.body as CreateSpaceDto);
    Respond.created(res, space, 'Space listing created as draft');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /host/spaces
// ─────────────────────────────────────────────
export async function listSpaces(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as ListSpacesQuery;
    const { spaces, total, page, limit } = await hostService.listSpaces(req.user!.sub, query);
    Respond.ok(res, spaces, undefined, buildPaginationMeta(total, page, limit));
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /host/spaces/:id
// ─────────────────────────────────────────────
export async function getSpace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const space = await hostService.getSpace(req.user!.sub, id);
    Respond.ok(res, space);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /host/spaces/:id
// ─────────────────────────────────────────────
export async function updateSpace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const space = await hostService.updateSpace(req.user!.sub, id, req.body as UpdateSpaceDto);
    Respond.ok(res, space, 'Space updated successfully');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/submit
// ─────────────────────────────────────────────
export async function submitSpace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const space = await hostService.submitSpace(req.user!.sub, id);
    Respond.ok(res, space, 'Space submitted for admin review');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/pause
// ─────────────────────────────────────────────
export async function pauseSpace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const space = await hostService.pauseSpace(req.user!.sub, id);
    Respond.ok(res, space, 'Space paused');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/unpause
// ─────────────────────────────────────────────
export async function unpauseSpace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const space = await hostService.unpauseSpace(req.user!.sub, id);
    Respond.ok(res, space, 'Space resumed');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// DELETE /host/spaces/:id
// ─────────────────────────────────────────────
export async function deleteSpace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    await hostService.deleteSpace(req.user!.sub, id);
    Respond.ok(res, null, 'Space deleted');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/photos
// ─────────────────────────────────────────────
export async function addPhoto(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.file) {
      throw AppError.badRequest('VALIDATION_ERROR', 'No file uploaded. Send an image as multipart/form-data with field "photo".');
    }
    const { id } = req.params as unknown as SpaceIdParam;
    const photo = await hostService.addPhoto(req.user!.sub, id, req.file as UploadedFile);
    Respond.created(res, photo, 'Photo uploaded successfully');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// DELETE /host/spaces/:id/photos/:photoId
// ─────────────────────────────────────────────
export async function removePhoto(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id, photoId } = req.params as unknown as PhotoIdParam;
    await hostService.removePhoto(req.user!.sub, id, photoId);
    Respond.ok(res, null, 'Photo removed');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /host/spaces/:id/schedule
// ─────────────────────────────────────────────
export async function getSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const schedule = await hostService.getSchedule(req.user!.sub, id);
    Respond.ok(res, schedule);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PUT /host/spaces/:id/schedule
// ─────────────────────────────────────────────
export async function setSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const schedule = await hostService.setSchedule(req.user!.sub, id, req.body as SetScheduleDto);
    Respond.ok(res, schedule, 'Schedule updated');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /host/spaces/:id/blackout
// ─────────────────────────────────────────────
export async function getBlackoutDates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const dates = await hostService.getBlackoutDates(req.user!.sub, id);
    Respond.ok(res, dates);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/blackout
// ─────────────────────────────────────────────
export async function addBlackout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const blackout = await hostService.addBlackout(req.user!.sub, id, req.body as AddBlackoutDto);
    Respond.created(res, blackout, 'Blackout date added');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// DELETE /host/spaces/:id/blackout/:dateId
// ─────────────────────────────────────────────
export async function removeBlackout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id, dateId } = req.params as unknown as BlackoutIdParam;
    await hostService.removeBlackout(req.user!.sub, id, dateId);
    Respond.ok(res, null, 'Blackout date removed');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /host/spaces/:id/pricing
// ─────────────────────────────────────────────
export async function getPricing(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const rules = await hostService.getPricing(req.user!.sub, id);
    Respond.ok(res, rules);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PUT /host/spaces/:id/pricing
// ─────────────────────────────────────────────
export async function setPricing(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const rules = await hostService.setPricing(req.user!.sub, id, req.body as SetPricingDto);
    Respond.ok(res, rules, 'Pricing rules updated');
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// HOST BOOKING MANAGEMENT
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /host/bookings
// ─────────────────────────────────────────────
export async function listHostBookings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as HostListBookingsQuery;
    const { bookings, meta } = await bookingService.listHostBookings(req.user!.sub, query);
    Respond.ok(res, bookings, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /host/bookings/:id
// ─────────────────────────────────────────────
export async function getHostBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const booking = await bookingService.getHostBooking(req.user!.sub, id);
    Respond.ok(res, booking);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /host/bookings/:id/approve
// ─────────────────────────────────────────────
export async function approveBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const booking = await bookingService.approveBooking(req.user!.sub, id);
    Respond.ok(res, booking, 'Booking approved');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /host/bookings/:id/invoice
// ─────────────────────────────────────────────
export async function downloadBookingInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const buffer = await hostService.generateHostInvoice(req.user!.sub, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="justpark-invoice-${id}.pdf"`);
    res.send(buffer);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /host/bookings/:id/reject
// ─────────────────────────────────────────────
export async function rejectBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const result = await bookingService.rejectBooking(req.user!.sub, id, req.body as RejectBookingDto);
    Respond.ok(res, result, 'Booking rejected');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /host/bookings/:id/cancel
// ─────────────────────────────────────────────
export async function hostCancelBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BookingIdParam;
    const result = await bookingService.hostCancelBooking(req.user!.sub, id, req.body as HostCancelBookingDto);
    Respond.ok(res, result, 'Booking cancelled');
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// EARNINGS
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /host/earnings
// ─────────────────────────────────────────────
export async function getEarningsDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await hostService.getEarningsDashboard(req.user!.sub);
    Respond.ok(res, result);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /host/earnings/breakdown
// ─────────────────────────────────────────────
export async function getEarningsBreakdown(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as EarningsBreakdownQuery;
    const { earnings, meta } = await hostService.getEarningsBreakdown(req.user!.sub, query);
    Respond.ok(res, earnings, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// GET /host/earnings/tax-summary
// ─────────────────────────────────────────────
export async function getTaxSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as TaxSummaryQuery;
    const result = await hostService.getTaxSummary(req.user!.sub, query);
    Respond.ok(res, result);
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// PAYOUTS
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /host/payouts
// ─────────────────────────────────────────────
export async function listPayouts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as PayoutListQuery;
    const { payouts, meta } = await hostService.listPayouts(req.user!.sub, query);
    Respond.ok(res, payouts, undefined, meta);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /host/payouts/request
// ─────────────────────────────────────────────
export async function requestPayout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await hostService.requestPayout(req.user!.sub, req.body as PayoutRequestDto);
    Respond.created(res, result, 'Payout request submitted');
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// BANK ACCOUNTS
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /host/bank-accounts
// ─────────────────────────────────────────────
export async function listBankAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const accounts = await hostService.listBankAccounts(req.user!.sub);
    Respond.ok(res, accounts);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /host/bank-accounts
// ─────────────────────────────────────────────
export async function addBankAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const account = await hostService.addBankAccount(req.user!.sub, req.body as AddBankAccountDto);
    Respond.created(res, account, 'Bank account added');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /host/bank-accounts/:id/retry
// ─────────────────────────────────────────────
export async function retryBankAccountVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BankAccountIdParam;
    const account = await hostService.retryBankAccountVerification(req.user!.sub, id);
    Respond.ok(res, account, 'Bank account verification retried');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /host/bank-accounts/:id
// ─────────────────────────────────────────────
export async function updateBankAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BankAccountIdParam;
    const account = await hostService.updateBankAccount(req.user!.sub, id, req.body as UpdateBankAccountDto);
    Respond.ok(res, account, 'Bank account updated');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// DELETE /host/bank-accounts/:id
// ─────────────────────────────────────────────
export async function deleteBankAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as BankAccountIdParam;
    await hostService.deleteBankAccount(req.user!.sub, id);
    Respond.ok(res, null, 'Bank account removed');
  } catch (err) { next(err); }
}

// ═════════════════════════════════════════════
// ANALYTICS
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /host/analytics
// ─────────────────────────────────────────────
export async function getHostAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await hostService.getHostAnalytics(req.user!.sub);
    Respond.ok(res, result);
  } catch (err) { next(err); }
}


// ═════════════════════════════════════════════
// SLOT MANAGEMENT
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /host/spaces/:id/slots
// ─────────────────────────────────────────────
export async function listSlots(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const slots = await hostService.listSlots(req.user!.sub, id);
    Respond.ok(res, slots);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// POST /host/spaces/:id/slots
// ─────────────────────────────────────────────
export async function createSlot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as SpaceIdParam;
    const slot = await hostService.createSlot(req.user!.sub, id, req.body as CreateSlotDto);
    Respond.created(res, slot, 'Slot created');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// PATCH /host/spaces/:id/slots/:slotId
// ─────────────────────────────────────────────
export async function updateSlot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id, slotId } = req.params as unknown as SlotParam;
    const slot = await hostService.updateSlot(req.user!.sub, id, slotId, req.body as UpdateSlotDto);
    Respond.ok(res, slot, 'Slot updated');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────
// DELETE /host/spaces/:id/slots/:slotId
// ─────────────────────────────────────────────
export async function deleteSlot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id, slotId } = req.params as unknown as SlotParam;
    const result = await hostService.deleteSlot(req.user!.sub, id, slotId);
    Respond.ok(res, result, 'Slot deleted');
  } catch (err) { next(err); }
}
