import {
  SLOT_STEP_MINUTES,
  WORKDAY_END_MINUTES,
  WORKDAY_START_MINUTES,
  getTashkentParts,
  isOnSlotGrid,
  minutesOfDay,
  parseDateOnly,
  parseIsoToDate,
  tashkentLocalToUtc,
} from './tashkent-time';

export type SlotStatus = 'FREE' | 'CONFIRMED' | 'BLOCKED_BY_BARBER';

export type BookingLike = {
  id: number;
  startTime: Date;
  endTime: Date;
  status: 'CONFIRMED' | 'BLOCKED_BY_BARBER' | 'CANCELLED';
  clientName?: string | null;
  clientPhone?: string | null;
  clientTelegramId?: string;
  serviceId?: number | null;
  barberId?: number | null;
  barber?: { id: number; name: string; nameRu?: string | null; nameUz?: string | null } | null;
  finalPrice?: number;
  discountPercent?: number;
  note?: string | null;
  service?: unknown;
};

export function intervalsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

export function validateServiceDuration(durationMin: number): void {
  if (
    !Number.isInteger(durationMin) ||
    durationMin <= 0 ||
    durationMin % SLOT_STEP_MINUTES !== 0
  ) {
    throw new Error(
      'Service duration must be a positive multiple of 30 minutes',
    );
  }
}

export function getDayBoundsUtc(dateStr?: string): {
  start: Date;
  end: Date;
  date: string;
} {
  const base = dateStr ? parseDateOnly(dateStr) : null;
  let year: number, month: number, day: number;
  if (base) {
    ({ year, month, day } = base);
  } else {
    const nowParts = getTashkentParts(new Date());
    year = nowParts.year;
    month = nowParts.month;
    day = nowParts.day;
  }
  const start = tashkentLocalToUtc(year, month, day, 0, 0, 0, 0);
  const end = tashkentLocalToUtc(year, month, day, 23, 59, 59, 999);
  return {
    start,
    end,
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

export function generateSlotStarts(dateStr?: string): Date[] {
  const { date } = getDayBoundsUtc(dateStr);
  const { year, month, day } = parseDateOnly(date);
  const slots: Date[] = [];
  for (
    let minutes = WORKDAY_START_MINUTES;
    minutes <= WORKDAY_END_MINUTES - SLOT_STEP_MINUTES;
    minutes += SLOT_STEP_MINUTES
  ) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    // last slot start is 20:30, but grid lists all 30-min starts 10:00..20:30
    if (minutes > 20 * 60 + 30) break;
    slots.push(tashkentLocalToUtc(year, month, day, hour, minute, 0, 0));
  }
  return slots;
}

export function isStartWithinWorkingHours(start: Date): boolean {
  const p = getTashkentParts(start);
  if (!isOnSlotGrid(start)) return false;
  const startMin = minutesOfDay(p);
  return startMin >= WORKDAY_START_MINUTES && startMin <= 20 * 60 + 30;
}

export function canFitService(start: Date, durationMin: number): boolean {
  if (!isStartWithinWorkingHours(start)) return false;
  const p = getTashkentParts(start);
  const startMin = minutesOfDay(p);
  return startMin + durationMin <= WORKDAY_END_MINUTES;
}

export function findOverlappingBooking(
  start: Date,
  end: Date,
  bookings: BookingLike[],
): BookingLike | undefined {
  return bookings.find(
    (b) =>
      b.status !== 'CANCELLED' &&
      intervalsOverlap(start, end, b.startTime, b.endTime),
  );
}

export function slotStatusForInterval(
  slotStart: Date,
  slotEnd: Date,
  bookings: BookingLike[],
): { status: SlotStatus; booking: BookingLike | null } {
  const overlap = bookings.find(
    (b) =>
      b.status !== 'CANCELLED' &&
      intervalsOverlap(slotStart, slotEnd, b.startTime, b.endTime),
  );
  if (!overlap) return { status: 'FREE', booking: null };
  if (overlap.status === 'BLOCKED_BY_BARBER') {
    return { status: 'BLOCKED_BY_BARBER', booking: overlap };
  }
  return { status: 'CONFIRMED', booking: overlap };
}

export function assertNotPast(start: Date, now: Date = new Date()): void {
  if (start.getTime() <= now.getTime()) {
    throw new Error('Cannot book a past time slot');
  }
}

export function parseStartTimeIso(value: string): Date {
  const date = parseIsoToDate(value);
  return date;
}

export function toTimeLabel(date: Date): string {
  const p = getTashkentParts(date);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
