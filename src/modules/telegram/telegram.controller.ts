import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { timingSafeEqual } from 'crypto';
import { getAppEnv } from '../../common/config/env';
import { TelegramService } from './telegram.service';

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Post('webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async webhook(
    @Body() update: unknown,
    @Headers('x-telegram-bot-api-secret-token') secret?: string,
  ) {
    const env = getAppEnv();
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      throw new BadRequestException('Webhook secret is not configured');
    }
    if (!secret || !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    await this.telegram.handleWebhookUpdate(update);
    return { ok: true };
  }
}
