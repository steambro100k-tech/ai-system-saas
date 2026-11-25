import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
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
import { PrismaService } from '../../core/db/prisma.service';

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
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    const env = getAppEnv();
    if (!env.TELEGRAM_ENABLED) {
      this.logger.log('Telegram integration disabled by TELEGRAM_ENABLED');
      return;
    }
    if (!env.TELEGRAM_BOT_TOKEN) {
      this.logger.warn('TELEGRAM_BOT_TOKEN is not set; Telegram bot disabled');
      return;
    }

    this.bot = new Bot(env.TELEGRAM_BOT_TOKEN);
    this.bot.catch((error) => {
      const status = (error.error as any)?.error_code ?? 'unknown';
      this.logger.error(`telegram_update_failed status=${status}`);
    });
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
    const adminIds = new Set(env.ADMIN_TELEGRAM_IDS.map(String));

    this.bot.command('start', async (ctx) => {
      const languageKeyboard = new InlineKeyboard()
        .text('🇺🇿 O‘zbekcha', 'lang:uz')
        .text('🇷🇺 Русский', 'lang:ru');
      await ctx.reply('Tilni tanlang / Выберите язык:', { reply_markup: languageKeyboard });
      return;

      const isBarber = barberIds.has(String(ctx.from?.id ?? ''));
      const lang = ctx.from?.language_code?.toLowerCase().startsWith('ru') ? 'ru' : 'uz';
      const miniAppUrl = this.getHttpsMiniAppUrl(env.MINI_APP_URL ?? '');
      if (isBarber && miniAppUrl) {
        const text = lang === 'ru'
          ? '👋 Добро пожаловать в SavdoAI, мастер!\n\nЗдесь вы можете следить за записями и расписанием. Откройте панель, чтобы посмотреть свой день.'
          : '👋 SavdoAI’ga xush kelibsiz, usta!\n\nYozuvlaringiz va ish jadvalingizni shu yerdan kuzatib boring. Bugungi jadvalni ochish uchun tugmani bosing.';
        const kb = new InlineKeyboard().webApp(lang === 'ru' ? '📊 Открыть расписание' : '📊 Jadvalni ochish', miniAppUrl!);
        await ctx.reply(text, { reply_markup: kb });
      } else {
        if (isBarber && env.MINI_APP_URL) {
          this.logger.warn('mini_app_url_invalid_or_not_https');
        }
        if (isBarber) {
          await ctx.reply(lang === 'ru'
            ? '👋 Добро пожаловать в SavdoAI, мастер! Сейчас панель расписания недоступна. Напишите администратору, чтобы получить ссылку.'
            : '👋 SavdoAI’ga xush kelibsiz, usta! Hozircha jadval paneli havolasi mavjud emas. Havola uchun administratorga yozing.');
          return;
        }
        const text = lang === 'ru'
          ? '👋 Здравствуйте, ' + (ctx.from?.first_name?.trim() || 'друг') + '!\nДобро пожаловать в SavdoAI Barbershop.\n\nПодберу услугу, мастера и удобное время, расскажу о цене и доступных предложениях.\n\nС чего начнём?'
          : '👋 Assalomu alaykum, ' + (ctx.from?.first_name?.trim() || 'aziz mehmon') + '!\nSavdoAI Barbershop’ga xush kelibsiz.\n\nSizga xizmat, usta va qulay vaqt tanlashda yordam beraman. Narx va mavjud takliflarni ham shu yerda bilib olasiz.\n\nNimadan boshlaymiz?';
        const keyboard = lang === 'ru'
          ? new InlineKeyboard().text('💈 Мастера', 'start:barbers').text('📅 Свободное время', 'start:slots')
          : new InlineKeyboard().text('💈 Ustalarni ko‘rish', 'start:barbers').text('📅 Bo‘sh vaqtlar', 'start:slots');
        await ctx.reply(text, { reply_markup: keyboard });
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
        languageCode: await this.getPreferredLanguage(userId) ?? ctx.from?.language_code,
        firstName: ctx.from?.first_name,
        contactPhone: phone,
      });
      await ctx.reply(reply, { reply_markup: { remove_keyboard: true } });
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
          languageCode: await this.getPreferredLanguage(userId) ?? ctx.from?.language_code,
          firstName: ctx.from?.first_name,
        });
        const asksForContact = /(kontakt.{0,50}(sifatida yubor|tugmasidan|ulash|yubor)|contact.{0,50}(share|send|button)|контакт.{0,50}(отправ|кноп|подел)|отправ.{0,30}контакт)/i.test(reply);
        if (asksForContact) {
          const lang = await this.getPreferredLanguage(userId) ?? (ctx.from?.language_code?.toLowerCase().startsWith('ru') ? 'ru' : 'uz');
          const button = lang === 'ru' ? '📱 Отправить контакт' : '📱 Kontaktni yuborish';
          const keyboard = new Keyboard().requestContact(button).resized().oneTime();
          await ctx.reply(reply, { reply_markup: keyboard });
        } else {
          await ctx.reply(reply);
        }
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
      if (action === 'lang' && (idText === 'uz' || idText === 'ru')) {
        const lang = idText;
        const telegramId = String(ctx.from.id);
        try {
          await this.prisma.chatMessage.create({
            data: { telegramId, role: 'language_preference', content: lang },
          });
          await ctx.answerCallbackQuery({ text: lang === 'ru' ? 'Язык сохранён' : 'Til saqlandi' });
          const barber = await this.prisma.barber.findUnique({
            where: { telegramId },
            select: { id: true },
          });
          const isAdmin = adminIds.has(telegramId) || (barberIds.has(telegramId) && !barber);
          if (barber || isAdmin) {
            const appUrl = this.getHttpsMiniAppUrl(env.MINI_APP_URL ?? '');
            const text = isAdmin
              ? lang === 'ru'
                ? '👋 Добро пожаловать в панель администратора SavdoAI. Откройте приложение, чтобы управлять расписанием барбершопа.'
                : '👋 SavdoAI admin paneliga xush kelibsiz. Barbershop jadvalini boshqarish uchun ilovani oching.'
              : lang === 'ru'
                ? '👋 Добро пожаловать в SavdoAI, мастер! Здесь вы можете следить за записями и расписанием.'
                : '👋 SavdoAI’ga xush kelibsiz, usta! Yozuvlaringiz va ish jadvalingizni shu yerdan kuzatib boring.';
            if (appUrl) {
              const buttonText = isAdmin
                ? lang === 'ru' ? '⚙️ Открыть панель' : '⚙️ Admin panelni ochish'
                : lang === 'ru' ? '📊 Открыть расписание' : '📊 Jadvalni ochish';
              const keyboard = new InlineKeyboard().webApp(buttonText, appUrl);
              await ctx.reply(text, { reply_markup: keyboard });
            } else {
              await ctx.reply(lang === 'ru'
                ? `${text}\n\nСсылка Mini App не настроена. В dev-режиме укажите в MINI_APP_URL HTTPS-ссылку на ваш frontend.`
                : `${text}\n\nMini App havolasi sozlanmagan. Dev rejimida MINI_APP_URL ga frontend uchun HTTPS havola kiriting.`);
            }
            return;
          }
          const welcome = lang === 'ru'
            ? `👋 Здравствуйте, ${ctx.from.first_name?.trim() || 'друг'}!\nДобро пожаловать в SavdoAI Barbershop.\n\nПомогу выбрать услугу, мастера и удобное время, а также подскажу цену и доступные предложения.\n\nС чего начнём?`
            : `👋 Assalomu alaykum, ${ctx.from.first_name?.trim() || 'aziz mehmon'}!\nSavdoAI Barbershop’ga xush kelibsiz.\n\nXizmat, usta va qulay vaqt tanlashda yordam beraman. Narxlar va takliflarni ham shu yerda bilib olasiz.\n\nNimadan boshlaymiz?`;
          const keyboard = lang === 'ru'
            ? new InlineKeyboard().text('💈 Мастера', 'start:barbers').text('📅 Свободное время', 'start:slots')
            : new InlineKeyboard().text('💈 Ustalarni ko‘rish', 'start:barbers').text('📅 Bo‘sh vaqtlar', 'start:slots');
          await ctx.reply(welcome, { reply_markup: keyboard });
        } catch (error: any) {
          this.logger.warn(`telegram_language_save_failed code=${error?.code ?? 'unknown'}`);
          await ctx.answerCallbackQuery({ text: lang === 'ru' ? 'Не удалось сохранить язык' : 'Tilni saqlab bo‘lmadi' });
        }
        return;
      }
      if (action === 'start') {
        const lang = await this.getPreferredLanguage(String(ctx.from.id)) ?? (ctx.from.language_code?.toLowerCase().startsWith('ru') ? 'ru' : 'uz');
        const text = idText === 'barbers'
          ? (lang === 'ru' ? 'Покажите список мастеров' : 'Ustalar ro‘yxatini ko‘rsating')
          : (lang === 'ru' ? 'Какие есть свободные слоты на сегодня?' : 'Bugun bo‘sh vaqtlar bormi?');
        await ctx.answerCallbackQuery();
        try {
          const reply = await this.conversation.handleMessage({
            telegramId: String(ctx.from.id), text, languageCode: lang,
            firstName: ctx.from.first_name,
          });
          await ctx.reply(reply);
        } catch {
          await ctx.reply(lang === 'ru'
            ? 'Не удалось загрузить информацию. Напишите, пожалуйста, ещё раз.'
            : 'Ma’lumotni hozir yuklay olmadim. Iltimos, yana bir bor yozib yuboring.');
        }
        return;
      }
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

  private getHttpsMiniAppUrl(value: string): string | undefined {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }

  private async getPreferredLanguage(telegramId: string): Promise<'uz' | 'ru' | undefined> {
    const preference = await this.prisma.chatMessage.findFirst({
      where: { telegramId, role: 'language_preference' },
      orderBy: { createdAt: 'desc' },
      select: { content: true },
    });
    return preference?.content === 'uz' || preference?.content === 'ru'
      ? preference.content
      : undefined;
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
