import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../core/db/prisma.service';
import { getAppEnv } from '../../common/config/env';
import { BOOKING_NOTIFIER, BookingNotifier } from './booking-notifier';

function isRealTelegramId(value: string): boolean {
  return /^\d{1,20}$/.test(value) && BigInt(value) > 0n;
}

export type ReminderCandidate = {
  status: string;
  clientTelegramId: string;
  startTime: Date;
  createdAt: Date;
  reminderSentAt: Date | null;
};

export function isReminderCandidate(
  booking: ReminderCandidate,
  now: Date,
  leadMinutes: number,
): boolean {
  const start = booking.startTime.getTime();
  const nowMs = now.getTime();
  return booking.status === 'CONFIRMED'
    && isRealTelegramId(booking.clientTelegramId)
    && booking.reminderSentAt === null
    && start > nowMs
    && start <= nowMs + leadMinutes * 60_000
    && booking.createdAt.getTime() <= start - leadMinutes * 60_000;
}

function telegramErrorStatus(error: any): number | undefined {
  const status = error?.error?.error_code ?? error?.status ?? error?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function isRetryableTelegramError(error: any): boolean {
  const status = telegramErrorStatus(error);
  const code = String(error?.code ?? error?.cause?.code ?? '');
  return status === 429 || (status !== undefined && status >= 500)
    || ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN'].includes(code);
}

@Injectable()
export class BookingReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingReminderService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly moduleRef: ModuleRef) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.runOnce(), 60_000);
    this.timer.unref?.();
    void this.runOnce();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private getNotifier(): BookingNotifier | undefined {
    try {
      return this.moduleRef.get(BOOKING_NOTIFIER, { strict: false });
    } catch {
      return undefined;
    }
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const leadMinutes = getAppEnv().REMINDER_LEAD_MIN;
      const bookings = await this.prisma.booking.findMany({
        where: {
          status: 'CONFIRMED',
          reminderSentAt: null,
          startTime: { gt: now, lte: new Date(now.getTime() + leadMinutes * 60_000) },
        },
        include: { service: true, barber: true },
        orderBy: { startTime: 'asc' },
      });
      for (const booking of bookings) {
        if (isReminderCandidate(booking, now, leadMinutes)) {
          await this.claimAndSend(booking, now);
        }
      }
    } catch (error: any) {
      this.logger.warn(`booking_reminder_scan_failed code=${error?.code ?? error?.name ?? 'unknown'}`);
    } finally {
      this.running = false;
    }
  }

  async sendImmediately(id: number): Promise<{ sent: boolean; blocked?: boolean }> {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: { service: true, barber: true },
    });
    if (!booking || booking.status !== 'CONFIRMED' || !isRealTelegramId(booking.clientTelegramId)) {
      return { sent: false };
    }
    await this.prisma.booking.updateMany({
      where: { id, status: 'CONFIRMED' },
      data: { reminderSentAt: null },
    });
    return this.claimAndSend(booking, new Date(), true);
  }

  private async claimAndSend(
    booking: any,
    now: Date,
    force = false,
  ): Promise<{ sent: boolean; blocked?: boolean }> {
    if (!force && !isReminderCandidate(booking, now, getAppEnv().REMINDER_LEAD_MIN)) return { sent: false };
    const notifier = this.getNotifier();
    if (!notifier?.sendClientReminder) return { sent: false };
    const claimTime = new Date();
    const claim = await this.prisma.booking.updateMany({
      where: { id: booking.id, status: 'CONFIRMED', reminderSentAt: null, startTime: { gt: new Date() } },
      data: { reminderSentAt: claimTime },
    });
    if (claim.count !== 1) return { sent: false };

    try {
      await notifier.sendClientReminder(booking);
      return { sent: true };
    } catch (error: any) {
      const status = telegramErrorStatus(error);
      if (status === 403) {
        this.logger.log('booking_reminder_client_blocked_bot');
        return { sent: false, blocked: true };
      }
      if (isRetryableTelegramError(error)) {
        await this.prisma.booking.updateMany({
          where: { id: booking.id, reminderSentAt: claimTime },
          data: { reminderSentAt: null },
        });
      }
      this.logger.warn(`booking_reminder_send_failed status=${status ?? 'unknown'} retryable=${isRetryableTelegramError(error)}`);
      return { sent: false };
    }
  }
}
