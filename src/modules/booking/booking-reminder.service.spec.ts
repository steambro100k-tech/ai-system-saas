import { BOOKING_NOTIFIER } from './booking-notifier';
import { BookingReminderService, isReminderCandidate, ReminderCandidate } from './booking-reminder.service';

describe('booking reminder selection and delivery claims', () => {
  const now = new Date('2026-11-25T06:00:00.000Z');
  const start = new Date('2026-11-25T08:00:00.000Z');
  const candidate: ReminderCandidate = {
    status: 'CONFIRMED',
    clientTelegramId: '123456789',
    startTime: start,
    createdAt: new Date('2026-11-25T05:00:00.000Z'),
    reminderSentAt: null,
  };

  it('selects only confirmed real Telegram clients in the reminder window and not created too late', () => {
    expect(isReminderCandidate(candidate, now, 120)).toBe(true);
    expect(isReminderCandidate({ ...candidate, startTime: new Date(start.getTime() + 1) }, now, 120)).toBe(false);
    expect(isReminderCandidate({ ...candidate, status: 'CANCELLED' }, now, 120)).toBe(false);
    expect(isReminderCandidate({ ...candidate, status: 'BLOCKED_BY_BARBER' }, now, 120)).toBe(false);
    expect(isReminderCandidate({ ...candidate, reminderSentAt: now }, now, 120)).toBe(false);
    expect(isReminderCandidate({ ...candidate, clientTelegramId: 'BARBER_MANUAL' }, now, 120)).toBe(false);
    expect(isReminderCandidate({ ...candidate, createdAt: new Date('2026-11-25T07:30:00.000Z') }, now, 120)).toBe(false);
  });

  it('sends only once when two workers race to claim the same reminder', async () => {
    let claimed = false;
    const prisma = {
      booking: {
        updateMany: jest.fn(async () => {
          if (claimed) return { count: 0 };
          claimed = true;
          return { count: 1 };
        }),
      },
    };
    const notifier = { sendClientReminder: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = { get: jest.fn((token: symbol) => token === BOOKING_NOTIFIER ? notifier : undefined) };
    const service = new BookingReminderService(prisma as any, moduleRef as any);
    const booking = {
      id: 55,
      ...candidate,
      startTime: new Date(Date.now() + 60 * 60_000),
      createdAt: new Date(Date.now() - 60 * 60_000),
      service: { nameUz: 'Soch olish' },
      barber: { nameUz: 'Bobur' },
    };

    const results = await Promise.all([
      (service as any).claimAndSend(booking, new Date(), true),
      (service as any).claimAndSend(booking, new Date(), true),
    ]);

    expect(results.filter((result: any) => result.sent)).toHaveLength(1);
    expect(prisma.booking.updateMany).toHaveBeenCalledTimes(2);
    expect(notifier.sendClientReminder).toHaveBeenCalledTimes(1);
  });
});
