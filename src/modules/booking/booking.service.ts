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
  barberId?: number;
  discountPercent?: number;
  clientTelegramId: string;
  clientName?: string;
  clientPhone?: string;
  clientLang?: 'uz' | 'ru';
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

  async listBarbers() {
    return this.prisma.barber.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, nameRu: true, nameUz: true },
    });
  }

  async getSlots(date?: string, barberId?: number) {
    let day: string;
    try {
      day = getDayBoundsUtc(date).date;
    } catch {
      throw new BadRequestException('Invalid date. Expected YYYY-MM-DD');
    }
    const { start: dayStart, end: dayEnd } = getDayBoundsUtc(day);
    const barbers = await this.prisma.barber.findMany({
      where: { isActive: true, ...(barberId ? { id: barberId } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    if (barberId && !barbers.length) throw new NotFoundException('Barber not found');
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ACTIVE_STATUSES },
        ...(barberId ? { barberId } : { barberId: { in: barbers.map((b) => b.id) } }),
        startTime: { lt: dayEnd },
        endTime: { gt: dayStart },
      },
      include: { service: true, barber: true },
      orderBy: { startTime: 'asc' },
    });

    const slots = generateSlotStarts(day).map((slotStart) => {
      const slotEnd = addMinutes(slotStart, SLOT_STEP_MINUTES);
      const states = barbers.map((barber) => {
        const barberBookings = bookings.filter((booking) => booking.barberId === barber.id);
        const state = slotStatusForInterval(slotStart, slotEnd, barberBookings as any);
        return { barber, ...state };
      });
      const freeBarberIds = states.filter((state) => state.status === 'FREE').map((state) => state.barber.id);
      const selectedState = barberId ? states[0] : undefined;
      const busyState = selectedState ?? states.find((state) => state.status !== 'FREE');
      const status = barberId
        ? (selectedState?.status ?? 'CONFIRMED')
        : freeBarberIds.length > 0 ? 'FREE' : (busyState?.status ?? 'CONFIRMED');
      const booking = status === 'FREE' ? null : (busyState?.booking ?? null);
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
              clientConfirmedAt: (booking as any).clientConfirmedAt?.toISOString() ?? null,
              barber: booking.barber ? { id: booking.barber.id, name: booking.barber.name, nameRu: booking.barber.nameRu, nameUz: booking.barber.nameUz } : null,
            }
          : null,
        barber: barberId && selectedState ? { id: selectedState.barber.id, name: selectedState.barber.name, nameRu: selectedState.barber.nameRu, nameUz: selectedState.barber.nameUz } : null,
        freeBarberIds,
        barberStatuses: barberId ? undefined : states.map((state) => ({ barberId: state.barber.id, barberName: state.barber.name, status: state.status })),
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
          const candidates = await tx.barber.findMany({
            where: { isActive: true, ...(input.barberId ? { id: input.barberId } : {}) },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          });
          if (input.barberId && !candidates.length) throw new BadRequestException('Barber not found');
          if (!candidates.length) throw new ConflictException('NO_ACTIVE_BARBERS');
          let selectedBarber: (typeof candidates)[number] | undefined;
          for (const candidate of candidates) {
            const conflicts = await tx.booking.findMany({
              where: {
                barberId: candidate.id,
                status: { in: ACTIVE_STATUSES },
                startTime: { lt: end },
                endTime: { gt: start },
              },
            });
            if (!conflicts.length) { selectedBarber = candidate; break; }
          }
          if (!selectedBarber) {
            throw new ConflictException('SLOT_CONFLICT');
          }
          return tx.booking.create({
            data: {
              barberId: selectedBarber.id,
              clientTelegramId: input.clientTelegramId,
              clientName: input.clientName ?? null,
              clientPhone: input.clientPhone ?? null,
              clientLang: input.clientLang ?? null,
              serviceId: service.id,
              startTime: start,
              endTime: end,
              finalPrice: pricing.finalPrice,
              discountPercent: pricing.discountPercent,
              status: 'CONFIRMED',
            },
            include: { service: true, barber: true },
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
        const offer = this.bargain.evaluate(start, service.price);
        let notifyResult;
        try {
          notifyResult = await this.getNotifier()?.onBookingCreated({
            ...created,
            bonusText: offer.bonus,
          });
        } catch (error: any) {
          this.logger.warn(`booking_confirmation_delivery_failed code=${error?.code ?? error?.name ?? 'unknown'}`);
        }
        return { ...created, clientConfirmationSent: notifyResult?.clientConfirmationSent === true };
      }
      return { ...created, clientConfirmationSent: false };
    } catch (e) {
      if (e instanceof ConflictException) {
        const alternatives = await this.findAlternativeSlots(
          start,
          service.durationMin,
          3,
          input.barberId,
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
          input.barberId,
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
    opts: { clientTelegramId?: string; allowPrivileged: boolean; barberId?: number },
  ) {
    const booking = await this.prisma.booking.findUnique({ where: { id }, include: { service: true, barber: true } });
    if (!booking) throw new NotFoundException('Booking not found');

    if (opts.barberId !== undefined && opts.barberId !== booking.barberId) {
      throw new ForbiddenException('Barbers can manage only their own schedule');
    }
    if (!opts.allowPrivileged && opts.barberId === undefined) {
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
      include: { service: true, barber: true },
    });
    if (updated.status === 'CANCELLED') {
      this.logger.log(
        JSON.stringify({ event: 'booking_cancelled', bookingId: updated.id }),
      );
      await this.getNotifier()?.onBookingCancelled(updated);
    }
    return updated;
  }

  async getClientReminderBooking(id: number, clientTelegramId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id, clientTelegramId, status: 'CONFIRMED', startTime: { gt: new Date() } },
      include: { service: true, barber: true },
    });
    return booking ?? null;
  }

  async confirmClientBooking(id: number, clientTelegramId: string) {
    const booking = await this.getClientReminderBooking(id, clientTelegramId);
    if (!booking) return null;
    if (!booking.clientConfirmedAt) {
      await this.prisma.booking.updateMany({
        where: { id, clientTelegramId, status: 'CONFIRMED', clientConfirmedAt: null, startTime: { gt: new Date() } },
        data: { clientConfirmedAt: new Date() },
      });
    }
    return this.getClientReminderBooking(id, clientTelegramId);
  }

  async cancelClientBookingFromReminder(id: number, clientTelegramId: string) {
    const now = new Date();
    const changed = await this.prisma.booking.updateMany({
      where: { id, clientTelegramId, status: 'CONFIRMED', startTime: { gt: now } },
      data: { status: 'CANCELLED' },
    });
    if (changed.count !== 1) return null;
    const updated = await this.prisma.booking.findUnique({
      where: { id },
      include: { service: true, barber: true },
    });
    if (updated) await this.getNotifier()?.onBookingCancelled(updated);
    return updated;
  }

  async blockSlot(input: {
    startTimeIso: string;
    barberId: number;
    durationMin?: number;
    note?: string;
  }, actor: { barberId?: number; isAdmin: boolean }) {
    const barber = await this.prisma.barber.findFirst({ where: { id: input.barberId, isActive: true } });
    if (!barber) throw new NotFoundException('Barber not found');
    if (!actor.isAdmin && actor.barberId !== barber.id) throw new ForbiddenException('Barbers can manage only their own schedule');
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
              barberId: barber.id,
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
              barberId: barber.id,
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

  async unblockSlot(id: number, requestedBarberId: number, actor: { barberId?: number; isAdmin: boolean }) {
    const booking = await this.prisma.booking.findUnique({ where: { id }, include: { barber: true } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.status !== 'BLOCKED_BY_BARBER') {
      throw new BadRequestException('Booking is not a barber block');
    }
    if (booking.barberId !== requestedBarberId) throw new BadRequestException('barberId does not match this blocked slot');
    if (!actor.isAdmin && actor.barberId !== booking.barberId) throw new ForbiddenException('Barbers can manage only their own schedule');
    return this.prisma.booking.delete({ where: { id }, include: { barber: true } });
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
    const barberTelegramId = getAppEnv().BARBER_TELEGRAM_IDS[0] || null;
    const demoBarbers = [
      { name: 'Jasur', nameUz: 'Jasur', sortOrder: 0, telegramId: barberTelegramId },
      { name: 'Bobur', nameUz: 'Bobur', sortOrder: 1 },
      { name: 'Sardor', nameUz: 'Sardor', sortOrder: 2 },
    ];
    for (const barber of demoBarbers) {
      const { name, ...data } = barber;
      await this.prisma.barber.upsert({
        where: { name },
        create: { name, ...data },
        update: { ...data },
      });
    }
    return this.prisma.service.findMany({ orderBy: { id: 'asc' } });
  }

  async resetDemo() {
    if (getAppEnv().NODE_ENV === 'production') {
      throw new ForbiddenException('Reset is disabled in production');
    }
    await this.prisma.chatMessage.deleteMany({});
    await this.prisma.booking.deleteMany({});
    await this.prisma.barber.deleteMany({});
    await this.prisma.service.deleteMany({});
    return { ok: true };
  }

  async findAlternativeSlots(start: Date, durationMin: number, limit: number, preferredBarberId?: number) {
    const date = formatTashkentDate(start);
    const { start: dayStart, end: dayEnd } = getDayBoundsUtc(date);
    const barbers = await this.prisma.barber.findMany({
      where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ACTIVE_STATUSES },
        barberId: { in: barbers.map((barber) => barber.id) },
        startTime: { lt: dayEnd },
        endTime: { gt: dayStart },
      },
    });
    const candidates = generateSlotStarts(date)
      .filter((s) => canFitService(s, durationMin))
      .filter((s) => s.getTime() > Date.now());

    const result: Array<Record<string, unknown>> = [];
    for (const slot of candidates) {
      const ordered = preferredBarberId
        ? [...barbers.filter((b) => b.id !== preferredBarberId), ...barbers.filter((b) => b.id === preferredBarberId)]
        : barbers;
      for (const barber of ordered) {
        if (slot.getTime() === start.getTime() && barber.id === preferredBarberId) continue;
        const busy = findOverlappingBooking(slot, addMinutes(slot, durationMin), bookings.filter((b) => b.barberId === barber.id) as any);
        if (busy) continue;
        const offer = this.bargain.evaluate(slot, 100000);
        result.push({ startTimeIso: slot.toISOString(), time: toTimeLabel(slot), barberId: barber.id, barberName: barber.name, maxDiscountPercent: offer.maxDiscountPercent });
        if (result.length >= limit) return result;
      }
    }
    return result;
  }
}
