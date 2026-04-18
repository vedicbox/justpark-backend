// ─────────────────────────────────────────────
// Date / time utilities (no external deps — use native Date)
// All times stored as TIMESTAMPTZ (UTC) in DB
// ─────────────────────────────────────────────

/**
 * Returns duration in minutes between two Date objects.
 */
export function getDurationMinutes(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / (1000 * 60));
}

/**
 * Returns duration in hours between two Date objects.
 */
export function getDurationHours(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60);
}

/**
 * Adds `minutes` to a Date and returns a new Date.
 */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/**
 * Adds `hours` to a Date and returns a new Date.
 */
export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

/**
 * Adds `days` to a Date and returns a new Date.
 */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Checks if two time ranges overlap.
 * Uses half-open interval [start, end) semantics.
 */
export function doTimeRangesOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Returns the day of week (0=Sunday, 6=Saturday) for a given UTC date.
 */
export function getDayOfWeek(date: Date): number {
  return date.getUTCDay();
}

/**
 * Formats a Date as "YYYY-MM-DD" in UTC.
 */
export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Formats a Date as "HH:mm" in UTC.
 */
export function toTimeString(date: Date): string {
  return date.toISOString().slice(11, 16);
}

/**
 * Parses a "HH:mm" string into total minutes from midnight.
 */
export function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Checks if a Date's UTC time falls within an "HH:mm"-"HH:mm" window.
 */
export function isTimeBetween(date: Date, openTime: string, closeTime: string): boolean {
  const currentMinutes = parseTimeToMinutes(toTimeString(date));
  const openMinutes = parseTimeToMinutes(openTime);
  const closeMinutes = parseTimeToMinutes(closeTime);

  if (openMinutes <= closeMinutes) {
    // Normal window: e.g., 08:00 - 22:00
    return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
  } else {
    // Overnight window: e.g., 22:00 - 06:00
    return currentMinutes >= openMinutes || currentMinutes < closeMinutes;
  }
}

/**
 * Returns an array of all dates (as YYYY-MM-DD strings) between start and end (inclusive).
 */
export function getDateRange(start: Date, end: Date): string[] {
  const dates: string[] = [];
  const current = new Date(start);
  current.setUTCHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setUTCHours(0, 0, 0, 0);

  while (current <= endDay) {
    dates.push(toDateString(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Returns true if the date falls on a weekend (Sat or Sun) in UTC.
 */
export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Returns a Date set to N minutes in the future.
 */
export function futureMinutes(n: number): Date {
  return addMinutes(new Date(), n);
}

/**
 * Returns a Date set to N hours in the future.
 */
export function futureHours(n: number): Date {
  return addHours(new Date(), n);
}

/**
 * Returns a Date set to N days in the future.
 */
export function futureDays(n: number): Date {
  return addDays(new Date(), n);
}
