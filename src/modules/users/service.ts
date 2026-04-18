import { prisma } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { uploadImage, deleteFile, extractKeyFromUrl, type UploadedFile } from '../../services/fileUpload';
import { ErrorCode } from '../../types';
import type { UpdateProfileDto, CreateVehicleDto, UpdateVehicleDto, SubmitKycDto } from './validators';

// ─────────────────────────────────────────────
// Safe user shape (no password_hash)
// ─────────────────────────────────────────────
export type SafeUser = {
  id: string;
  email: string;
  phone: string | null;
  first_name: string;
  last_name: string;
  role: string;
  avatar_url: string | null;
  email_verified: boolean;
  phone_verified: boolean;
  status: string;
  created_at: Date;
  updated_at: Date;
  kyc_status?: 'none' | 'pending' | 'approved' | 'rejected';
};

const USER_SELECT = {
  id: true,
  email: true,
  phone: true,
  first_name: true,
  last_name: true,
  role: true,
  avatar_url: true,
  email_verified: true,
  phone_verified: true,
  status: true,
  created_at: true,
  updated_at: true,
} as const;

// ─────────────────────────────────────────────
// GET /users/me
// ─────────────────────────────────────────────
export async function getProfile(userId: string): Promise<SafeUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: USER_SELECT,
  });

  if (!user) {
    throw AppError.notFound('User');
  }

  const kycDoc = await prisma.kycDocument.findFirst({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    select: { status: true },
  });

  return {
    ...user,
    kyc_status: kycDoc ? (kycDoc.status as 'pending' | 'approved' | 'rejected') : 'none',
  };
}

// ─────────────────────────────────────────────
// PATCH /users/me
// ─────────────────────────────────────────────
export async function updateProfile(userId: string, dto: UpdateProfileDto): Promise<SafeUser> {
  // Conflict checks run before the UPDATE so we return a clean 409, not a DB constraint error.
  // Both checks exclude the current user so a no-op update (same value) is allowed.
  if (dto.phone) {
    const taken = await prisma.user.findFirst({
      where: { phone: dto.phone, id: { not: userId } },
      select: { id: true },
    });
    if (taken) {
      throw AppError.conflict(ErrorCode.ALREADY_EXISTS, 'Phone number is already in use');
    }
  }

  if (dto.email) {
    const taken = await prisma.user.findFirst({
      where: { email: dto.email, id: { not: userId } },
      select: { id: true },
    });
    if (taken) {
      throw AppError.conflict(ErrorCode.ALREADY_EXISTS, 'Email address is already in use');
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(dto.first_name !== undefined && { first_name: dto.first_name }),
      ...(dto.last_name !== undefined && { last_name: dto.last_name }),
      // Changing phone or email invalidates the verification flag — user must re-verify.
      ...(dto.phone !== undefined && { phone: dto.phone, phone_verified: false }),
      ...(dto.email !== undefined && { email: dto.email, email_verified: false }),
    },
    select: USER_SELECT,
  });

  return updated;
}

// ─────────────────────────────────────────────
// POST /users/me/avatar
// ─────────────────────────────────────────────
export async function uploadAvatar(userId: string, file: UploadedFile): Promise<SafeUser> {
  // Delete old avatar from S3 if it exists
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { avatar_url: true },
  });

  if (user?.avatar_url) {
    const oldKey = extractKeyFromUrl(user.avatar_url);
    if (oldKey) {
      // Fire-and-forget; don't block the upload if deletion fails
      deleteFile(oldKey).catch(() => {/* old file cleanup is best-effort */});
    }
  }

  const { url } = await uploadImage(file, `avatars/user_${userId}`, 'avatar');

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatar_url: url },
    select: USER_SELECT,
  });

  return updated;
}

// ─────────────────────────────────────────────
// GET /users/me/vehicles
// ─────────────────────────────────────────────
export async function getVehicles(userId: string) {
  return prisma.vehicle.findMany({
    where: { user_id: userId },
    orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
  });
}

// ─────────────────────────────────────────────
// POST /users/me/vehicles
// ─────────────────────────────────────────────
export async function createVehicle(userId: string, dto: CreateVehicleDto) {
  return prisma.$transaction(async (tx) => {
    // If this vehicle is being set as default, clear existing default first
    if (dto.is_default) {
      await tx.vehicle.updateMany({
        where: { user_id: userId, is_default: true },
        data: { is_default: false },
      });
    }

    // If this is the user's first vehicle, make it default automatically
    const count = await tx.vehicle.count({ where: { user_id: userId } });
    const shouldBeDefault = dto.is_default || count === 0;

    return tx.vehicle.create({
      data: {
        user_id: userId,
        plate_number: dto.plate_number,
        type: dto.type,
        make: dto.make,
        model: dto.model,
        color: dto.color,
        is_default: shouldBeDefault,
      },
    });
  });
}

// ─────────────────────────────────────────────
// PATCH /users/me/vehicles/:id
// ─────────────────────────────────────────────
export async function updateVehicle(userId: string, vehicleId: string, dto: UpdateVehicleDto) {
  // Ensure the vehicle belongs to this user
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, user_id: userId },
  });
  if (!vehicle) {
    throw AppError.notFound('Vehicle');
  }

  return prisma.$transaction(async (tx) => {
    // If setting as default, clear any existing default
    if (dto.is_default === true) {
      await tx.vehicle.updateMany({
        where: { user_id: userId, is_default: true, id: { not: vehicleId } },
        data: { is_default: false },
      });
    }

    // Prevent un-defaulting when it's the only default — just ignore is_default: false
    // if there are other vehicles, the caller should explicitly set another as default.
    return tx.vehicle.update({
      where: { id: vehicleId },
      data: {
        ...(dto.plate_number !== undefined && { plate_number: dto.plate_number }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.make !== undefined && { make: dto.make }),
        ...(dto.model !== undefined && { model: dto.model }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.is_default !== undefined && { is_default: dto.is_default }),
      },
    });
  });
}

// ─────────────────────────────────────────────
// POST /users/me/kyc
// Submit a KYC document for admin review.
// Rules:
//   - File is required (image upload via multer)
//   - Blocks duplicate submissions: a user cannot submit the same document_type
//     while a prior submission for that type is still pending
//   - Approved/rejected docs do not block a fresh submission (re-verification flow)
// ─────────────────────────────────────────────
export async function submitKyc(
  userId:       string,
  dto:          SubmitKycDto,
  file:         UploadedFile
) {
  // Block if a pending submission already exists for this document type
  const existing = await prisma.kycDocument.findFirst({
    where:  { user_id: userId, document_type: dto.document_type, status: 'pending' },
    select: { id: true },
  });

  if (existing) {
    throw AppError.conflict(
      ErrorCode.ALREADY_EXISTS,
      `A pending KYC submission for '${dto.document_type}' already exists. Wait for admin review before resubmitting.`
    );
  }

  const { url } = await uploadImage(file, `kyc/user_${userId}`, dto.document_type);

  const doc = await prisma.kycDocument.create({
    data: {
      user_id:       userId,
      document_type: dto.document_type,
      document_url:  url,
      status:        'pending',
    },
    select: {
      id:            true,
      document_type: true,
      status:        true,
      created_at:    true,
    },
  });

  return doc;
}

// ─────────────────────────────────────────────
// DELETE /users/me/vehicles/:id
// ─────────────────────────────────────────────
export async function deleteVehicle(userId: string, vehicleId: string): Promise<void> {
  // Ensure the vehicle belongs to this user
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, user_id: userId },
  });
  if (!vehicle) {
    throw AppError.notFound('Vehicle');
  }

  // Block deletion if the vehicle is tied to an active or confirmed booking
  const activeBooking = await prisma.booking.findFirst({
    where: {
      vehicle_id: vehicleId,
      status: { in: ['confirmed', 'active', 'pending'] },
    },
    select: { id: true },
  });
  if (activeBooking) {
    throw AppError.conflict(
      ErrorCode.BOOKING_CONFLICT,
      'Cannot remove a vehicle that is associated with an active booking'
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.vehicle.delete({ where: { id: vehicleId } });

    // If the deleted vehicle was the default, promote the oldest remaining vehicle
    if (vehicle.is_default) {
      const next = await tx.vehicle.findFirst({
        where: { user_id: userId },
        orderBy: { created_at: 'asc' },
      });
      if (next) {
        await tx.vehicle.update({
          where: { id: next.id },
          data: { is_default: true },
        });
      }
    }
  });
}
