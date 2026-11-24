import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { getAppEnv } from '../../common/config/env';
import { validateTelegramInitData } from './telegram-init-data';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../../core/db/prisma.service';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return (
    left.length > 0 &&
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

@Injectable()
export class BarberOrAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { telegramUser?: any }>();
    const env = getAppEnv();

    const adminKey = req.header('x-admin-key');
    if (env.ADMIN_KEY && adminKey && safeEqual(adminKey, env.ADMIN_KEY)) {
      (req as any).authActor = { type: 'admin' };
      return true;
    }

    const initData = req.header('x-telegram-init-data');
    if (initData) {
      const res = validateTelegramInitData({
        botToken: env.TELEGRAM_BOT_TOKEN,
        initData,
        allowedTelegramIds: env.BARBER_TELEGRAM_IDS,
      });
      if (res.ok) {
        (req as any).telegramUser = res.value.user;
        const barber = await this.prisma.barber.findUnique({
          where: { telegramId: String(res.value.user.id) },
          select: { id: true },
        });
        (req as any).authActor = barber
          ? { type: 'barber', userId: String(res.value.user.id), barberId: barber.id }
          : { type: 'owner', userId: String(res.value.user.id) };
        return true;
      }
    }

    throw new UnauthorizedException('Barber authentication required');
  }
}
