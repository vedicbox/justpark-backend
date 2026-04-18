import { Request, Response, NextFunction } from 'express';
import { Respond } from '../../utils/response';
import * as userService from './service';
import type { UpdateProfileDto, CreateVehicleDto, UpdateVehicleDto, VehicleIdParam, SubmitKycDto } from './validators';
import type { UploadedFile } from '../../services/fileUpload';
import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────
// GET /users/me
// ─────────────────────────────────────────────
export async function getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const profile = await userService.getProfile(req.user!.sub);
    Respond.ok(res, profile);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// PATCH /users/me
// ─────────────────────────────────────────────
export async function updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as UpdateProfileDto;
    const updated = await userService.updateProfile(req.user!.sub, dto);
    Respond.ok(res, updated, 'Profile updated successfully');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /users/me/avatar
// ─────────────────────────────────────────────
export async function uploadAvatar(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.file) {
      throw AppError.badRequest(
        'VALIDATION_ERROR',
        'No file uploaded. Send an image as multipart/form-data with field "avatar".'
      );
    }

    const file = req.file as UploadedFile;
    const updated = await userService.uploadAvatar(req.user!.sub, file);
    Respond.ok(res, { avatar_url: updated.avatar_url }, 'Avatar updated successfully');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /users/me/kyc
// ─────────────────────────────────────────────
export async function submitKyc(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.file) {
      throw AppError.badRequest(
        'VALIDATION_ERROR',
        'No document uploaded. Send an image as multipart/form-data with field "document".'
      );
    }
    const dto  = req.body as SubmitKycDto;
    const file = req.file as UploadedFile;
    const doc  = await userService.submitKyc(req.user!.sub, dto, file);
    Respond.created(res, doc, 'KYC document submitted for review');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// GET /users/me/vehicles
// ─────────────────────────────────────────────
export async function getVehicles(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const vehicles = await userService.getVehicles(req.user!.sub);
    Respond.ok(res, vehicles);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /users/me/vehicles
// ─────────────────────────────────────────────
export async function createVehicle(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = req.body as CreateVehicleDto;
    const vehicle = await userService.createVehicle(req.user!.sub, dto);
    Respond.created(res, vehicle, 'Vehicle added successfully');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// PATCH /users/me/vehicles/:id
// ─────────────────────────────────────────────
export async function updateVehicle(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as VehicleIdParam;
    const dto = req.body as UpdateVehicleDto;
    const vehicle = await userService.updateVehicle(req.user!.sub, id, dto);
    Respond.ok(res, vehicle, 'Vehicle updated successfully');
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// DELETE /users/me/vehicles/:id
// ─────────────────────────────────────────────
export async function deleteVehicle(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as VehicleIdParam;
    await userService.deleteVehicle(req.user!.sub, id);
    Respond.ok(res, null, 'Vehicle removed successfully');
  } catch (err) {
    next(err);
  }
}
