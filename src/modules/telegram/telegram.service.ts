import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { getAppEnv } from '../../common/config/env';
import { BookingNotifier } from '../booking/booking-notifier';
import {
  CONVERSATION_HANDLER,
  ConversationHandler,
} from '../../common/conversation/conversation.tokens';
import { InMemoryRateLimiter } from './rate-limiter';
import { getTashkentParts } from '../booking/tashkent-time';
import { resolveTelegramWebhookUrl } from './telegram-webhook-url';

@Injectable()
export class TelegramService
  implements OnModuleInit, OnModuleDestroy, BookingNotifier
{
  private readonly logger = new Logger(TelegramService.name);
  private bot?: Bot;
  private readonly rateLimiter = new InMemoryRateLimiter(20, 60_000);
  private pollingStarted = false;

  constructor(
    @Inject(CONVERSATION_HANDLER)
    private readonly conversation: ConversationHandler,
  ) {}

  async onModuleInit() {
    const env = getAppEnv();
    if (!env.TELEGRAM_BOT_TOKEN) {
      this.logger.warn('TELEGRAM_BOT_TOKEN is not set; Telegram bot disabled');
      return;
    }

    this.bot = new Bot(env.TELEGRAM_BOT_TOKEN);
    this.registerHandlers();

    if (env.NODE_ENV === 'production') {
      if (!env.TELEGRAM_WEBHOOK_URL || !env.TELEGRAM_WEBHOOK_SECRET) {
        this.logger.error('telegram_webhook_configuration_missing');
        return;
      }
      try {
        const url = resolveTelegramWebhookUrl(env.TELEGRAM_WEBHOOK_URL);
        await this.bot.api.setWebhook(url, {
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        });
        this.logger.log('Telegram bot webhook registered');
      } catch {
        this.logger.error('telegram_webhook_registration_failed');
      }
    } else {
      // Long polling in development. Do not await to avoid blocking app startup.
      this.bot
        .start({
          drop_pending_updates: true,
          onStart: () => {
            this.pollingStarted = true;
            this.logger.log('Telegram bot long polling started');
          },
        })
        .catch(() => {
          this.logger.error('telegram_polling_failed');
        });
    }
  }

  async onModuleDestroy() {
    if (this.bot && this.pollingStarted) {
      await this.bot.stop();
    }
  }

  getBot(): Bot | undefined {
    return this.bot;
  }

  async handleWebhookUpdate(update: unknown) {
    if (!this.bot) {
      throw new Error('Telegram bot is not initialized');
    }
    await this.bot.handleUpdate(update as any);
  }

  async setWebhook(url: string, secretToken: string) {
    if (!this.bot) {
      const env = getAppEnv();
      if (!env.TELEGRAM_BOT_TOKEN)
        throw new Error('TELEGRAM_BOT_TOKEN is not set');
      this.bot = new Bot(env.TELEGRAM_BOT_TOKEN);
    }
    await this.bot.api.setWebhook(url, { secret_token: secretToken });
  }

  async onBookingCreated(booking: any): Promise<void> {
    await this.notifyBarbers(this.formatBookingCreated(booking));
  }

  async onBookingCancelled(booking: any): Promise<void> {
    await this.notifyBarbers(this.formatBookingCancelled(booking));
  }

  private registerHandlers() {
    if (!this.bot) return;
    const env = getAppEnv();
    const barberIds = new Set(env.BARBER_TELEGRAM_IDS.map(String));

    this.bot.command('start', async (ctx) => {
      const isBarber = barberIds.has(String(ctx.from?.id ?? ''));
      const greeting =
        'Assalomu alaykum! SavdoAI barbershop qabulxonasiga xush kelibsiz.\n' +
        '\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435! \u0414\u043e\u0431\u0440\u043e \u043f\u043e\u0436\u0430\u043b\u043e\u0432\u0430\u0442\u044c \u0432 \u0431\u0430\u0440\u0431\u0435\u0440\u0448\u043e\u043f SavdoAI.\n\n' +
        'Iltimos, xabar yozing (RU/UZ). / \u041d\u0430\u043f\u0438\u0448\u0438\u0442\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 (RU/UZ).';

      if (isBarber && env.MINI_APP_URL) {
        const kb = new InlineKeyboard().webApp(
          'Open Barber Mini App',
          env.MINI_APP_URL,
        );
        await ctx.reply(greeting, { reply_markup: kb });
      } else {
        await ctx.reply(greeting);
      }
    });

    this.bot.on('message:contact', async (ctx) => {
      const userId = String(ctx.from?.id ?? '');
      if (!this.rateLimiter.allow(userId)) {
        await ctx.reply('Too many requests. Please try again later.');
        return;
      }
      const phone = ctx.message.contact?.phone_number;
      if (!phone || ctx.message.contact?.user_id !== ctx.from?.id) {
        await ctx.reply(
          'Please share your own phone number using Telegram. / Iltimos, telefon raqamingizni Telegram orqali yuboring.',
        );
        return;
      }
      const reply = await this.conversation.handleMessage({
        telegramId: userId,
        text: '[contact shared]',
        languageCode: ctx.from?.language_code,
        contactPhone: phone,
      });
      await ctx.reply(reply);
    });

    this.bot.on('message:text', async (ctx) => {
      const userId = String(ctx.from?.id ?? '');
      if (ctx.message.text.length > 4000) {
        await ctx.reply(
          'Please send a shorter message. / Iltimos, qisqaroq xabar yuboring.',
        );
        return;
      }
      if (!this.rateLimiter.allow(userId)) {
        await ctx.reply(
          "Too many requests. Please try again in a minute. / Iltimos, bir daqiqadan so'ng urinib ko'ring.",
        );
        return;
      }

      try {
        await ctx.api.sendChatAction(ctx.chat.id, 'typing');
      } catch {
        // ignore typing indicator failures
      }

      try {
        const reply = await this.conversation.handleMessage({
          telegramId: userId,
          text: ctx.message.text,
          languageCode: ctx.from?.language_code,
        });
        await ctx.reply(reply);
      } catch {
        this.logger.error('telegram_handler_failed');
        await ctx.reply(
          "Texnik muammo yuz berdi. Iltimos, qayta urinib ko'ring. / Произошла техническая ошибка, попробуйте ещё раз.",
        );
      }
    });
  }

  private async notifyBarbers(text: string) {
    if (!this.bot) return;
    const env = getAppEnv();
    for (const id of env.BARBER_TELEGRAM_IDS) {
      if (!id) continue;
      try {
        await this.bot.api.sendMessage(id, text);
      } catch {
        this.logger.warn('telegram_barber_notification_failed');
      }
    }
  }

  private formatBookingCreated(booking: any): string {
    const p = getTashkentParts(new Date(booking.startTime));
    const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    const serviceName =
      booking.service?.nameRu ||
      booking.service?.nameUz ||
      `Service #${booking.serviceId ?? '-'}`;
    return (
      `New booking confirmed\n` +
      `Service: ${serviceName}\n` +
      `Time: ${date} ${time} (Asia/Tashkent)\n` +
      `Price: ${booking.finalPrice} UZS\n` +
      `Discount: ${booking.discountPercent}%\n` +
      `Client: ${booking.clientName ?? '-'} (${booking.clientTelegramId})`
    );
  }

  private formatBookingCancelled(booking: any): string {
    const p = getTashkentParts(new Date(booking.startTime));
    const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    const serviceName =
      booking.service?.nameRu ||
      booking.service?.nameUz ||
      `Service #${booking.serviceId ?? '-'}`;
    return (
      `Booking cancelled\n` +
      `Service: ${serviceName}\n` +
      `Time: ${date} ${time} (Asia/Tashkent)\n` +
      `Client: ${booking.clientName ?? '-'} (${booking.clientTelegramId})`
    );
  }
}
