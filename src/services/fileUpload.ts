import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { AppError } from '../middleware/errorHandler';
import { ErrorCode } from '../types';
import { cloudinaryUpload, cloudinaryDelete } from '../config/cloudinary';

// ─────────────────────────────────────────────
// Allowed image types
// ─────────────────────────────────────────────
const ALLOWED_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export interface UploadedFile {
  fieldname:    string;
  originalname: string;
  mimetype:     string;
  size:         number;
  buffer:       Buffer;
}

export interface UploadResult {
  url: string;
  key: string;
}

// ─────────────────────────────────────────────
// Re-encode image via sharp
// Converts any accepted input (JPEG/PNG/WebP) to WebP, auto-rotates using
// EXIF orientation then strips all metadata (GPS, camera model, timestamps).
// Re-encoding also defeats polyglot exploits where a valid image is
// simultaneously a valid ZIP/PHP/HTML payload.
// ─────────────────────────────────────────────
async function reEncodeImage(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate()                                                        // auto-orient from EXIF, then strip orientation tag
    .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true }) // cap dimensions, preserve aspect ratio
    .webp({ quality: 82 })                                           // re-encode; sharp drops all metadata by default
    .toBuffer();
}

// ─────────────────────────────────────────────
// Validate uploaded file (type + size)
// ─────────────────────────────────────────────
export function validateImageFile(file: UploadedFile): void {
  if (!ALLOWED_MIME_TYPES[file.mimetype]) {
    throw AppError.badRequest(
      ErrorCode.VALIDATION_ERROR,
      'Invalid file type. Only JPEG, PNG, and WebP images are allowed.'
    );
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw AppError.badRequest(
      ErrorCode.VALIDATION_ERROR,
      'File too large. Maximum size is 5MB.'
    );
  }
}

// ─────────────────────────────────────────────
// Upload image to Cloudinary
// folder:    e.g. 'avatars/user_123', 'spaces/host_456/space_789', 'kyc/user_123'
// filename:  optional — fixed slug for overwrite flows (e.g. 'avatar', 'id_card')
//            omit to auto-generate a UUID (e.g. multiple photos per space)
// ─────────────────────────────────────────────
export async function uploadImage(
  file:      UploadedFile,
  folder:    string,
  filename?: string
): Promise<UploadResult> {
  validateImageFile(file);

  // Re-encode before upload: strips EXIF metadata (GPS, camera info) and
  // defeats polyglot exploits. Output is always WebP regardless of input type.
  const processedBuffer = await reEncodeImage(file.buffer);

  // Use caller-supplied filename (overwrite flows) or generate a UUID (multi-photo flows)
  const name = filename ?? randomUUID();

  const { url, public_id } = await cloudinaryUpload(processedBuffer, folder, name);

  // key = Cloudinary public_id (e.g. 'avatars/user_123/avatar')
  // Used by deleteFile() and extractKeyFromUrl() for cleanup
  return { url, key: public_id };
}

// ─────────────────────────────────────────────
// Delete a file from Cloudinary by public_id (key)
// Signature unchanged — callers pass the value from UploadResult.key
// or from extractKeyFromUrl().
// ─────────────────────────────────────────────
export async function deleteFile(key: string): Promise<void> {
  await cloudinaryDelete(key);
}

// ─────────────────────────────────────────────
// Extract Cloudinary public_id from a stored URL
//
// Cloudinary URL format:
//   https://res.cloudinary.com/{cloud_name}/image/upload/v{version}/{public_id}.webp
//
// Returns the public_id portion, e.g. 'avatars/some-uuid'
// Returns null if the URL cannot be parsed (safe — callers skip deletion on null)
// ─────────────────────────────────────────────
export function extractKeyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Capture everything after /upload/v{digits}/ and before the file extension
    const match = parsed.pathname.match(/\/upload\/v\d+\/(.+?)(?:\.\w+)?$/);
    if (match?.[1]) return match[1];
    return null;
  } catch {
    return null;
  }
}
