import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, BookingStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../core/db/prisma.service';
import { BargainService } from './bargain.service';
import { getAppEnv } from '../../common/config/env';
import { BOOKING_NOTIFIER, BookingNotifier } from './booking-notifier';
import {
  addMinutes,
  canFitService,
  findOverlappingBooking,
  generateSlotStarts,
  getDayBoundsUtc,
  isStartWithinWorkingHours,
  parseStartTimeIso,
  slotStatusForInterval,
  toTimeLabel,
  assertNotPast,
  validateServiceDuration,
} from './booking.utils';
import {
  SLOT_STEP_MINUTES,
  formatTashkentDate,
  isOnSlotGrid,
} from './tashkent-time';

type CreateBookingInput = {
  serviceId: number;
  startTimeIso: string;
  discountPercent?: number;
  clientTelegramId: string;
  clientName?: string;
  clientPhone?: string;
};

const ACTIVE_STATUSES: BookingStatus[] = ['CONFIRMED', 'BLOCKED_BY_BARBER'];

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bargain: BargainService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private getNotifier(): BookingNotifier | undefined {
    try {
      return this.moduleRef.get(BOOKING_NOTIFIER, { strict: false });
    } catch {
      return undefined;
    }
  }

  async listServices() {
    return this.prisma.service.findMany({ orderBy: { id: 'asc' } });
  }

  async getSlots(date?: string) {
    let day: string;
    try {
      day = getDayBoundsUtc(date).date;
    } catch {
      throw new BadRequestException('Invalid date. Expected YYYY-MM-DD');
    }
    const { start: dayStart, end: dayEnd } = getDayBoundsUtc(day);
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ACTIVE_STATUSES },
        startTime: { lt: dayEnd },
        endTime: { gt: dayStart },
      },
      include: { service: true },
      orderBy: { startTime: 'asc' },
    });

    const slots = generateSlotStarts(day).map((slotStart) => {
      const slotEnd = addMinutes(slotStart, SLOT_STEP_MINUTES);
      const { status, booking } = slotStatusForInterval(
        slotStart,
        slotEnd,
        bookings as any,
      );
      const offer = this.bargain.evaluate(slotStart, 100000);
      return {
        time: toTimeLabel(slotStart),
        startTimeIso: slotStart.toISOString(),
        status,
        booking: booking
          ? {
              id: booking.id,
              clientTelegramId: booking.clientTelegramId,
              clientName: booking.clientName,
              clientPhone: booking.clientPhone,
              serviceId: booking.serviceId,
              service: (booking as any).service ?? null,
              startTime: booking.startTime.toISOString(),
              endTime: booking.endTime.toISOString(),
              finalPrice: booking.finalPrice,
              discountPercent: booking.discountPercent,
              status: booking.status,
              note: (booking as any).note ?? null,
            }
          : null,
        offer: {
          canDiscount: offer.canDiscount,
          maxDiscountPercent: offer.maxDiscountPercent,
          bonus: offer.bonus,
          reason: offer.reason,
        },
      };
    });

    return { date: day, timezone: 'Asia/Tashkent', slots };
  }

  async createBooking(input: CreateBookingInput) {
    const service = await this.prisma.service.findUnique({
      where: { id: input.serviceId },
    });
    if (!service) throw new BadRequestException('Service not found');
    try {
      validateServiceDuration(service.durationMin);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    let start: Date;
    try {
      start = parseStartTimeIso(input.startTimeIso);
    } catch {
      throw new BadRequestException('Invalid startTimeIso');
    }
    if (!isOnSlotGrid(start)) {
      throw new BadRequestException('startTimeIso must be on a 30-minute grid');
    }
    if (
      !isStartWithinWorkingHours(start) ||
      !canFitService(start, service.durationMin)
    ) {
      throw new BadRequestException(
        'Time is outside working hours for this service duration',
      );
    }
    try {
      assertNotPast(start);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    let pricing;
    try {
      pricing = this.bargain.normalizeDiscount(
        start,
        service.price,
        input.discountPercent ?? 0,
      );
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    const end = addMinutes(start, service.durationMin);

    try {
      const created = await this.prisma.$transaction(
        async (tx) => {
          const conflicts = await tx.booking.findMany({
            where: {
              status: { in: ACTIVE_STATUSES },
              startTime: { lt: end },
              endTime: { gt: start },
            },
          });
          if (conflicts.length > 0) {
            throw new ConflictException('SLOT_CONFLICT');
          }
          return tx.booking.create({
            data: {
              clientTelegramId: input.clientTelegramId,
              clientName: input.clientName ?? null,
              clientPhone: input.clientPhone ?? null,
              serviceId: service.id,
              startTime: start,
              endTime: end,
              finalPrice: pricing.finalPrice,
              discountPercent: pricing.discountPercent,
              status: 'CONFIRMED',
            },
            include: { service: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      if (created.status === 'CONFIRMED') {
        this.logger.log(
          JSON.stringify({
            event: 'booking_created',
            bookingId: created.id,
            serviceId: service.id,
            discountPercent: created.discountPercent,
            finalPrice: created.finalPrice,
          }),
        );
        await this.getNotifier()?.onBookingCreated(created);
      }
      return created;
    } catch (e) {
      if (e instanceof ConflictException) {
        const alternatives = await this.findAlternativeSlots(
          start,
          service.durationMin,
          3,
        );
        throw new ConflictException({
          message: 'Selected slot is not available',
          alternatives,
        });
      }
      // serialization conflict
      if (
        e &&
        typeof e === 'object' &&
        'code' in e &&
        (e as any).code === 'P2034'
      ) {
        const alternatives = await this.findAlternativeSlots(
          start,
          service.durationMin,
          3,
        );
        throw new ConflictException({
          message: 'Selected slot is not available',
          alternatives,
        });
      }
      throw e;
    }
  }

  async cancelBooking(
    id: number,
    opts: { clientTelegramId?: string; allowPrivileged: boolean },
  ) {
    const booking = await this.prisma.booking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('Booking not found');

    if (!opts.allowPrivileged) {
      if (
        !opts.clientTelegramId ||
        opts.clientTelegramId !== booking.clientTelegramId
      ) {
        throw new ForbiddenException('Not allowed to cancel this booking');
      }
    }

    if (booking.status === 'CANCELLED') return booking;

    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: 'CANCELLED' },
      include: { service: true },
    });
    if (updated.status === 'CANCELLED') {
      this.logger.log(
        JSON.stringify({ event: 'booking_cancelled', bookingId: updated.id }),
      );
      await this.getNotifier()?.onBookingCancelled(updated);
    }
    return updated;
  }

  async blockSlot(input: {
    startTimeIso: string;
    durationMin?: number;
    note?: string;
  }) {
    let start: Date;
    try {
      start = parseStartTimeIso(input.startTimeIso);
    } catch {
      throw new BadRequestException('Invalid startTimeIso');
    }
    const durationMin = input.durationMin ?? 30;
    if (durationMin % SLOT_STEP_MINUTES !== 0 || durationMin <= 0) {
      throw new BadRequestException(
        'durationMin must be a positive multiple of 30',
      );
    }
    if (
      !isStartWithinWorkingHours(start) ||
      !canFitService(start, durationMin)
    ) {
      throw new BadRequestException('Time is outside working hours');
    }
    try {
      assertNotPast(start);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const end = addMinutes(start, durationMin);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const conflicts = await tx.booking.findMany({
            where: {
              status: { in: ACTIVE_STATUSES },
              startTime: { lt: end },
              endTime: { gt: start },
            },
          });
          if (conflicts.length > 0) {
            throw new ConflictException('SLOT_CONFLICT');
          }
          return tx.booking.create({
            data: {
              clientTelegramId: 'BARBER',
              serviceId: null,
              startTime: start,
              endTime: end,
              finalPrice: 0,
              discountPercent: 0,
              status: 'BLOCKED_BY_BARBER',
              note: input.note ?? null,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      if (
        e instanceof ConflictException ||
        (e &&
          typeof e === 'object' &&
          'code' in e &&
          (e as any).code === 'P2034')
      ) {
        throw new ConflictException(
          'Selected slot cannot be blocked because it overlaps an existing booking',
        );
      }
      throw e;
    }
  }

  async unblockSlot(id: number) {
    const booking = await this.prisma.booking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.status !== 'BLOCKED_BY_BARBER') {
      throw new BadRequestException('Booking is not a barber block');
    }
    return this.prisma.booking.delete({ where: { id } });
  }

  async seedDemo() {
    if (getAppEnv().NODE_ENV === 'production') {
      throw new ForbiddenException('Demo seeding is disabled in production');
    }
    const services = [
      {
        nameRu: 'Мужская стрижка',
        nameUz: 'Erkaklar soch turmagi',
        price: 100000,
        durationMin: 30,
      },
      {
        nameRu: 'Стрижка + борода',
        nameUz: 'Soch turmagi + soqol',
        price: 150000,
        durationMin: 60,
      },
      {
        nameRu: 'Детская стрижка',
        nameUz: 'Bolalar soch turmagi',
        price: 80000,
        durationMin: 30,
      },
      {
        nameRu: 'Мытьё и укладка',
        nameUz: 'Yuvish va turmaklash',
        price: 50000,
        durationMin: 30,
      },
    ];

    for (const s of services) {
      const existing = await this.prisma.service.findFirst({
        where: { nameUz: s.nameUz },
      });
      if (existing) {
        await this.prisma.service.update({
          where: { id: existing.id },
          data: {
            nameRu: s.nameRu,
            nameUz: s.nameUz,
            price: s.price,
            durationMin: s.durationMin,
          },
        });
      } else {
        await this.prisma.service.create({ data: s });
      }
    }
    return this.prisma.service.findMany({ orderBy: { id: 'asc' } });
  }

  async resetDemo() {
    if (getAppEnv().NODE_ENV === 'production') {
      throw new ForbiddenException('Reset is disabled in production');
    }
    await this.prisma.chatMessage.deleteMany({});
    await this.prisma.booking.deleteMany({});
    await this.prisma.service.deleteMany({});
    return { ok: true };
  }

  async findAlternativeSlots(start: Date, durationMin: number, limit: number) {
    const date = formatTashkentDate(start);
    const { start: dayStart, end: dayEnd } = getDayBoundsUtc(date);
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ACTIVE_STATUSES },
        startTime: { lt: dayEnd },
        endTime: { gt: dayStart },
      },
    });
    const candidates = generateSlotStarts(date)
      .filter((s) => s.getTime() !== start.getTime())
      .filter((s) => canFitService(s, durationMin))
      .filter((s) => s.getTime() > Date.now())
      .filter(
        (s) =>
          !findOverlappingBooking(
            s,
            addMinutes(s, durationMin),
            bookings as any,
          ),
      );

    return candidates.slice(0, limit).map((s) => {
      const offer = this.bargain.evaluate(s, 0);
      return {
        startTimeIso: s.toISOString(),
        time: toTimeLabel(s),
        maxDiscountPercent: offer.maxDiscountPercent,
      };
    });
  }
}
