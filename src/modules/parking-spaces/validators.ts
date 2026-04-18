import { z } from 'zod';

export const CreateParkingSpaceSchema = z.object({
  title: z.string().min(3).max(200),
  address: z.string().min(5).max(255),
  city: z.string().min(2).max(100),
  state: z.string().min(2).max(100),
  pincode: z.string().min(3).max(20),
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  space_type: z.enum(['open', 'covered', 'garage', 'basement']),
  total_slots: z.number().int().min(1),
  allowed_vehicles: z.array(z.string()).min(1).optional(),
  amenities: z.array(z.enum([
    'cctv', 'ev_charging', 'access_24x7', 'gated', 'covered',
    'security_guard', 'lighting', 'wheelchair_accessible',
    'ev_type1', 'ev_type2', 'ev_ccs', 'ev_chademo',
  ])).optional(),
  images: z.array(z.string().url()).optional(),
});

export const ParkingSpaceIdSchema = z.object({
  id: z.string().uuid(),
});

export type CreateParkingSpaceInput = z.infer<typeof CreateParkingSpaceSchema>;
