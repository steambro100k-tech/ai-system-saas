import {
  addMinutes,
  canFitService,
  findOverlappingBooking,
  generateSlotStarts,
  intervalsOverlap,
  slotStatusForInterval,
} from './booking.utils';
import { tashkentLocalToUtc } from './tashkent-time';

describe('slot generation and overlap logic (Asia/Tashkent)', () => {
  it('generates 30-min slots from 10:00 to 20:30 Tashkent for a day', () => {
    const slots = generateSlotStarts('2026-11-24'); // Tue
    expect(slots).toHaveLength(22);
    expect(slots[0].toISOString()).toBe(tashkentLocalToUtc(2026, 11, 24, 10, 0).toISOString());
    expect(slots[slots.length - 1].toISOString()).toBe(
      tashkentLocalToUtc(2026, 11, 24, 20, 30).toISOString(),
    );
  });

  it('interval overlap is half-open aware [start,end)', () => {
    const aStart = tashkentLocalToUtc(2026, 11, 24, 10, 0);
    const aEnd = tashkentLocalToUtc(2026, 11, 24, 10, 30);
    const bStart = tashkentLocalToUtc(2026, 11, 24, 10, 30);
    const bEnd = tashkentLocalToUtc(2026, 11, 24, 11, 0);
    expect(intervalsOverlap(aStart, aEnd, bStart, bEnd)).toBe(false); // back-to-back
    expect(
      intervalsOverlap(
        tashkentLocalToUtc(2026, 11, 24, 10, 0),
        tashkentLocalToUtc(2026, 11, 24, 11, 0),
        tashkentLocalToUtc(2026, 11, 24, 10, 30),
        tashkentLocalToUtc(2026, 11, 24, 11, 30),
      ),
    ).toBe(true);
  });

  it('supports durations > 30 min for fitting in working hours', () => {
    const start20 = tashkentLocalToUtc(2026, 11, 24, 20, 0);
    const start2030 = tashkentLocalToUtc(2026, 11, 24, 20, 30);
    expect(canFitService(start20, 60)).toBe(true); // ends 21:00
    expect(canFitService(start2030, 60)).toBe(false); // would end 21:30
    expect(canFitService(start2030, 30)).toBe(true);
  });

  it('marks multiple 30-min slots as occupied for a long booking', () => {
    const booking = {
      id: 1,
      startTime: tashkentLocalToUtc(2026, 11, 24, 10, 0),
      endTime: tashkentLocalToUtc(2026, 11, 24, 11, 0), // 60 min
      status: 'CONFIRMED' as const,
      clientTelegramId: '1',
    };
    const s1000 = tashkentLocalToUtc(2026, 11, 24, 10, 0);
    const s1030 = tashkentLocalToUtc(2026, 11, 24, 10, 30);
    const s1100 = tashkentLocalToUtc(2026, 11, 24, 11, 0);

    expect(slotStatusForInterval(s1000, addMinutes(s1000, 30), [booking]).status).toBe('CONFIRMED');
    expect(slotStatusForInterval(s1030, addMinutes(s1030, 30), [booking]).status).toBe('CONFIRMED');
    expect(slotStatusForInterval(s1100, addMinutes(s1100, 30), [booking]).status).toBe('FREE');
  });

  it('detects conflicts for overlapping bookings including blocks', () => {
    const bookings = [
      {
        id: 1,
        startTime: tashkentLocalToUtc(2026, 11, 24, 12, 0),
        endTime: tashkentLocalToUtc(2026, 11, 24, 13, 0),
        status: 'BLOCKED_BY_BARBER' as const,
        clientTelegramId: 'BARBER',
      },
      {
        id: 2,
        startTime: tashkentLocalToUtc(2026, 11, 24, 14, 0),
        endTime: tashkentLocalToUtc(2026, 11, 24, 14, 30),
        status: 'CANCELLED' as const,
        clientTelegramId: '2',
      },
    ];

    const conflict = findOverlappingBooking(
      tashkentLocalToUtc(2026, 11, 24, 12, 30),
      tashkentLocalToUtc(2026, 11, 24, 13, 30),
      bookings,
    );
    expect(conflict?.id).toBe(1);

    const noConflictBecauseCancelled = findOverlappingBooking(
      tashkentLocalToUtc(2026, 11, 24, 14, 0),
      tashkentLocalToUtc(2026, 11, 24, 14, 30),
      bookings,
    );
    expect(noConflictBecauseCancelled).toBeUndefined();
  });

  it('treats adjacent intervals as non-overlapping', () => {
    const bookings = [
      {
        id: 10,
        startTime: tashkentLocalToUtc(2026, 11, 24, 15, 0),
        endTime: tashkentLocalToUtc(2026, 11, 24, 15, 30),
        status: 'CONFIRMED' as const,
        clientTelegramId: '10',
      },
    ];
    const next = findOverlappingBooking(
      tashkentLocalToUtc(2026, 11, 24, 15, 30),
      tashkentLocalToUtc(2026, 11, 24, 16, 0),
      bookings,
    );
    expect(next).toBeUndefined();
  });
});
