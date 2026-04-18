import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { ErrorCode } from '../types';
import type { PricingCalculationResult, PricingBreakdownItem } from '../types';

// ─────────────────────────────────────────────
// Internal types (matches the JSONB shapes
// stored in space_pricing_rules)
// ─────────────────────────────────────────────
interface PeakRule {
  start_time: string;  // "HH:mm"
  end_time:   string;  // "HH:mm"
  multiplier: number;  // e.g. 1.5
}

interface DiscountRules {
  long_stay_hours?:     number;  // hours threshold
  discount_pct?:        number;  // 0–100
  early_bird_hours?:    number;  // hours in advance
  early_bird_discount?: number;  // 0–100
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Round to 2 decimal places (money-safe) */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "HH:mm" → minutes since midnight */
function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** True if the Date falls on Saturday or Sunday (UTC) */
function isWeekend(date: Date): boolean {
  const dow = date.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Calculate the fraction of the booking that falls within the peak window
 * on a given day.  Returns a value in [0, 1].
 */
function peakOverlapFraction(
  bookingStart: Date,
  bookingEnd: Date,
  peakStartMin: number,
  peakEndMin: number,
  dayStart: Date
): number {
  const dayMs        = 24 * 60 * 60 * 1000;
  const bookingMs    = bookingEnd.getTime() - bookingStart.getTime();
  if (bookingMs <= 0) return 0;

  const peakStartMs = dayStart.getTime() + peakStartMin * 60_000;
  const peakEndMs   = dayStart.getTime() + peakEndMin   * 60_000;

  const overlapStart = Math.max(bookingStart.getTime(), peakStartMs);
  const overlapEnd   = Math.min(bookingEnd.getTime(),   peakEndMs);
  const overlapMs    = Math.max(0, overlapEnd - overlapStart);

  void dayMs; // potential use for multi-day normalisation
  return overlapMs / bookingMs;
}

// ─────────────────────────────────────────────
// Platform config cache (simple in-memory, TTL 5 min)
// ─────────────────────────────────────────────
let configCache: { commissionRate: number; taxRate: number; expiresAt: number } | null = null;

async function getPlatformRates(): Promise<{ commissionRate: number; taxRate: number }> {
  const now = Date.now();
  if (configCache && now < configCache.expiresAt) {
    return { commissionRate: configCache.commissionRate, taxRate: configCache.taxRate };
  }

  const [commissionRow, taxRow] = await Promise.all([
    prisma.platformConfig.findUnique({ where: { key: 'commission_rate' } }),
    prisma.platformConfig.findUnique({ where: { key: 'tax_rate' } }),
  ]);

  const commissionRate = commissionRow ? Number((commissionRow.value as { value: number }).value ?? commissionRow.value) : 0.10;
  const taxRate        = taxRow        ? Number((taxRow.value        as { value: number }).value ?? taxRow.value)        : 0;

  configCache = { commissionRate, taxRate, expiresAt: now + 5 * 60_000 };
  return { commissionRate, taxRate };
}

// ─────────────────────────────────────────────
// calculateBookingPrice
// ─────────────────────────────────────────────
export async function calculateBookingPrice(
  spaceId: string,
  startTime: Date,
  endTime: Date,
  promoCode?: string
): Promise<PricingCalculationResult> {
  const breakdown: PricingBreakdownItem[] = [];

  // ── Fetch pricing rules ────────────────────────────────────────────────
  const rules = await prisma.spacePricingRule.findMany({
    where: { space_id: spaceId },
  });

  if (rules.length === 0) {
    throw AppError.badRequest(
      ErrorCode.VALIDATION_ERROR,
      'This space has no pricing rules configured'
    );
  }

  const durationMs      = endTime.getTime() - startTime.getTime();
  const durationHours   = durationMs / (1000 * 60 * 60);
  const durationDays    = durationMs / (1000 * 60 * 60 * 24);

  if (durationHours <= 0) {
    throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'End time must be after start time');
  }

  // ── Pick the best-fit rate type ────────────────────────────────────────
  // Priority: monthly (≥28 days) > daily (≥1 day) > hourly
  const ruleMap = new Map(rules.map((r) => [r.rate_type, r]));
  let selectedRule = ruleMap.get('hourly') ?? rules[0];

  if (durationDays >= 28 && ruleMap.has('monthly')) {
    selectedRule = ruleMap.get('monthly')!;
  } else if (durationDays >= 1 && ruleMap.has('daily')) {
    selectedRule = ruleMap.get('daily')!;
  }

  const currency     = selectedRule.currency;
  const baseRate     = Number(selectedRule.base_rate);   // per hour / per day / per month
  const peakRules    = (selectedRule.peak_rules   ?? []) as unknown as PeakRule[];
  const discountRules = (selectedRule.discount_rules ?? null) as unknown as DiscountRules | null;
  const weekendMult  = selectedRule.weekend_multiplier
    ? Number(selectedRule.weekend_multiplier)
    : 1.0;
  const minPrice     = selectedRule.min_price ? Number(selectedRule.min_price) : 0;

  // ── Base price ─────────────────────────────────────────────────────────
  let basePrice: number;
  let rateLabel: string;

  switch (selectedRule.rate_type) {
    case 'monthly': {
      const months = durationDays / 30;
      basePrice  = round2(baseRate * months);
      rateLabel  = `${months.toFixed(2)} months × ₹${baseRate}/month`;
      break;
    }
    case 'daily': {
      const days = Math.ceil(durationDays);
      basePrice  = round2(baseRate * days);
      rateLabel  = `${days} day(s) × ₹${baseRate}/day`;
      break;
    }
    default: { // hourly
      basePrice  = round2(baseRate * durationHours);
      rateLabel  = `${durationHours.toFixed(2)} hr(s) × ₹${baseRate}/hr`;
    }
  }

  breakdown.push({ label: `Base rate (${rateLabel})`, amount: basePrice, type: 'base' });

  // ── Peak-hour multiplier ───────────────────────────────────────────────
  // For each peak rule compute the fraction of the booking that falls within
  // the window, apply (multiplier - 1) × base as a surcharge.
  let peakSurcharge = 0;

  if (peakRules.length > 0 && selectedRule.rate_type === 'hourly') {
    // Walk through each calendar day the booking spans
    const cursor = new Date(Date.UTC(
      startTime.getUTCFullYear(), startTime.getUTCMonth(), startTime.getUTCDate()
    ));
    while (cursor < endTime) {
      const dayEnd = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);

      for (const pr of peakRules) {
        const peakStartMin = timeToMinutes(pr.start_time);
        const peakEndMin   = timeToMinutes(pr.end_time);
        const fraction     = peakOverlapFraction(startTime, endTime, peakStartMin, peakEndMin, cursor);
        if (fraction > 0) {
          // Surcharge = fraction_of_booking_in_peak × basePrice × (multiplier - 1)
          const surcharge = round2(fraction * basePrice * (pr.multiplier - 1));
          if (surcharge > 0) {
            peakSurcharge += surcharge;
            breakdown.push({
              label:  `Peak surcharge (${pr.start_time}–${pr.end_time}, ×${pr.multiplier})`,
              amount: surcharge,
              type:   'multiplier',
            });
          }
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      void dayEnd;
    }
  }

  let adjustedPrice = round2(basePrice + peakSurcharge);

  // ── Weekend multiplier ────────────────────────────────────────────────
  if (weekendMult > 1.0) {
    // Count weekend hours within the booking window
    let weekendMs = 0;
    const wCursor = new Date(startTime);
    while (wCursor < endTime) {
      if (isWeekend(wCursor)) {
        const nextHour = new Date(Math.min(wCursor.getTime() + 3_600_000, endTime.getTime()));
        weekendMs += nextHour.getTime() - wCursor.getTime();
      }
      wCursor.setTime(wCursor.getTime() + 3_600_000);
    }
    const weekendFraction = weekendMs / durationMs;
    if (weekendFraction > 0) {
      const weekendAdder = round2(adjustedPrice * weekendFraction * (weekendMult - 1));
      if (weekendAdder > 0) {
        adjustedPrice = round2(adjustedPrice + weekendAdder);
        breakdown.push({
          label:  `Weekend surcharge (×${weekendMult}, ${Math.round(weekendFraction * 100)}% of booking)`,
          amount: weekendAdder,
          type:   'multiplier',
        });
      }
    }
  }

  // ── Long-stay discount ────────────────────────────────────────────────
  let discountAmount = 0;

  if (discountRules) {
    // Long-stay
    if (
      discountRules.long_stay_hours &&
      discountRules.discount_pct &&
      durationHours >= discountRules.long_stay_hours
    ) {
      const disc = round2(adjustedPrice * (discountRules.discount_pct / 100));
      discountAmount += disc;
      breakdown.push({
        label:  `Long-stay discount (${discountRules.discount_pct}% off for ≥${discountRules.long_stay_hours}hr)`,
        amount: -disc,
        type:   'discount',
      });
    }

    // Early-bird: booking made ≥ early_bird_hours before start
    if (
      discountRules.early_bird_hours &&
      discountRules.early_bird_discount
    ) {
      const hoursUntilStart = (startTime.getTime() - Date.now()) / 3_600_000;
      if (hoursUntilStart >= discountRules.early_bird_hours) {
        const disc = round2(adjustedPrice * (discountRules.early_bird_discount / 100));
        discountAmount += disc;
        breakdown.push({
          label:  `Early-bird discount (${discountRules.early_bird_discount}% off, booked ${Math.round(hoursUntilStart)}hr in advance)`,
          amount: -disc,
          type:   'discount',
        });
      }
    }
  }

  // ── Promo code ────────────────────────────────────────────────────────
  if (promoCode) {
    const promo = await prisma.promoCode.findFirst({
      where: {
        code:         { equals: promoCode, mode: 'insensitive' },
        active:       true,
        valid_from:   { lte: new Date() },
        valid_until:  { gte: new Date() },
      },
    });

    if (!promo) {
      throw AppError.badRequest(ErrorCode.INVALID_PROMO_CODE, 'Invalid or expired promo code');
    }

    if (promo.usage_limit !== null && promo.used_count >= promo.usage_limit) {
      throw AppError.badRequest(ErrorCode.INVALID_PROMO_CODE, 'Promo code usage limit reached');
    }

    const priceAfterDiscount = round2(adjustedPrice - discountAmount);

    if (promo.min_booking_amount && priceAfterDiscount < Number(promo.min_booking_amount)) {
      throw AppError.badRequest(
        ErrorCode.INVALID_PROMO_CODE,
        `This promo code requires a minimum booking amount of ₹${promo.min_booking_amount}`
      );
    }

    let promoDisc: number;
    if (promo.discount_type === 'flat') {
      promoDisc = Math.min(round2(Number(promo.discount_value)), priceAfterDiscount);
    } else {
      // percentage
      promoDisc = round2(priceAfterDiscount * (Number(promo.discount_value) / 100));
      if (promo.max_discount) {
        promoDisc = Math.min(promoDisc, Number(promo.max_discount));
      }
    }

    discountAmount = round2(discountAmount + promoDisc);
    breakdown.push({
      label:  `Promo code "${promo.code}" (${promo.discount_type === 'flat' ? `₹${promo.discount_value} off` : `${promo.discount_value}% off`})`,
      amount: -promoDisc,
      type:   'discount',
    });
  }

  // ── Apply min_price floor ─────────────────────────────────────────────
  let priceBeforeFees = round2(adjustedPrice - discountAmount);
  if (minPrice > 0 && priceBeforeFees < minPrice) {
    const adj = round2(minPrice - priceBeforeFees);
    priceBeforeFees = minPrice;
    breakdown.push({ label: `Minimum price adjustment`, amount: adj, type: 'base' });
  }

  // ── Platform fee & tax ────────────────────────────────────────────────
  const { commissionRate, taxRate } = await getPlatformRates();

  const platformFee = round2(priceBeforeFees * commissionRate);
  breakdown.push({
    label:  `Platform fee (${Math.round(commissionRate * 100)}%)`,
    amount: platformFee,
    type:   'fee',
  });

  const taxBase  = round2(priceBeforeFees + platformFee);
  const taxAmount = round2(taxBase * taxRate);
  breakdown.push({
    label:  `GST (${Math.round(taxRate * 100)}%)`,
    amount: taxAmount,
    type:   'tax',
  });

  const totalPrice = round2(priceBeforeFees + platformFee + taxAmount);

  return {
    base_price:      basePrice,
    platform_fee:    platformFee,
    tax_amount:      taxAmount,
    discount_amount: round2(discountAmount),
    total_price:     totalPrice,
    currency,
    breakdown,
  };
}

// ─────────────────────────────────────────────
// validatePromoCode (lightweight check, no calculation)
// ─────────────────────────────────────────────
export async function validatePromoCode(code: string, bookingAmount: number) {
  const promo = await prisma.promoCode.findFirst({
    where: {
      code:        { equals: code, mode: 'insensitive' },
      active:      true,
      valid_from:  { lte: new Date() },
      valid_until: { gte: new Date() },
    },
  });

  if (!promo) {
    throw AppError.badRequest(ErrorCode.INVALID_PROMO_CODE, 'Invalid or expired promo code');
  }

  if (promo.usage_limit !== null && promo.used_count >= promo.usage_limit) {
    throw AppError.badRequest(ErrorCode.INVALID_PROMO_CODE, 'Promo code usage limit reached');
  }

  if (promo.min_booking_amount && bookingAmount < Number(promo.min_booking_amount)) {
    throw AppError.badRequest(
      ErrorCode.INVALID_PROMO_CODE,
      `Minimum booking amount of ₹${promo.min_booking_amount} required for this promo code`
    );
  }

  return {
    code:           promo.code,
    discount_type:  promo.discount_type,
    discount_value: Number(promo.discount_value),
    max_discount:   promo.max_discount ? Number(promo.max_discount) : null,
  };
}

// ─────────────────────────────────────────────
// incrementPromoUsage  (called after booking confirmed)
// ─────────────────────────────────────────────
export async function incrementPromoUsage(code: string): Promise<void> {
  await prisma.promoCode.update({
    where: { code },
    data:  { used_count: { increment: 1 } },
  });
}
