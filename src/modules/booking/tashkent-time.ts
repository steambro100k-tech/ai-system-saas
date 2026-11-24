import { SAVDO_RULES } from './business-rules';

export const TASHKENT_OFFSET_HOURS = SAVDO_RULES.utcOffsetHours;
export const TASHKENT_OFFSET_MS = TASHKENT_OFFSET_HOURS * 60 * 60 * 1000;
export const WORKDAY_START_MINUTES = 10 * 60;
export const WORKDAY_END_MINUTES = 21 * 60;
export const LAST_SLOT_START_MINUTES = 20 * 60 + 30;
export const SLOT_STEP_MINUTES = 30;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type TashkentParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number; // 0=Sun..6=Sat in Tashkent
};

export function getTashkentParts(date: Date): TashkentParts {
  const shifted = new Date(date.getTime() + TASHKENT_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    dayOfWeek: shifted.getUTCDay(),
  };
}

export function formatTashkentDate(date: Date): string {
  const p = getTashkentParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

export function parseDateOnly(dateStr: string): {
  year: number;
  month: number;
  day: number;
} {
  if (!DATE_RE.test(dateStr)) {
    throw new Error('Invalid date format, expected YYYY-MM-DD');
  }
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error('Invalid calendar date');
  }
  return { year, month, day };
}

export function tashkentLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  return new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      hour - TASHKENT_OFFSET_HOURS,
      minute,
      second,
      ms,
    ),
  );
}

export function parseIsoToDate(value: string): Date {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      value,
    )
  ) {
    throw new Error('Invalid datetime');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid datetime');
  }
  return date;
}

export function minutesOfDay(
  parts: Pick<TashkentParts, 'hour' | 'minute'>,
): number {
  return parts.hour * 60 + parts.minute;
}

export function isOnSlotGrid(date: Date): boolean {
  const p = getTashkentParts(date);
  return (
    p.second === 0 &&
    date.getUTCMilliseconds() === 0 &&
    p.minute % SLOT_STEP_MINUTES === 0
  );
}

export function isWithinWorkingHoursStart(
  start: Date,
  durationMin: number,
): boolean {
  const p = getTashkentParts(start);
  if (!isOnSlotGrid(start)) return false;
  const startMin = minutesOfDay(p);
  const endMin = startMin + durationMin;
  return (
    startMin >= WORKDAY_START_MINUTES &&
    startMin <= LAST_SLOT_START_MINUTES &&
    endMin <= WORKDAY_END_MINUTES
  );
}
