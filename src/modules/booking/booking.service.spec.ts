import { ConflictException } from '@nestjs/common';
import { BargainService } from './bargain.service';
import { BookingService } from './booking.service';
import { tashkentLocalToUtc } from './tashkent-time';

describe('BookingService booking transactions', () => {
  const start = tashkentLocalToUtc(2026, 12, 1, 10, 0);
  const input = {
    serviceId: 1,
    startTimeIso: start.toISOString(),
    clientTelegramId: '123456789',
  };

  function setup(conflicts: any[] = []) {
    const service = {
      id: 1,
      nameRu: 'Haircut',
      nameUz: 'Soch',
      price: 100_000,
      durationMin: 60,
    };
    const created = {
      id: 8,
      ...input,
      clientName: null,
      clientPhone: null,
      serviceId: 1,
      startTime: start,
      endTime: new Date(start.getTime() + 60 * 60_000),
      finalPrice: 85_000,
      discountPercent: 15,
      status: 'CONFIRMED',
      service,
    };
    const tx = {
      booking: {
        findMany: jest.fn().mockResolvedValue(conflicts),
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const prisma: any = {
      service: { findUnique: jest.fn().mockResolvedValue(service) },
      booking: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((callback: (transaction: any) => unknown) =>
        callback(tx),
      ),
    };
    const moduleRef: any = { get: jest.fn().mockReturnValue(undefined) };
    return {
      bookingService: new BookingService(
        prisma,
        new BargainService(),
        moduleRef,
      ),
      prisma,
      tx,
      created,
    };
  }

  it('uses the service duration and server-calculated price when creating a long booking', async () => {
    const { bookingService, tx, created } = setup();

    const result = await bookingService.createBooking({
      ...input,
      discountPercent: 15,
    });

    expect(result).toEqual(created);
    expect(tx.booking.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['CONFIRMED', 'BLOCKED_BY_BARBER'] },
        startTime: { lt: created.endTime },
        endTime: { gt: start },
      },
    });
    expect(created.endTime.getTime() - created.startTime.getTime()).toBe(
      60 * 60_000,
    );
    expect(created.finalPrice).toBe(85_000);
  });

  it('returns 409 and skips create when an existing interval overlaps', async () => {
    const collision = {
      startTime: new Date(start.getTime() + 30 * 60_000),
      endTime: new Date(start.getTime() + 90 * 60_000),
    };
    const { bookingService, tx } = setup([collision]);

    let thrown: unknown;
    try {
      await bookingService.createBooking({ ...input, discountPercent: 15 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getStatus()).toBe(409);
    expect(tx.booking.create).not.toHaveBeenCalled();
  });
});
