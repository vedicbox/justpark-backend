import { z } from 'zod';

// ─────────────────────────────────────────────
// GET /favorites — list query
// ─────────────────────────────────────────────
export const ListFavoritesQuerySchema = z.object({
  lat:   z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)),
  lng:   z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)),
  page:  z.string().optional().transform((v) => Math.max(1, v ? parseInt(v, 10) : 1)),
  limit: z.string().optional().transform((v) => Math.min(50, Math.max(1, v ? parseInt(v, 10) : 20))),
});
export type ListFavoritesQuery = z.infer<typeof ListFavoritesQuerySchema>;

// ─────────────────────────────────────────────
// Route param — :spaceId
// ─────────────────────────────────────────────
export const SpaceIdParamSchema = z.object({
  spaceId: z.string().uuid('Invalid space ID'),
});
export type SpaceIdParam = z.infer<typeof SpaceIdParamSchema>;
