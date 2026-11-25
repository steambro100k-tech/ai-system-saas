import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../core/db/prisma.service';
import { BookingService } from '../booking/booking.service';
import { BargainService } from '../booking/bargain.service';
import {
  ConversationHandler,
  ConversationInput,
} from '../../common/conversation/conversation.tokens';
import {
  LlmClient,
  LlmMessage,
  LlmToolDefinition,
} from './llm-client.interface';
import { OpenAiLlmClient } from './openai-llm.client';
import { buildSystemPrompt } from './system-prompt';
import { formatTashkentDate, getTashkentParts } from '../booking/tashkent-time';
import { parseStartTimeIso } from '../booking/booking.utils';

const MAX_TOOL_ITERATIONS = 5;
const PENDING_CONFIRMATION_TTL_MS = 10 * 60_000;

type PendingBookingConfirmation = {
  serviceId: number;
  serviceNameRu: string;
  serviceNameUz: string;
  startTimeIso: string;
  barberId: number;
  barberName: string;
  discountPercent: number;
  finalPrice: number;
  expiresAt: number;
};

class LlmTransportFailure extends Error {
  constructor(readonly original: unknown) {
    super('LLM transport failed');
  }
}

function isAffirmative(text: string): boolean {
  return /^(ha|xa|yes|yeah|yep|ok|okay|mayli|tasdiqlayman|tasdiqlay|bo'?ladi|да|подтверждаю|подтверждаю|записывайте)(?:[\s,.!?].{0,40})?$/iu.test(
    text.trim(),
  );
}

function normalizePhrase(value: string): string {
  return value.toLocaleLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function mentionsPrice(text: string, price: number): boolean {
  const digits = text.replace(/\D/g, '');
  if (digits.includes(String(price))) return true;
  if (price % 1000 !== 0) return false;
  const thousands = String(price / 1000);
  return new RegExp(`\\b${thousands}\\s*(ming|тыс(?:яч)?|k)\\b`, 'i').test(
    text,
  );
}

function explicitlyOffersConfirmation(
  text: string,
  offer: PendingBookingConfirmation,
): boolean {
  const normalized = normalizePhrase(text);
  const asksToConfirm =
    /(tasdiq|yozib qo'y|yozib qo‘|band qil|yozilishni xohl|xohlaysizmi|подтверд|записать|запиш|забронировать|shall i book|confirm|book this)/i.test(
      normalized,
    );
  const serviceMentioned = [offer.serviceNameRu, offer.serviceNameUz]
    .filter(Boolean)
    .some((serviceName) => normalized.includes(normalizePhrase(serviceName)));
  const barberMentioned = normalized.includes(normalizePhrase(offer.barberName));
  const start = parseStartTimeIso(offer.startTimeIso);
  const local = getTashkentParts(start);
  const time = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
  const timeMentioned = normalized.includes(time) || normalized.includes(time.replace(':', '.'));
  const date = formatTashkentDate(start);
  const [year, month, day] = date.split('-');
  const uzbekMonths = [
    ['yanvar'],
    ['fevral'],
    ['mart'],
    ['aprel'],
    ['may'],
    ['iyun'],
    ['iyul'],
    ['avgust'],
    ['sentabr', 'sentyabr'],
    ['oktabr', 'oktyabr'],
    ['noyabr'],
    ['dekabr'],
  ];
  const monthNameMentioned = (uzbekMonths[Number(month) - 1] ?? []).some(
    (monthName) =>
      new RegExp(`\\b${day}[-\\s.]*(?:${monthName})\\b`, 'i').test(normalized),
  );
  const dateMentioned =
    normalized.includes(date) ||
    normalized.includes(`${day}.${month}.${year}`) ||
    normalized.includes(`${day}.${month}`) ||
    monthNameMentioned ||
    /\b(ertaga|tomorrow|завтра)\b/i.test(normalized);
  return (
    asksToConfirm &&
    serviceMentioned &&
    barberMentioned &&
    timeMentioned &&
    dateMentioned &&
    mentionsPrice(text, offer.finalPrice)
  );
}

function getMemoryLimit(): number {
  const value = Number(process.env.AI_MEMORY_LIMIT ?? 20);
  return Number.isInteger(value) && value >= 10 && value <= 50 ? value : 20;
}

function isBarberListRequest(text: string): boolean {
  const normalized = text
    .toLocaleLowerCase()
    .replace(/[ʻʼ`’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const mentionsBarber = /\b(usta|ustalar|ustalarni|ustalarimiz|master|masters|барбер|барберы|мастер|мастера|мастеров)\b/i.test(normalized);
  const asksForList = /\b(ro'yxat|ruyxat|royxat|ro'yxatini|ruyxatini|royxatini|list|список|имена|kimlar)\b/i.test(normalized);
  return mentionsBarber && asksForList;
}

@Injectable()
export class AiService implements ConversationHandler {
  private readonly logger = new Logger(AiService.name);
  private readonly llm: LlmClient;
  private readonly pendingConfirmations = new Map<
    string,
    PendingBookingConfirmation
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingService: BookingService,
    private readonly bargainService: BargainService,
  ) {
    this.llm = new OpenAiLlmClient();
  }

  async handleMessage(input: ConversationInput): Promise<string> {
    const userText = this.composeUserText(input);
    const startedAt = Date.now();
    let iteration = 0;
    const pending = this.pendingConfirmations.get(input.telegramId);
    const confirmedOffer =
      pending && pending.expiresAt > Date.now() && isAffirmative(userText)
        ? pending
        : undefined;
    if (pending && !confirmedOffer) {
      this.pendingConfirmations.delete(input.telegramId);
    }
    let offerCandidate: PendingBookingConfirmation | undefined;
    try {
      await this.prisma.chatMessage.create({
        data: { telegramId: input.telegramId, role: 'user', content: userText },
      });

      if (isBarberListRequest(input.text ?? '')) {
        const barbers = await this.bookingService.listBarbers();
        const isRussian = /[\u0400-\u04ff]/.test(input.text ?? '');
        const reply = barbers.length
          ? isRussian
            ? `Наши мастера:\n${barbers.map((barber: any) => `• ${barber.nameRu || barber.name}`).join('\n')}`
            : `Ustalarimiz:\n${barbers.map((barber: any) => `• ${barber.nameUz || barber.name}`).join('\n')}`
          : isRussian
            ? 'Сейчас список мастеров недоступен. Напишите нам немного позже.'
            : "Hozircha faol ustalar ro'yxati topilmadi. Iltimos, keyinroq yozing.";
        await this.prisma.chatMessage.create({
          data: { telegramId: input.telegramId, role: 'assistant', content: reply },
        });
        return reply;
      }

      const history = await this.prisma.chatMessage.findMany({
        where: {
          telegramId: input.telegramId,
          role: { in: ['user', 'assistant'] },
        },
        orderBy: { createdAt: 'desc' },
        take: getMemoryLimit(),
      });
      const orderedHistory = history.reverse();
      const clientLang = this.detectClientLanguage(input, orderedHistory.map((msg: any) => msg.content));

      const now = new Date();
      const p = getTashkentParts(now);
      const tashkentNowIso = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')} +05:00`;
      const systemPrompt = buildSystemPrompt({
        tashkentNowIso,
        tashkentDate: formatTashkentDate(now),
      });

      const messages: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
      ];
      for (const msg of orderedHistory) {
        if (msg.role === 'user')
          messages.push({ role: 'user', content: msg.content });
        else if (msg.role === 'assistant')
          messages.push({ role: 'assistant', content: msg.content });
      }

      const tools = this.getToolDefinitions();
      let finalText = '';
      let bookingCreated: boolean | undefined;
      let confirmationSent = false;

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        iteration = i;
        let completion;
        try {
          completion = await this.llm.createChatCompletion({
            messages,
            tools,
            toolChoice: 'auto',
            temperature: 0.2,
            iteration: i,
          });
        } catch (error) {
          throw new LlmTransportFailure(error);
        }
        const assistant = completion.message;

        if (assistant.tool_calls && assistant.tool_calls.length > 0) {
          messages.push({
            role: 'assistant',
            content: assistant.content ?? null,
            tool_calls: assistant.tool_calls,
          });

          for (const tc of assistant.tool_calls) {
            const result = await this.executeTool(
              tc.function.name,
              tc.function.arguments,
              { ...input, detectedLanguage: clientLang },
              i,
              confirmedOffer,
            );
            if (tc.function.name === 'get_offer' && !result?.error && result?.barberId) {
              offerCandidate = {
                serviceId: Number(result.serviceId),
                serviceNameRu: String(result.serviceNameRu ?? ''),
                serviceNameUz: String(result.serviceNameUz ?? ''),
                startTimeIso: String(result.startTimeIso),
                barberId: Number(result.barberId),
                barberName: String(result.barberName ?? ''),
                discountPercent: Number(result.maxDiscountPercent ?? 0),
                finalPrice: Number(result.finalPriceAtMax ?? result.basePrice),
                expiresAt: Date.now() + PENDING_CONFIRMATION_TTL_MS,
              };
            }
            if (
              tc.function.name === 'create_booking' &&
              result?.ok === true
            ) {
              this.pendingConfirmations.delete(input.telegramId);
              bookingCreated = true;
              confirmationSent = result.confirmationSent === true;
            }
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify(result),
            });
          }
          continue;
        }

        finalText = (assistant.content || '').trim();
        if (!finalText) {
          finalText = this.fallbackReply(userText, input.languageCode);
        }
        break;
      }

      if (!finalText) {
        finalText = this.fallbackReply(userText, input.languageCode);
      }

      if (bookingCreated) {
        finalText = this.bookingConfirmationReply(clientLang, confirmationSent);
      }

      if (
        offerCandidate &&
        explicitlyOffersConfirmation(finalText, offerCandidate)
      ) {
        this.pendingConfirmations.set(input.telegramId, offerCandidate);
      }

      await this.prisma.chatMessage.create({
        data: {
          telegramId: input.telegramId,
          role: 'assistant',
          content: finalText,
        },
      });

      return finalText;
    } catch (err: any) {
      const elapsedMs = Date.now() - startedAt;
      const isLlmTransportFailure = err instanceof LlmTransportFailure;
      const originalError = isLlmTransportFailure ? err.original : err;
      const status =
        (originalError as any)?.status ??
        (originalError as any)?.response?.status ??
        (/timeout|timed out/i.test(String((originalError as any)?.message || originalError))
          ? 'timeout'
          : 'unknown');
      const model =
        (originalError as any)?.model ??
        process.env.OPENAI_MODEL ??
        process.env.GEMINI_MODEL ??
        'gpt-4o-mini';
      if (isLlmTransportFailure) {
        this.logger.warn(
          `ai_transport_failure model=${model} status=${status} elapsed_ms=${elapsedMs} iteration=${iteration}`,
        );
        return this.fallbackReply(userText, input.languageCode, status);
      }
      this.logger.warn(
        `ai_internal_failure iteration=${iteration} error=${this.safeErrorCode(originalError)}`,
      );
      return this.internalFailureReply(input.languageCode);
    }
  }

  private composeUserText(input: ConversationInput): string {
    if (input.contactPhone) {
      return `[Client shared phone number: ${input.contactPhone}] ${input.text || ''}`.trim();
    }
    return input.text || '';
  }

  private detectClientLanguage(input: ConversationInput, history: string[] = []): 'uz' | 'ru' {
    const configured = input.languageCode?.toLowerCase();
    if (configured?.startsWith('ru')) return 'ru';
    if (configured?.startsWith('uz')) return 'uz';
    const recentText = [...history.slice(-8), input.text].join(' ').toLowerCase();
    if (/[\u045e\u049b\u0493\u04b3\u04af\u04e9\u0493]/i.test(recentText)) return 'uz';
    if (/[\u0400-\u04ff]/.test(recentText)) return 'ru';
    if (/\b(salom|ertaga|bugun|soch|rahmat|ha|xa|kerak|xizmat)\b/i.test(recentText)) return 'uz';
    return 'uz';
  }

  private bookingConfirmationReply(lang: 'uz' | 'ru', sent: boolean): string {
    if (lang === 'ru') {
      return sent
        ? 'Запись создана, подтверждение отправлено в Telegram. До встречи!'
        : 'Запись создана, но не удалось отправить сообщение с подтверждением.';
    }
    return sent
      ? 'Yozilishingiz tasdiqlandi, Telegramga xabar yuborildi. Ko‘rishguncha!'
      : 'Yozilishingiz yaratildi, ammo tasdiqlash xabarini yubora olmadik.';
  }

  private fallbackReply(
    text: string,
    languageCode?: string,
    status?: number | string,
  ): string {
    const uzbekHints =
      /[\u045e\u049b\u0493\u04b3]|\b(salom|rahmat|soch|turmak|soat|ertaga|bugun|skidka|iltimos|narx|xizmat)\b/i;
    const cyrillic = /[\u0400-\u04ff]/;
    if (status === 429) {
      if (
        languageCode?.toLowerCase().startsWith('uz') ||
        uzbekHints.test(text)
      ) {
        return "Xizmat vaqtincha band. Iltimos, keyinroq qayta urinib ko'ring.";
      }
      if (cyrillic.test(text)) {
        return '\u0421\u0435\u0440\u0432\u0438\u0441 \u0432\u0440\u0435\u043c\u0435\u043d\u043d\u043e \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u043f\u043e\u0437\u0436\u0435.';
      }
      return "Xizmat vaqtincha band. Keyinroq qayta urinib ko'ring. / \u0421\u0435\u0440\u0432\u0438\u0441 \u0432\u0440\u0435\u043c\u0435\u043d\u043d\u043e \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u043f\u043e\u0437\u0436\u0435.";
    }
    if (languageCode?.toLowerCase().startsWith('uz') || uzbekHints.test(text)) {
      return "Texnik muammo yuz berdi. Iltimos, birozdan so'ng qayta urinib ko'ring.";
    }
    if (cyrillic.test(text)) {
      return '\u041f\u0440\u043e\u0438\u0437\u043e\u0448\u043b\u0430 \u0442\u0435\u0445\u043d\u0438\u0447\u0435\u0441\u043a\u0430\u044f \u043e\u0448\u0438\u0431\u043a\u0430. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437 \u043f\u043e\u0437\u0436\u0435.';
    }
    return "Texnik muammo yuz berdi. Iltimos, qayta urinib ko'ring. / \u041f\u0440\u043e\u0438\u0437\u043e\u0448\u043b\u0430 \u0442\u0435\u0445\u043d\u0438\u0447\u0435\u0441\u043a\u0430\u044f \u043e\u0448\u0438\u0431\u043a\u0430. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437.";
  }

  private safeErrorCode(error: unknown): string {
    const e = error as any;
    const code = e?.code ?? e?.response?.code ?? e?.getStatus?.();
    if (code === 'P2022') return 'P2022';
    return String(code ?? e?.name ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'unknown';
  }

  private internalFailureReply(languageCode?: string): string {
    return languageCode?.toLowerCase().startsWith('ru')
      ? 'Не удалось обработать запрос. Попробуйте ещё раз чуть позже.'
      : 'So‘rovni bajarib bo‘lmadi. Iltimos, birozdan so‘ng qayta urinib ko‘ring.';
  }

  private toolError(message: string, hint: string, extra: Record<string, unknown> = {}) {
    return { error: message, hint, ...extra };
  }

  private loggedToolError(name: string, iteration: number, message: string, hint: string, code: string, extra: Record<string, unknown> = {}) {
    this.logger.warn(`ai_tool_error name=${name} iteration=${iteration} code=${code} detail=${message.slice(0, 180)}`);
    return this.toolError(message, hint, extra);
  }

  private getToolDefinitions(): LlmToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'list_services',
          description:
            'List available barbershop services with prices and durations',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_available_slots',
          description:
            'Get free slots for a date (Asia/Tashkent) with max discount and available barber ids. If barberId is omitted, availability is aggregated across active barbers.',
          parameters: {
            type: 'object',
            properties: {
              date: {
                type: 'string',
                description:
                  'Date in YYYY-MM-DD (Asia/Tashkent). Defaults to today.',
              },
              serviceId: {
                type: 'integer',
                description:
                  'Optional service ID to return slots that fit its full duration',
              },
              barberId: { type: 'integer', description: 'Optional barber ID. Omit to see aggregate availability and freeBarberIds.' },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'list_barbers',
          description: 'List active barbers by id and name. Tell the client they may choose a name or say any master / farqi yo\'q / любой.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_offer',
          description:
            'Get backend-calculated discount/bonus offer for a service and exact slot',
          parameters: {
            type: 'object',
            properties: {
              serviceId: { type: 'integer' },
              barberId: { type: 'integer', description: 'Selected active barber ID' },
              startTimeIso: {
                type: 'string',
                description:
                  'ISO 8601 datetime with the Asia/Tashkent +05:00 offset, for example 2026-11-25T13:00:00+05:00. UTC Z is also accepted.',
              },
            },
            required: ['serviceId', 'startTimeIso'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'create_booking',
          description:
            'Create a booking for the current client only after they explicitly confirmed service, master, Tashkent date/time, and final price in a later message. barberId must be selected from list_barbers and confirmed. Send startTimeIso as ISO 8601 with +05:00, e.g. 2026-11-25T13:00:00+05:00. Backend recalculates and validates price, discount, and availability.',
          parameters: {
            type: 'object',
            properties: {
              serviceId: { type: 'integer' },
              barberId: { type: 'integer', description: 'Selected barber ID; choose from list_barbers and confirm this master with the client.' },
              startTimeIso: {
                type: 'string',
                description:
                  'ISO 8601 datetime with +05:00 for Asia/Tashkent, e.g. 2026-11-25T13:00:00+05:00. UTC Z is also accepted.',
              },
              discountPercent: {
                type: 'integer',
                description: 'Requested discount percent; backend enforces max',
              },
              clientName: { type: 'string' },
              clientPhone: { type: 'string' },
            },
            required: ['serviceId', 'startTimeIso'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cancel_booking',
          description: 'Cancel a booking owned by the current client',
          parameters: {
            type: 'object',
            properties: { bookingId: { type: 'integer' } },
            required: ['bookingId'],
            additionalProperties: false,
          },
        },
      },
    ];
  }

  private async executeTool(
    name: string,
    argsJson: string,
    input: ConversationInput & { detectedLanguage?: 'uz' | 'ru' },
    iteration: number,
    confirmedOffer?: PendingBookingConfirmation,
  ): Promise<any> {
    let args: unknown = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      const result = this.toolError('Tool arguments are not valid JSON.', 'Retry with a JSON object matching the tool schema.');
      this.logger.warn(`ai_tool_error name=${name} iteration=${iteration} code=invalid_json`);
      return result;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      const result = this.toolError('Tool arguments must be a JSON object.', 'Retry with an object matching the tool schema.');
      this.logger.warn(`ai_tool_error name=${name} iteration=${iteration} code=invalid_arguments`);
      return result;
    }
    const values = args as Record<string, unknown>;

    try {
      this.logger.debug(`ai_tool_call name=${name}`);
      switch (name) {
        case 'list_services': {
          const services = await this.bookingService.listServices();
          return { services };
        }
        case 'list_barbers': {
          const barbers = await this.bookingService.listBarbers();
          return { barbers, anyMasterOption: "any master / farqi yo'q / любой" };
        }
        case 'get_available_slots': {
          const date = typeof values.date === 'string' ? values.date : undefined;
          const serviceId =
            values.serviceId === undefined ? undefined : Number(values.serviceId);
          const service =
            serviceId === undefined
              ? undefined
              : (await this.bookingService.listServices()).find(
                  (item) => item.id === serviceId,
                );
          if (serviceId !== undefined && !service)
            return this.loggedToolError(name, iteration, 'Service not found.', 'Call list_services and retry with a valid serviceId.', 'service_not_found');
          const daySlots = await this.bookingService.getSlots(date, values.barberId === undefined ? undefined : Number(values.barberId));
          const barbers = await this.bookingService.listBarbers();
          const slotsByStart = new Map(
            daySlots.slots.map((slot: any) => [slot.startTimeIso, slot]),
          );
          const free = daySlots.slots
            .filter((s: any) => {
              const start = new Date(s.startTimeIso);
              if (s.status !== 'FREE' || start.getTime() <= Date.now())
                return false;
              for (
                let offset = 0;
                offset < (service?.durationMin ?? 30);
                offset += 30
              ) {
                const nextStart = new Date(
                  start.getTime() + offset * 60_000,
                ).toISOString();
                const next = slotsByStart.get(nextStart) as any;
                if (!next) return false;
                if (values.barberId !== undefined && next.status !== 'FREE') return false;
                if (values.barberId === undefined && !(s.freeBarberIds ?? []).some((id: number) => (next.freeBarberIds ?? []).includes(id))) return false;
              }
              return true;
            })
            .map((s: any) => ({
              time: s.time,
              startTimeIso: s.startTimeIso,
              maxDiscountPercent: s.offer?.maxDiscountPercent ?? 0,
              canDiscount: s.offer?.canDiscount ?? false,
              bonus: s.offer?.bonus ?? null,
              reason: s.offer?.reason ?? null,
              freeBarberIds: s.freeBarberIds ?? [],
              availableBarbers: barbers.filter((barber: any) => (s.freeBarberIds ?? []).includes(barber.id)),
            }));
          return {
            date: daySlots.date,
            timezone: daySlots.timezone,
            barberId: values.barberId === undefined ? undefined : Number(values.barberId),
            freeSlots: free,
          };
        }
        case 'get_offer': {
          const serviceId = Number(values.serviceId);
          const startTimeIso = String(values.startTimeIso || '');
          const services = await this.bookingService.listServices();
          const service = services.find((s) => s.id === serviceId);
          if (!service) return this.loggedToolError(name, iteration, 'Service not found.', 'Call list_services and retry with a valid serviceId.', 'service_not_found');
          const start = parseStartTimeIso(startTimeIso);
          const barberId = values.barberId === undefined ? undefined : Number(values.barberId);
          const barber = barberId === undefined ? undefined : (await this.bookingService.listBarbers()).find((item: any) => item.id === barberId);
          if (barberId !== undefined && !barber) return this.loggedToolError(name, iteration, 'Barber not found.', 'Call list_barbers and retry with a valid barberId.', 'barber_not_found');
          if (barberId !== undefined) {
            const selectedBarber = barber!;
            const day = await this.bookingService.getSlots(formatTashkentDate(start), barberId);
            const slotsByStart = new Map(day.slots.map((slot: any) => [slot.startTimeIso, slot]));
            let available = true;
            for (let offset = 0; offset < service.durationMin; offset += 30) {
              const slotIso = new Date(start.getTime() + offset * 60_000).toISOString();
              if ((slotsByStart.get(slotIso) as any)?.status !== 'FREE') {
                available = false;
                break;
              }
            }
            if (!available) {
              const alternatives = await this.bookingService.findAlternativeSlots(start, service.durationMin, 5, barberId);
              return this.loggedToolError(name, iteration, `${selectedBarber.nameUz || selectedBarber.name} is not available for this time.`, 'Use the alternatives returned here to offer another available master or nearby time, then ask the client to choose.', 'barber_slot_busy', { alternatives });
            }
          }
          const offer = this.bargainService.evaluate(
            start,
            service.price,
          );
          return {
            serviceId: service.id,
            serviceNameRu: service.nameRu,
            serviceNameUz: service.nameUz,
            basePrice: service.price,
            durationMin: service.durationMin,
            startTimeIso: start.toISOString(),
            barberId: barber?.id,
            barberName: barber?.nameUz || barber?.name,
            ...offer,
          };
        }
        case 'create_booking': {
          const serviceId = Number(values.serviceId);
          const barberId = values.barberId === undefined ? confirmedOffer?.barberId : Number(values.barberId);
          const requestedStart = parseStartTimeIso(String(values.startTimeIso || ''));
          if (!confirmedOffer || confirmedOffer.serviceId !== serviceId || confirmedOffer.barberId !== barberId || confirmedOffer.startTimeIso !== requestedStart.toISOString()) {
            return this.loggedToolError(name, iteration, 'The client has not confirmed this exact offer yet.', 'First quote the service, Tashkent date/time and final price, then ask the client to confirm. Create the booking only after a later affirmative reply.', 'confirmation_required');
          }
          const result = await this.bookingService.createBooking({
            serviceId,
            barberId,
            startTimeIso: requestedStart.toISOString(),
            discountPercent: confirmedOffer.discountPercent,
            clientTelegramId: input.telegramId,
            clientName: input.firstName || (values.clientName ? String(values.clientName) : undefined),
            clientPhone: values.clientPhone
              ? String(values.clientPhone)
              : input.contactPhone,
            clientLang: input.detectedLanguage ?? this.detectClientLanguage(input),
          });
          return {
            ok: true,
            confirmationSent: result.clientConfirmationSent === true,
            message: result.clientConfirmationSent
              ? 'The system sent the complete confirmation message to the client. Reply with at most one short friendly sentence and do not repeat booking details.'
              : 'The booking was created, but the system could not deliver the client confirmation message. Do not repeat dates or prices; briefly say the confirmation could not be delivered.',
          };
        }
        case 'cancel_booking': {
          const bookingId = Number(values.bookingId);
          const result = await this.bookingService.cancelBooking(bookingId, {
            clientTelegramId: input.telegramId,
            allowPrivileged: false,
          });
          return { ok: true, booking: result };
        }
        default:
          return this.toolError(`Unknown tool: ${name}.`, 'Use one of the available tools.');
      }
    } catch (e: any) {
      const status = e?.getStatus?.();
      const response = e?.getResponse?.();
      const rawMessage = typeof response === 'string' ? response : response?.message;
      const message = Array.isArray(rawMessage) ? rawMessage.join(' ') : rawMessage;
      const code = e?.code ?? (e?.meta?.code === 'P2022' ? 'P2022' : undefined);
      const safeMessage = code === 'P2022'
        ? 'Availability data is temporarily unavailable.'
        : (typeof message === 'string' && message.length < 240 ? message : 'The requested operation could not be completed.');
      const hint = status === 400
        ? 'Correct the date/time or arguments and retry, or ask the client to clarify.'
        : status === 409
          ? 'Offer the available alternative times returned by the backend.'
          : code === 'P2022'
            ? 'Ask the client to try again later; do not claim the slot is available.'
            : 'Retry once with corrected arguments, or explain briefly and ask the client what they prefer.';
      const detail = String(message ?? e?.message ?? safeMessage).replace(/[\r\n]+/g, ' ').slice(0, 180);
      this.logger.warn(`ai_tool_error name=${name} iteration=${iteration} code=${this.safeErrorCode(e)} detail=${detail}`);
      return this.toolError(safeMessage, hint, response?.alternatives ? { alternatives: response.alternatives } : {});
    }
  }
}
