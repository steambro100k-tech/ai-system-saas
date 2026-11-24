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
  canActivate(context: ExecutionContext): boolean {
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
        (req as any).authActor = {
          type: 'barber',
          userId: String(res.value.user.id),
        };
        return true;
      }
    }

    throw new UnauthorizedException('Barber authentication required');
  }
}
