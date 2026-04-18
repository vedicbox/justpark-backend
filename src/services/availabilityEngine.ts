import { prisma } from '../config/database';
import { redis, RedisKeys, SLOT_LOCK_TTL_SECONDS } from '../config/redis';
import type { AvailabilityCheckResult, AvailabilityConflict, AvailableSlot } from '../types';

// ─────────────────────────────────────────────
// Redis SCAN utility
// ─────────────────────────────────────────────

/**
 * Non-blocking key scan using cursor-based SCAN instead of KEYS.
 *
 * KEYS is O(N) over the entire keyspace and runs single-threaded —
 * it blocks every other Redis client (rate-limiters, session checks,
 * blacklists) for the full duration of the scan.
 *
 * SCAN iterates in batches of `count` and yields control between
 * batches, so Redis remains responsive throughout.
 *
 * COUNT is a hint to Redis, not a guarantee; the actual number of
 * keys returned per batch may vary.  The loop terminates when the
 * server returns cursor "0" (full cycle complete).
 */
async function scanKeys(pattern: string, count = 100): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = nextCursor;
    if (batch.length > 0) {
      keys.push(...batch);
    }
  } while (cursor !== '0');
  return keys;
}

// ─────────────────────────────────────────────
// Time helpers (UTC throughout)
// ─────────────────────────────────────────────

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minuteOfDay(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function truncateToDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** ISO string without milliseconds — used as Redis key segment */
function isoKey(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ─────────────────────────────────────────────
// Space-level checks shared between both check functions
// Returns conflicts for schedule, blackout, and duration issues.
// ─────────────────────────────────────────────
function runSpaceLevelChecks(
  space: {
    buffer_minutes: number;
    min_booking_duration_minutes: number | null;
    max_booking_duration_minutes: number | null;
    schedules: { day_of_week: number; open_time: string; close_time: string; is_closed: boolean }[];
    blackout_dates: { date: Date; reason: string | null }[];
  },
  startTime: Date,
  endTime: Date
): AvailabilityConflict[] {
  const conflicts: AvailabilityConflict[] = [];
  const durationMinutes = (endTime.getTime() - startTime.getTime()) / 60_000;

  if (durationMinutes <= 0) {
    conflicts.push({ type: 'duration', message: 'End time must be after start time' });
  }
  if (space.min_booking_duration_minutes && durationMinutes < space.min_booking_duration_minutes) {
    conflicts.push({
      type: 'duration',
      message: `Minimum booking duration is ${space.min_booking_duration_minutes} min (requested: ${Math.round(durationMinutes)} min)`,
    });
  }
  if (space.max_booking_duration_minutes && durationMinutes > space.max_booking_duration_minutes) {
    conflicts.push({
      type: 'duration',
      message: `Maximum booking duration is ${space.max_booking_duration_minutes} min (requested: ${Math.round(durationMinutes)} min)`,
    });
  }

  if (space.schedules.length > 0) {
    const scheduleByDay = new Map(space.schedules.map((s) => [s.day_of_week, s]));
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const spannedDays = new Set<number>();
    const cursor = new Date(startTime);
    while (cursor < endTime) {
      spannedDays.add(cursor.getUTCDay());
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    for (const dow of spannedDays) {
      const sched = scheduleByDay.get(dow);
      if (!sched) continue;
      if (sched.is_closed) {
        conflicts.push({ type: 'schedule', message: `Space is closed on ${DAY_NAMES[dow]}` });
        continue;
      }
      if (spannedDays.size === 1) {
        const openMin  = timeToMinutes(sched.open_time);
        const closeMin = timeToMinutes(sched.close_time);
        const reqStart = minuteOfDay(startTime);
        const reqEnd   = minuteOfDay(endTime);
        if (reqStart < openMin || reqEnd > closeMin) {
          conflicts.push({
            type: 'schedule',
            message: `Space is only open ${sched.open_time}–${sched.close_time} on ${DAY_NAMES[dow]} (UTC). Requested: ${startTime.toISOString().slice(11, 16)}–${endTime.toISOString().slice(11, 16)} UTC`,
          });
        }
      }
    }
  }

  for (const bd of space.blackout_dates) {
    const bdDay    = truncateToDay(new Date(bd.date));
    const startDay = truncateToDay(startTime);
    const endDay   = truncateToDay(endTime);
    if (bdDay >= startDay && bdDay <= endDay) {
      conflicts.push({
        type: 'blackout',
        message: `Space is unavailable on ${bdDay.toISOString().slice(0, 10)}${bd.reason ? ` (${bd.reason})` : ''}`,
      });
    }
  }

  return conflicts;
}

// ─────────────────────────────────────────────
// getLockedSlotIds
// Scans Redis for slot-level locks that overlap the given window.
// Returns the set of slot IDs that are currently locked.
// ─────────────────────────────────────────────
async function getLockedSlotIds(
  slotIds: Set<string>,
  startTime: Date,
  endTime: Date
): Promise<Set<string>> {
  const locked = new Set<string>();
  if (slotIds.size === 0) return locked;

  const allLockKeys = await scanKeys('lock:slot:*');

  for (const key of allLockKeys) {
    // Key format: lock:slot:{uuid}:{startISO}:{endISO}
    // Example: lock:slot:f47ac10b-58cc-4372-a567-0e02b2c3d479:2026-03-25T10:00:00Z:2026-03-25T12:00:00Z
    // Splits to: ['lock', 'slot', '{uuid}', '2026-03-25T10', '00', '00Z', '2026-03-25T12', '00', '00Z']
    const parts = key.split(':');
    if (parts.length !== 9) continue; // Invalid key format

    const slotId = parts[2]; // UUID part
    if (!slotIds.has(slotId)) continue;

    // Reconstruct ISO strings from split parts
    const lockStartStr = `${parts[3]}:${parts[4]}:${parts[5]}`; // 2026-03-25T10:00:00Z
    const lockEndStr   = `${parts[6]}:${parts[7]}:${parts[8]}`; // 2026-03-25T12:00:00Z

    const lockStart = new Date(lockStartStr);
    const lockEnd   = new Date(lockEndStr);

    if (isNaN(lockStart.getTime()) || isNaN(lockEnd.getTime())) continue;

    // Overlap: [startTime, endTime) ∩ [lockStart, lockEnd)
    if (startTime < lockEnd && endTime > lockStart) {
      locked.add(slotId);
    }
  }
  return locked;
}

// ─────────────────────────────────────────────
// checkAvailability — space-wide availability check
// Returns the list of slots that are free for the requested window.
// ─────────────────────────────────────────────
export async function checkAvailability(
  spaceId: string,
  startTime: Date,
  endTime: Date
): Promise<AvailabilityCheckResult> {
  const conflicts: AvailabilityConflict[] = [];

  // ── 1. Space exists and is active ─────────────────────────────────────
  const space = await prisma.parkingSpace.findUnique({
    where: { id: spaceId },
    select: {
      id: true,
      status: true,
      buffer_minutes: true,
      min_booking_duration_minutes: true,
      max_booking_duration_minutes: true,
      schedules:      { orderBy: { day_of_week: 'asc' } },
      blackout_dates: true,
      total_capacity: true,
      slots:          { where: { is_active: true }, select: { id: true, slot_number: true } },
    },
  });

  if (!space) {
    return { available: false, availableSlots: [], conflicts: [{ type: 'schedule', message: 'Space not found' }], reason: 'Space not found' };
  }
  if (space.status !== 'active') {
    return { available: false, availableSlots: [], conflicts: [{ type: 'schedule', message: `Space is not available (status: ${space.status})` }], reason: 'Space is not active' };
  }

  // ── 2. Duration + schedule + blackout checks (space-level) ─────────────
  const spaceLevelConflicts = runSpaceLevelChecks(space, startTime, endTime);
  conflicts.push(...spaceLevelConflicts);

  // If space-level checks fail, no point checking slots
  if (conflicts.length > 0) {
    return { available: false, availableSlots: [], conflicts, reason: conflicts[0].message };
  }

  // ── 3. Slot-level availability ─────────────────────────────────────────
  if (space.slots.length === 0) {
    if (space.total_capacity > 0) {
      // Lazy-healing mechanism for retroactive spaces missing Native arrays
      await prisma.parkingSlot.createMany({
        data: Array.from({ length: space.total_capacity }).map((_, i) => ({
          space_id: space.id,
          slot_number: `Slot ${i + 1}`,
          is_active: true,
        })),
        skipDuplicates: true,
      });
      // Refetch the explicitly seeded spatial pointers to proceed safely
      space.slots = await prisma.parkingSlot.findMany({
        where: { space_id: space.id, is_active: true },
        select: { id: true, slot_number: true },
      });
    } else {
      // No slots configured — space cannot accept bookings
      return {
        available: false,
        availableSlots: [],
        conflicts: [{ type: 'capacity', message: 'No parking slots have been configured for this space. The host must add slots before bookings can be made.' }],
        reason: 'No slots configured',
      };
    }
  }

  const bufferMs      = (space.buffer_minutes ?? 0) * 60_000;
  const bufferedStart = new Date(startTime.getTime() - bufferMs);
  const bufferedEnd   = new Date(endTime.getTime()   + bufferMs);

  // Find slots already booked in this window (slot-level, with buffer)
  interface CountRow { count: bigint | number; }
  const totalBookedRows = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::int as count
    FROM bookings
    WHERE space_id = ${spaceId}::uuid
      AND status IN ('pending', 'confirmed', 'active')
      AND tstzrange(start_time, end_time, '[)') &&
          tstzrange(${bufferedStart}::timestamptz, ${bufferedEnd}::timestamptz, '[)')
  `;
  const bookedCount = Number(totalBookedRows[0]?.count || 0);

  // 1. strict Mathematical UI capacity enforcement = total_slots - booked_count
  const availableMathSlots = space.total_capacity - bookedCount;
  
  if (availableMathSlots <= 0) {
    conflicts.push({
      type: 'capacity',
      message: 'All slots are fully booked or reserved for the requested time window',
    });
    return { available: false, availableSlots: [], conflicts, reason: conflicts[0].message };
  }

  // 2. Native Physical array generation caching
  interface BookedSlotRow { slot_id: string }
  const bookedRows = await prisma.$queryRaw<BookedSlotRow[]>`
    SELECT DISTINCT slot_id::text
    FROM bookings
    WHERE space_id = ${spaceId}::uuid
      AND slot_id IS NOT NULL
      AND status IN ('pending', 'confirmed', 'active')
      AND tstzrange(start_time, end_time, '[)') &&
          tstzrange(${bufferedStart}::timestamptz, ${bufferedEnd}::timestamptz, '[)')
  `;
  const bookedSlotIds = new Set(bookedRows.map((r) => r.slot_id));

  // Find slots with active Redis locks in this window
  const allSlotIds   = new Set(space.slots.map((s) => s.id));
  const lockedSlotIds = await getLockedSlotIds(allSlotIds, startTime, endTime);

  // Available = active slots that are neither booked nor locked
  const availableSlots: AvailableSlot[] = space.slots.filter(
    (s) => !bookedSlotIds.has(s.id) && !lockedSlotIds.has(s.id)
  );

  // 3. Slice the physically available array matching our strict mathematical constraints 
  // This explicitly prevents UI inflation if legacy bookings had slot_id=NULL
  const finalAvailableSlots = availableSlots.slice(0, availableMathSlots);

  if (finalAvailableSlots.length === 0) {
    conflicts.push({
      type: 'capacity',
      message: 'All specific slots are currently actively locked or scheduled for checkout',
    });
    return { available: false, availableSlots: [], conflicts, reason: conflicts[0].message };
  }

  return { available: true, availableSlots: finalAvailableSlots, conflicts: [] };
}

// ─────────────────────────────────────────────
// checkSlotAvailability — single-slot check
// Used by modify/extend flows where the booking is already on a specific slot.
// excludeBookingId lets the current booking's own time range be ignored.
// ─────────────────────────────────────────────
export async function checkSlotAvailability(
  slotId: string,
  spaceId: string,
  startTime: Date,
  endTime: Date,
  excludeBookingId?: string,
  // Set to true when the caller already holds (and has verified) the Redis slot lock.
  // Skips the Redis lock scan so the caller's own lock is not treated as a conflict.
  // The DB EXCLUDE constraint remains the final race-condition guard.
  skipLockScan = false
): Promise<AvailabilityCheckResult> {
  const conflicts: AvailabilityConflict[] = [];

  const space = await prisma.parkingSpace.findUnique({
    where: { id: spaceId },
    select: {
      status: true,
      buffer_minutes: true,
      min_booking_duration_minutes: true,
      max_booking_duration_minutes: true,
      schedules:      { orderBy: { day_of_week: 'asc' } },
      blackout_dates: true,
    },
  });

  if (!space) {
    return { available: false, availableSlots: [], conflicts: [{ type: 'schedule', message: 'Space not found' }], reason: 'Space not found' };
  }
  if (space.status !== 'active') {
    return { available: false, availableSlots: [], conflicts: [{ type: 'schedule', message: `Space is not available (status: ${space.status})` }], reason: 'Space is not active' };
  }

  const spaceLevelConflicts = runSpaceLevelChecks(space, startTime, endTime);
  conflicts.push(...spaceLevelConflicts);
  if (conflicts.length > 0) {
    return { available: false, availableSlots: [], conflicts, reason: conflicts[0].message };
  }

  const bufferMs      = (space.buffer_minutes ?? 0) * 60_000;
  const bufferedStart = new Date(startTime.getTime() - bufferMs);
  const bufferedEnd   = new Date(endTime.getTime()   + bufferMs);

  // Check for conflicting bookings on this specific slot (excluding the current booking)
  interface OverlapRow { id: string; start_time: Date; end_time: Date }
  let overlaps: OverlapRow[];
  if (excludeBookingId) {
    overlaps = await prisma.$queryRaw<OverlapRow[]>`
      SELECT id, start_time, end_time
      FROM bookings
      WHERE slot_id = ${slotId}::uuid
        AND id != ${excludeBookingId}::uuid
        AND status IN ('pending', 'confirmed', 'active')
        AND tstzrange(start_time, end_time, '[)') &&
            tstzrange(${bufferedStart}::timestamptz, ${bufferedEnd}::timestamptz, '[)')
      LIMIT 5
    `;
  } else {
    overlaps = await prisma.$queryRaw<OverlapRow[]>`
      SELECT id, start_time, end_time
      FROM bookings
      WHERE slot_id = ${slotId}::uuid
        AND status IN ('pending', 'confirmed', 'active')
        AND tstzrange(start_time, end_time, '[)') &&
            tstzrange(${bufferedStart}::timestamptz, ${bufferedEnd}::timestamptz, '[)')
      LIMIT 5
    `;
  }

  for (const b of overlaps) {
    conflicts.push({
      type: 'booking',
      message: `Slot is already booked ${new Date(b.start_time).toISOString()} – ${new Date(b.end_time).toISOString()}`,
    });
  }

  // Skip the Redis lock scan when the caller has already verified they hold the lock
  // (e.g. createBooking — their own lock must not be treated as a blocking conflict).
  if (!skipLockScan) {
    const slotLockKeys = await scanKeys(`lock:slot:${slotId}:*`);
    for (const key of slotLockKeys) {
      // Key format: lock:slot:{uuid}:{startISO}:{endISO}
      // Example: lock:slot:f47ac10b-58cc-4372-a567-0e02b2c3d479:2026-03-25T10:00:00Z:2026-03-25T12:00:00Z
      // Splits to: ['lock', 'slot', '{uuid}', '2026-03-25T10', '00', '00Z', '2026-03-25T12', '00', '00Z']
      const parts = key.split(':');
      if (parts.length !== 9) continue; // Invalid key format

      // Reconstruct ISO strings from split parts
      const lockStartStr = `${parts[3]}:${parts[4]}:${parts[5]}`; // 2026-03-25T10:00:00Z
      const lockEndStr   = `${parts[6]}:${parts[7]}:${parts[8]}`; // 2026-03-25T12:00:00Z

      const lockStart = new Date(lockStartStr);
      const lockEnd   = new Date(lockEndStr);

      if (isNaN(lockStart.getTime()) || isNaN(lockEnd.getTime())) continue;

      // Check for overlap: two ranges overlap if start1 < end2 && end1 > start2
      if (startTime < lockEnd && endTime > lockStart) {
        conflicts.push({ type: 'lock', message: 'This slot is temporarily reserved (lock expires in ≤10 min)' });
      }
    }
  }

  const available = conflicts.length === 0;
  return {
    available,
    availableSlots: available ? [{ id: slotId, slot_number: '' }] : [],
    conflicts,
    reason: available ? undefined : conflicts[0].message,
  };
}

// ─────────────────────────────────────────────
// Slot locking helpers
// ─────────────────────────────────────────────

/**
 * Acquire a Redis NX lock for a specific slot.
 * Returns true if acquired, false if another lock is already held.
 */
export async function acquireSlotLock(
  slotId: string,
  startTime: Date,
  endTime: Date,
  userId: string,
  ttlSeconds = SLOT_LOCK_TTL_SECONDS
): Promise<boolean> {
  const key = RedisKeys.slotLockById(slotId, isoKey(startTime), isoKey(endTime));
  const result = await redis.set(key, userId, 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

/**
 * Release a slot lock (on payment failure / abandonment).
 */
export async function releaseSlotLock(
  slotId: string,
  startTime: Date,
  endTime: Date
): Promise<void> {
  const key = RedisKeys.slotLockById(slotId, isoKey(startTime), isoKey(endTime));
  await redis.del(key);
}

/**
 * Check if a lock exists for the given slot+window without acquiring it.
 */
export async function isSlotLocked(
  slotId: string,
  startTime: Date,
  endTime: Date
): Promise<boolean> {
  const key = RedisKeys.slotLockById(slotId, isoKey(startTime), isoKey(endTime));
  return (await redis.exists(key)) === 1;
}
