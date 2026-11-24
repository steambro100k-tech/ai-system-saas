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

const MAX_TOOL_ITERATIONS = 5;
function getMemoryLimit(): number {
  const value = Number(process.env.AI_MEMORY_LIMIT ?? 20);
  return Number.isInteger(value) && value >= 10 && value <= 50 ? value : 20;
}

@Injectable()
export class AiService implements ConversationHandler {
  private readonly logger = new Logger(AiService.name);
  private readonly llm: LlmClient;

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
    try {
      await this.prisma.chatMessage.create({
        data: { telegramId: input.telegramId, role: 'user', content: userText },
      });

      const history = await this.prisma.chatMessage.findMany({
        where: {
          telegramId: input.telegramId,
          role: { in: ['user', 'assistant'] },
        },
        orderBy: { createdAt: 'desc' },
        take: getMemoryLimit(),
      });
      const orderedHistory = history.reverse();

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

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        iteration = i;
        const completion = await this.llm.createChatCompletion({
          messages,
          tools,
          toolChoice: 'auto',
          temperature: 0.2,
          iteration: i,
        });
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
              input,
            );
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
      const status =
        err?.status ??
        err?.response?.status ??
        (/timeout|timed out/i.test(String(err?.message || err))
          ? 'timeout'
          : 'unknown');
      const model =
        (err as any)?.model ??
        process.env.OPENAI_MODEL ??
        process.env.GEMINI_MODEL ??
        'gpt-4o-mini';
      this.logger.warn(
        `ai_fail model=${model} status=${status} elapsed_ms=${elapsedMs} iteration=${iteration}`,
      );
      return this.fallbackReply(userText, input.languageCode, status);
    }
  }

  private composeUserText(input: ConversationInput): string {
    if (input.contactPhone) {
      return `[Client shared phone number: ${input.contactPhone}] ${input.text || ''}`.trim();
    }
    return input.text || '';
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
            'Get free 30-min slots for a date (Asia/Tashkent) with max discount per slot',
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
            },
            additionalProperties: false,
          },
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
              startTimeIso: {
                type: 'string',
                description: 'ISO datetime (UTC instant) for slot start',
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
            'Create a booking for the current client. Backend validates price, discount, and availability.',
          parameters: {
            type: 'object',
            properties: {
              serviceId: { type: 'integer' },
              startTimeIso: { type: 'string' },
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
    input: ConversationInput,
  ): Promise<any> {
    let args: any = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      return { error: 'Invalid tool arguments JSON' };
    }

    try {
      this.logger.debug(`ai_tool_call name=${name}`);
      switch (name) {
        case 'list_services': {
          const services = await this.bookingService.listServices();
          return { services };
        }
        case 'get_available_slots': {
          const date = typeof args.date === 'string' ? args.date : undefined;
          const serviceId =
            args.serviceId === undefined ? undefined : Number(args.serviceId);
          const service =
            serviceId === undefined
              ? undefined
              : (await this.bookingService.listServices()).find(
                  (item) => item.id === serviceId,
                );
          if (serviceId !== undefined && !service)
            return { error: 'Service not found' };
          const daySlots = await this.bookingService.getSlots(date);
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
                if ((slotsByStart.get(nextStart) as any)?.status !== 'FREE')
                  return false;
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
            }));
          return {
            date: daySlots.date,
            timezone: daySlots.timezone,
            freeSlots: free,
          };
        }
        case 'get_offer': {
          const serviceId = Number(args.serviceId);
          const startTimeIso = String(args.startTimeIso || '');
          const services = await this.bookingService.listServices();
          const service = services.find((s) => s.id === serviceId);
          if (!service) return { error: 'Service not found' };
          const offer = this.bargainService.evaluate(
            startTimeIso,
            service.price,
          );
          return {
            serviceId: service.id,
            serviceNameRu: service.nameRu,
            serviceNameUz: service.nameUz,
            basePrice: service.price,
            durationMin: service.durationMin,
            startTimeIso,
            ...offer,
          };
        }
        case 'create_booking': {
          const result = await this.bookingService.createBooking({
            serviceId: Number(args.serviceId),
            startTimeIso: String(args.startTimeIso || ''),
            discountPercent:
              args.discountPercent !== undefined
                ? Number(args.discountPercent)
                : 0,
            clientTelegramId: input.telegramId,
            clientName: args.clientName ? String(args.clientName) : undefined,
            clientPhone: args.clientPhone
              ? String(args.clientPhone)
              : input.contactPhone,
          });
          return { ok: true, booking: result };
        }
        case 'cancel_booking': {
          const bookingId = Number(args.bookingId);
          const result = await this.bookingService.cancelBooking(bookingId, {
            clientTelegramId: input.telegramId,
            allowPrivileged: false,
          });
          return { ok: true, booking: result };
        }
        default:
          return { error: `Unknown tool: ${name}` };
      }
    } catch (e: any) {
      const response = e?.getResponse?.();
      if (response && typeof response === 'object') {
        return { error: response };
      }
      return { error: e?.message || String(e) };
    }
  }
}
