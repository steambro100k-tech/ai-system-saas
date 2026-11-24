import {
  getTashkentParts,
  minutesOfDay,
  parseIsoToDate,
} from './tashkent-time';
import { SAVDO_RULES } from './business-rules';

export type BargainResult = {
  canDiscount: boolean;
  maxDiscountPercent: number;
  finalPriceAtMax: number;
  bonus: string | null;
  reason: string;
};

export class BargainService {
  evaluate(start: Date | string, basePrice: number): BargainResult {
    const date = typeof start === 'string' ? parseIsoToDate(start) : start;
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new Error('Invalid datetime');
    }
    if (!Number.isSafeInteger(basePrice) || basePrice < 0) {
      throw new Error('Base price must be a non-negative integer');
    }

    const parts = getTashkentParts(date);
    const minute = minutesOfDay(parts);
    const inDeadHours =
      SAVDO_RULES.deadHours.days.includes(parts.dayOfWeek as 1 | 2 | 3 | 4) &&
      minute >= SAVDO_RULES.deadHours.startMinute &&
      minute < SAVDO_RULES.deadHours.endMinuteExclusive;

    if (inDeadHours) {
      const maxDiscountPercent = SAVDO_RULES.maxDeadHoursDiscountPercent;
      return {
        canDiscount: true,
        maxDiscountPercent,
        finalPriceAtMax: this.applyDiscount(basePrice, maxDiscountPercent),
        bonus: SAVDO_RULES.deadHours.bonus,
        reason: `Dead hours (Mon-Thu 10:00-14:59 ${SAVDO_RULES.timezone})`,
      };
    }

    const isPrimeTime =
      (parts.dayOfWeek === 5 &&
        minute >= SAVDO_RULES.primeTime.fridayStartMinute) ||
      parts.dayOfWeek === 6 ||
      parts.dayOfWeek === 0;
    if (isPrimeTime) {
      return {
        canDiscount: false,
        maxDiscountPercent: 0,
        finalPriceAtMax: basePrice,
        bonus: SAVDO_RULES.primeTime.bonus,
        reason: `Prime time (Fri from 16:00, Sat, Sun ${SAVDO_RULES.timezone})`,
      };
    }

    return {
      canDiscount: false,
      maxDiscountPercent: 0,
      finalPriceAtMax: basePrice,
      bonus: null,
      reason: `No discount for this time. Move to Mon-Thu 10:00-15:00 (${SAVDO_RULES.timezone}) for up to ${SAVDO_RULES.maxDeadHoursDiscountPercent}% off.`,
    };
  }

  applyDiscount(basePrice: number, discountPercent: number): number {
    const clamped = Math.max(0, Math.min(100, Math.trunc(discountPercent)));
    return Math.round((basePrice * (100 - clamped)) / 100);
  }

  normalizeDiscount(
    start: Date | string,
    basePrice: number,
    requestedDiscountPercent: number | undefined | null,
  ): {
    discountPercent: number;
    finalPrice: number;
    maxDiscountPercent: number;
  } {
    const offer = this.evaluate(start, basePrice);
    const requested = requestedDiscountPercent ?? 0;
    if (!Number.isInteger(requested) || requested < 0) {
      throw new Error('Invalid discount percent');
    }
    if (requested > offer.maxDiscountPercent) {
      throw new Error(
        `Discount ${requested}% exceeds allowed maximum ${offer.maxDiscountPercent}% for this slot`,
      );
    }
    return {
      discountPercent: requested,
      finalPrice: this.applyDiscount(basePrice, requested),
      maxDiscountPercent: offer.maxDiscountPercent,
    };
  }
}
