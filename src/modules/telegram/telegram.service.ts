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
import { BookingService } from '../booking/booking.service';
import { BookingMessageService } from '../booking/booking-message.service';

@Injectable()
export class TelegramService
  implements OnModuleInit, OnModuleDestroy, BookingNotifier
{
  private readonly logger = new Logger(TelegramService.name);
  private bot?: Bot;
  private readonly rateLimiter = new InMemoryRateLimiter(20, 60_000);
  private pollingStarted = false;
  private readonly pendingCancellationConfirmations = new Map<string, number>();

  constructor(
    @Inject(CONVERSATION_HANDLER)
    private readonly conversation: ConversationHandler,
    private readonly bookingService: BookingService,
    private readonly bookingMessages: BookingMessageService,
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

  async onBookingCreated(booking: any): Promise<{ clientConfirmationSent: boolean }> {
    await this.notifyBarbers(this.formatBookingCreated(booking), booking.barber?.telegramId);
    return { clientConfirmationSent: await this.sendClientConfirmation(booking) };
  }

  async onBookingCancelled(booking: any): Promise<void> {
    await this.notifyBarbers(this.formatBookingCancelled(booking), booking.barber?.telegramId);
  }

  async sendClientConfirmation(booking: any): Promise<boolean> {
    if (!this.bot) return false;
    try {
      await this.bot.api.sendMessage(
        booking.clientTelegramId,
        this.bookingMessages.renderConfirmation(booking, getAppEnv().SHOP_ADDRESS),
        { parse_mode: 'HTML' },
      );
      return true;
    } catch (error: any) {
      this.logger.warn(`telegram_client_confirmation_failed status=${error?.error?.error_code ?? error?.status ?? 'unknown'}`);
      return false;
    }
  }

  async sendClientReminder(booking: any): Promise<void> {
    if (!this.bot) {
      const error: any = new Error('Telegram bot is not initialized');
      error.code = 'ECONNABORTED';
      throw error;
    }
    const lang = booking.clientLang === 'ru' ? 'ru' : 'uz';
    const keyboard = new InlineKeyboard()
      .text(lang === 'ru' ? '✅ Приду' : '✅ Kelaman', `confirm:${booking.id}`)
      .text(lang === 'ru' ? '❌ Отменить' : '❌ Bekor qilish', `cancel:${booking.id}`);
    await this.bot.api.sendMessage(
      booking.clientTelegramId,
      this.bookingMessages.renderReminder(booking, new Date()),
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
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
        firstName: ctx.from?.first_name,
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
          firstName: ctx.from?.first_name,
        });
        await ctx.reply(reply);
      } catch {
        this.logger.error('telegram_handler_failed');
        await ctx.reply(
          "Texnik muammo yuz berdi. Iltimos, qayta urinib ko'ring. / Произошла техническая ошибка, попробуйте ещё раз.",
        );
      }
    });

    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const [action, idText] = data.split(':');
      const bookingId = /^\d+$/.test(idText ?? '') ? Number(idText) : NaN;
      const telegramId = String(ctx.from.id);
      try {
        if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
          await ctx.answerCallbackQuery({ text: 'This reminder is no longer active.' });
          return;
        }
        if (action === 'confirm') {
          const booking = await this.bookingService.confirmClientBooking(bookingId, telegramId);
          if (!booking) {
            await ctx.answerCallbackQuery({ text: 'This reminder is no longer active.' });
            return;
          }
          await ctx.answerCallbackQuery();
          const lang = booking.clientLang === 'ru' ? 'ru' : 'uz';
          await ctx.editMessageText(lang === 'ru' ? 'Спасибо, будем ждать! ✅' : 'Rahmat, kutamiz! ✅', {
            reply_markup: { inline_keyboard: [] },
          });
          return;
        }
        if (action === 'cancel') {
          const booking = await this.bookingService.getClientReminderBooking(bookingId, telegramId);
          if (!booking) {
            await ctx.answerCallbackQuery({ text: 'This reminder is no longer active.' });
            return;
          }
          await ctx.answerCallbackQuery();
          const lang = booking.clientLang === 'ru' ? 'ru' : 'uz';
          this.pendingCancellationConfirmations.set(`${telegramId}:${bookingId}`, Date.now() + 5 * 60_000);
          const keyboard = new InlineKeyboard()
            .text(lang === 'ru' ? 'Да' : 'Ha', `cancel_yes:${bookingId}`)
            .text(lang === 'ru' ? 'Нет' : "Yo'q", `cancel_no:${bookingId}`);
          await ctx.editMessageText(this.bookingMessages.renderReminderCancelQuestion(lang), {
            reply_markup: keyboard,
          });
          return;
        }
        if (action === 'cancel_yes') {
          const confirmationKey = `${telegramId}:${bookingId}`;
          const expiresAt = this.pendingCancellationConfirmations.get(confirmationKey);
          if (!expiresAt || expiresAt < Date.now()) {
            this.pendingCancellationConfirmations.delete(confirmationKey);
            await ctx.answerCallbackQuery({ text: 'This reminder is no longer active.' });
            return;
          }
          this.pendingCancellationConfirmations.delete(confirmationKey);
          const booking = await this.bookingService.cancelClientBookingFromReminder(bookingId, telegramId);
          if (!booking) {
            await ctx.answerCallbackQuery({ text: 'This reminder is no longer active.' });
            return;
          }
          await ctx.answerCallbackQuery();
          const lang = booking.clientLang === 'ru' ? 'ru' : 'uz';
          await ctx.editMessageText(lang === 'ru' ? 'Запись отменена.' : 'Yozilishingiz bekor qilindi.', {
            reply_markup: { inline_keyboard: [] },
          });
          return;
        }
        if (action === 'cancel_no') {
          const confirmationKey = `${telegramId}:${bookingId}`;
          if (!this.pendingCancellationConfirmations.has(confirmationKey)) {
            await ctx.answerCallbackQuery({ text: 'This reminder is no longer active.' });
            return;
          }
          this.pendingCancellationConfirmations.delete(confirmationKey);
          const booking = await this.bookingService.getClientReminderBooking(bookingId, telegramId);
          if (!booking) {
            await ctx.answerCallbackQuery({ text: 'This reminder is no longer active.' });
            return;
          }
          await ctx.answerCallbackQuery();
          const lang = booking.clientLang === 'ru' ? 'ru' : 'uz';
          await ctx.editMessageText(lang === 'ru' ? 'Хорошо, запись остаётся.' : 'Yaxshi, yozilishingiz qoldirildi.', {
            reply_markup: { inline_keyboard: [] },
          });
          return;
        }
        await ctx.answerCallbackQuery();
      } catch (error: any) {
        this.logger.warn(`telegram_booking_callback_failed action=${action} code=${error?.error?.error_code ?? error?.code ?? 'unknown'}`);
        try {
          await ctx.answerCallbackQuery({ text: 'This reminder is no longer active.' });
        } catch {
          // Ignore expired Telegram callback query ids.
        }
      }
    });
  }

  private async notifyBarbers(text: string, assignedBarberTelegramId?: string | null) {
    if (!this.bot) return;
    const env = getAppEnv();
    const ids = new Set([...env.BARBER_TELEGRAM_IDS, ...(assignedBarberTelegramId ? [assignedBarberTelegramId] : [])].map(String));
    for (const id of ids) {
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
    const barberName = booking.barber?.nameUz || booking.barber?.name || '-';
    return (
      `New booking confirmed\n` +
      `Service: ${serviceName}\n` +
      `Master: ${barberName}\n` +
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
    const barberName = booking.barber?.nameUz || booking.barber?.name || '-';
    return (
      `Booking cancelled\n` +
      `Service: ${serviceName}\n` +
      `Master: ${barberName}\n` +
      `Time: ${date} ${time} (Asia/Tashkent)\n` +
      `Price: ${booking.finalPrice} UZS\n` +
      `Discount: ${booking.discountPercent}%\n` +
      `Client: ${booking.clientName ?? '-'} (${booking.clientTelegramId})`
    );
  }
}
