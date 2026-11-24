import { ConflictException, ForbiddenException } from '@nestjs/common';
import { BargainService } from './bargain.service';
import { BookingService } from './booking.service';
import { tashkentLocalToUtc } from './tashkent-time';

describe('BookingService per-barber booking transactions', () => {
  const start = tashkentLocalToUtc(2026, 12, 1, 10, 0);
  const barberRows = [
    { id: 1, name: 'Jasur', nameUz: 'Jasur', isActive: true, sortOrder: 0 },
    { id: 2, name: 'Bobur', nameUz: 'Bobur', isActive: true, sortOrder: 1 },
  ];

  function setup(options: { durationMin?: number; busyByBarber?: Map<number, any[]> } = {}) {
    const service = {
      id: 1,
      nameRu: 'Haircut',
      nameUz: 'Soch',
      price: 100_000,
      durationMin: options.durationMin ?? 30,
    };
    const busyByBarber = options.busyByBarber ?? new Map<number, any[]>();
    const createdArgs: any[] = [];
    const tx = {
      barber: {
        findMany: jest.fn(async ({ where }: any) => barberRows.filter((barber) => !where?.id || where.id === barber.id)),
      },
      booking: {
        findMany: jest.fn(async ({ where }: any) => busyByBarber.get(where.barberId) ?? []),
        create: jest.fn(async ({ data, include }: any) => {
          createdArgs.push(data);
          const barber = barberRows.find((item) => item.id === data.barberId);
          return {
            id: createdArgs.length,
            ...data,
            startTime: start,
            endTime: new Date(start.getTime() + service.durationMin * 60_000),
            service,
            barber: include?.barber ? barber : undefined,
            finalPrice: 85_000,
            discountPercent: 15,
            status: 'CONFIRMED',
          };
        }),
      },
    };
    const prisma: any = {
      service: { findUnique: jest.fn().mockResolvedValue(service) },
      barber: {
        findMany: jest.fn().mockResolvedValue(barberRows),
        findFirst: jest.fn(async ({ where }: any) => barberRows.find((barber) => barber.id === where.id)),
      },
      booking: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      $transaction: jest.fn((callback: (transaction: any) => unknown) => callback(tx)),
    };
    const moduleRef: any = { get: jest.fn().mockReturnValue(undefined) };
    return {
      bookingService: new BookingService(prisma, new BargainService(), moduleRef),
      prisma,
      tx,
      createdArgs,
      busyByBarber,
    };
  }

  const input = { serviceId: 1, startTimeIso: start.toISOString(), clientTelegramId: '123456789' };

  it('allows the same time to be booked for two different barbers', async () => {
    const { bookingService, createdArgs } = setup();
    await bookingService.createBooking({ ...input, barberId: 1 });
    await bookingService.createBooking({ ...input, barberId: 2 });
    expect(createdArgs.map((row) => row.barberId)).toEqual([1, 2]);
  });

  it('returns 409 when the same barber is booked twice', async () => {
    const { bookingService, createdArgs, busyByBarber } = setup();
    const first = await bookingService.createBooking({ ...input, barberId: 1 });
    busyByBarber.set(1, [{ startTime: first.startTime, endTime: first.endTime }]);
    await expect(bookingService.createBooking({ ...input, barberId: 1 })).rejects.toMatchObject({ status: 409 });
    expect(createdArgs).toHaveLength(1);
  });

  it('assigns any-master requests to the first free barber in stable order', async () => {
    const { bookingService, createdArgs, busyByBarber } = setup();
    busyByBarber.set(1, [{ startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) }]);
    const result = await bookingService.createBooking(input);
    expect(createdArgs[0].barberId).toBe(2);
    expect(result.barber?.name).toBe('Bobur');
  });

  it('respects service durations over 30 minutes for each barber', async () => {
    const busyByBarber = new Map([[1, [{ startTime: new Date(start.getTime() + 30 * 60_000), endTime: new Date(start.getTime() + 60 * 60_000) }]]]);
    const { bookingService, tx, createdArgs } = setup({ durationMin: 60, busyByBarber });
    await bookingService.createBooking(input);
    expect(tx.booking.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ barberId: 1, startTime: { lt: new Date(start.getTime() + 60 * 60_000) }, endTime: { gt: start } }),
    }));
    expect(createdArgs[0].barberId).toBe(2);
  });

  it('does not let a barber block another barber schedule', async () => {
    const { bookingService, prisma } = setup();
    await expect(bookingService.blockSlot({ barberId: 2, startTimeIso: start.toISOString() }, { barberId: 1, isAdmin: false })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
