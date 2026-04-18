import { prisma } from '../../config/database';
import { Amenity } from '@prisma/client';
import { CreateParkingSpaceInput } from './validators';
import { AppError } from '../../middleware/errorHandler';
import { uploadImage, deleteFile, extractKeyFromUrl, UploadedFile, UploadResult } from '../../services/fileUpload';

// Maps validator enum values to DB SpaceType enum values.
// DB enum: open_air, covered, garage, indoor, underground
const spaceTypeMap: Record<string, string> = {
  open: 'open_air',
  covered: 'covered',
  garage: 'garage',
  basement: 'underground',
  indoor: 'indoor',
};

export async function createParkingSpace(userId: string, data: CreateParkingSpaceInput) {
  const mappedSpaceType = spaceTypeMap[data.space_type] ?? data.space_type;

  // All three writes (space row, amenities, photos) run inside a single interactive
  // transaction so a failure in any step rolls back the entire operation — no orphaned
  // space records with missing amenities or partial photo lists.
  //
  // tx.$queryRaw participates in the same PostgreSQL transaction as tx.spaceAmenity and
  // tx.spacePhoto, so PostGIS writes are fully atomic with the ORM writes.
  const newSpaceId = await prisma.$transaction(async (tx) => {
    // 1. Insert the space row (PostGIS requires raw SQL; tagged template = parameterized)
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO parking_spaces (
        id,
        host_id,
        name,
        address_line1,
        city,
        state,
        postal_code,
        location,
        space_type,
        total_capacity,
        allowed_vehicles,
        status,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        ${userId}::uuid,
        ${data.title},
        ${data.address},
        ${data.city},
        ${data.state},
        ${data.pincode},
        ST_SetSRID(ST_MakePoint(${data.location.lng}, ${data.location.lat}), 4326)::geography,
        ${mappedSpaceType}::"SpaceType",
        ${data.total_slots},
        ${data.allowed_vehicles ?? []}::text[],
        'draft'::"SpaceStatus",
        NOW(),
        NOW()
      )
      RETURNING id;
    `;

    if (!rows.length) {
      throw AppError.internal('Failed to create parking space');
    }

    const spaceId = rows[0].id;

    // 2. Persist amenities to the junction table.
    //    Amenity values are pre-validated by Zod enum in CreateParkingSpaceSchema,
    //    so any value reaching here is guaranteed to be a valid Amenity enum member.
    //    skipDuplicates guards against accidental duplicate submissions from the client.
    if (data.amenities && data.amenities.length > 0) {
      await tx.spaceAmenity.createMany({
        data: data.amenities.map((amenity) => ({
          space_id: spaceId,
          amenity: amenity as Amenity,
        })),
        skipDuplicates: true,
      });
    }

    // 3. Persist pre-uploaded image URLs (wizard uploads images before calling this endpoint)
    if (data.images && data.images.length > 0) {
      await tx.spacePhoto.createMany({
        data: data.images.map((url, idx) => ({
          space_id: spaceId,
          url,
          display_order: idx,
        })),
      });
    }

    return spaceId;
  });

  return getParkingSpace(newSpaceId);
}

export async function getParkingSpace(id: string) {
  // Use raw query to extract lat/lng back out of the PostGIS geometry
  const spaces = await prisma.$queryRaw<any[]>`
    SELECT 
      id,
      name as title,
      address_line1 as address,
      city,
      state,
      postal_code as pincode,
      ST_Y(location::geometry) as lat,
      ST_X(location::geometry) as lng,
      space_type,
      total_capacity as total_slots,
      allowed_vehicles,
      host_id as created_by,
      created_at,
      updated_at
    FROM parking_spaces
    WHERE id = ${id}::uuid
    LIMIT 1;
  `;

  if (!spaces || spaces.length === 0) {
    throw AppError.notFound('Parking space');
  }

  const space = spaces[0];

  // Fetch photos and amenities in parallel — both are needed for the response
  const [photos, amenityRows] = await Promise.all([
    prisma.spacePhoto.findMany({
      where: { space_id: id },
      select: { url: true },
      orderBy: { display_order: 'asc' },
    }),
    prisma.spaceAmenity.findMany({
      where: { space_id: id },
      select: { amenity: true },
    }),
  ]);

  return {
    id: space.id,
    title: space.title,
    address: space.address,
    city: space.city,
    state: space.state,
    pincode: space.pincode,
    location: {
      lat: Number(space.lat),
      lng: Number(space.lng),
    },
    space_type: Object.keys(spaceTypeMap).find(k => spaceTypeMap[k] === space.space_type) ?? space.space_type,
    total_slots: space.total_slots,
    allowed_vehicles: space.allowed_vehicles,
    amenities: amenityRows.map(r => r.amenity),
    images: photos.map(p => p.url),
    created_by: space.created_by,
    created_at: space.created_at,
    updated_at: space.updated_at,
  };
}

export async function uploadImages(spaceId: string, userId: string, files: Express.Multer.File[]) {
  // 1. Verify space exists and belongs to the user
  const spaces = await prisma.$queryRaw<any[]>`
    SELECT id, host_id FROM parking_spaces WHERE id = ${spaceId}::uuid LIMIT 1;
  `;

  if (!spaces || spaces.length === 0) {
    throw AppError.notFound('Parking space');
  }

  if (spaces[0].host_id !== userId) {
    throw AppError.forbidden('You do not own this parking space');
  }

  // 2 + 3. Upload files then persist DB rows.
  // Both steps are wrapped in a single try/catch so that any failure — whether
  // an S3 error mid-upload or a Prisma error after all uploads complete — triggers
  // cleanup of every S3 key that was successfully written in this call.
  //
  // Sequential for..of is intentional: it lets uploadResults accumulate only the
  // keys that succeeded. Promise.all cannot do this — a rejection discards the
  // fulfilled values, leaving orphaned S3 objects with no way to delete them.
  const folder = `spaces/host_${userId}/space_${spaceId}`;
  const uploadResults: UploadResult[] = [];

  try {
    for (const file of files) {
      const payload: UploadedFile = {
        fieldname:    file.fieldname,
        originalname: file.originalname,
        mimetype:     file.mimetype,
        size:         file.size,
        buffer:       file.buffer,
      };
      uploadResults.push(await uploadImage(payload, folder));
    }

    if (uploadResults.length > 0) {
      await prisma.spacePhoto.createMany({
        data: uploadResults.map((r, idx) => ({
          space_id:      spaceId,
          url:           r.url,
          display_order: idx,
        })),
      });
    }
  } catch (err) {
    // Best-effort S3 rollback — delete every key uploaded so far in this request.
    // allSettled so a single S3 delete failure does not suppress the others.
    await Promise.allSettled(
      uploadResults.map((r) =>
        deleteFile(r.key).catch((e: Error) =>
          console.warn(`S3 rollback: failed to delete key "${r.key}": ${e.message}`)
        )
      )
    );
    throw err;
  }

  return {
    space_id: spaceId,
    images:   uploadResults.map((r) => r.url),
  };
}

export async function deleteImages(spaceId: string, userId: string, urls: string[]) {
  // 1. Verify space exists and belongs to the user
  const spaces = await prisma.$queryRaw<any[]>`
    SELECT id, host_id FROM parking_spaces WHERE id = ${spaceId}::uuid LIMIT 1;
  `;

  if (!spaces || spaces.length === 0) {
    throw AppError.notFound('Parking space');
  }

  if (spaces[0].host_id !== userId) {
    throw AppError.forbidden('You do not own this parking space');
  }

  // 2. Delete from Database
  await prisma.spacePhoto.deleteMany({
    where: {
      space_id: spaceId,
      url: { in: urls }
    }
  });

  // 3. Delete from MinIO quietly (Best effort execution ignoring isolated network faults)
  for (const url of urls) {
    const key = extractKeyFromUrl(url);
    if (key) {
      deleteFile(key).catch((e) => {
        console.warn(`Failed S3 photo cleanup for ${key}:`, e.message);
      });
    }
  }
}
