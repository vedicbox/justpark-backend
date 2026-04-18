import { Request, Response, NextFunction } from 'express';
import * as service from './service';
import { CreateParkingSpaceInput } from './validators';
import { Respond } from '../../utils/response';

export async function createParkingSpace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // req.user typing uses 'sub' for the user id in Auth
    const userId = (req.user as any)?.sub; 
    if (!userId) {
      Respond.unauthorized(res, 'Unauthorized');
      return;
    }

    const data: CreateParkingSpaceInput = req.body;
    const space = await service.createParkingSpace(userId, data);

    Respond.created(res, space);
  } catch (err) {
    next(err);
  }
}

export async function getParkingSpace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const space = await service.getParkingSpace(id);

    Respond.ok(res, space);
  } catch (err) {
    next(err);
  }
}

export async function uploadImages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = (req.user as any)?.sub;
    if (!userId) {
      Respond.unauthorized(res, 'Unauthorized');
      return;
    }

    const { id } = req.params;
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      Respond.badRequest(res, 'VALIDATION_ERROR', 'No images provided for upload');
      return;
    }

    const result = await service.uploadImages(id, userId, files);

    Respond.ok(res, result, 'Images uploaded successfully');
  } catch (err) {
    next(err);
  }
}

export async function deleteImages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = (req.user as any)?.sub;
    const { id } = req.params;
    const { urls } = req.body;
    
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      Respond.badRequest(res, 'VALIDATION_ERROR', 'No image URLs provided for deletion');
      return;
    }
    
    await service.deleteImages(id, userId, urls);
    Respond.ok(res, null, 'Images deleted successfully');
  } catch (err) {
    next(err);
  }
}
