import { v2 as cloudinary } from 'cloudinary';
import { env } from './env';

// ─────────────────────────────────────────────
// Cloudinary SDK singleton
// Configured once at module load time using validated env vars.
// ─────────────────────────────────────────────
cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key:    env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure:     true, // always use https:// URLs
});

// ─────────────────────────────────────────────
// cloudinaryUpload
// Uploads a pre-processed image buffer to Cloudinary.
//
// @param buffer   — WebP buffer already processed by sharp
// @param folder   — storage folder, e.g. 'avatars', 'spaces/abc-123', 'kyc'
// @param filename — UUID string used as the public_id leaf (no extension)
// @returns        — { url: secure HTTPS URL, public_id: full Cloudinary public_id }
// ─────────────────────────────────────────────
export function cloudinaryUpload(
  buffer:   Buffer,
  folder:   string,
  filename: string
): Promise<{ url: string; public_id: string }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id:     filename,
        resource_type: 'image',
        format:        'webp',
        overwrite:     true,
      },
      (error, result) => {
        if (error || !result) {
          return reject(error ?? new Error('Cloudinary upload returned no result'));
        }
        resolve({ url: result.secure_url, public_id: result.public_id });
      }
    );

    stream.end(buffer);
  });
}

// ─────────────────────────────────────────────
// cloudinaryDelete
// Deletes an asset from Cloudinary by its public_id.
// Mirrors the best-effort pattern used in fileUpload.ts — callers
// wrap this in .catch(() => {}) for non-blocking cleanup.
//
// @param publicId — full Cloudinary public_id, e.g. 'avatars/uuid-string'
// ─────────────────────────────────────────────
export async function cloudinaryDelete(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
}
