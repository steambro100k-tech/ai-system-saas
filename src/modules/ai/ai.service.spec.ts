import { BadRequestException } from '@nestjs/common';
import { AiService } from './ai.service';

describe('AiService tool errors', () => {
  it('returns tool failures to the model as an error and hint, then continues', async () => {
    const prisma = {
      chatMessage: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const bookingService = {
      getSlots: jest.fn().mockRejectedValue(
        new BadRequestException('Invalid date format, expected YYYY-MM-DD'),
      ),
      listServices: jest.fn().mockResolvedValue([]),
    };
    const service = new AiService(prisma as any, bookingService as any, {} as any);
    const llm = {
      createChatCompletion: jest
        .fn()
        .mockResolvedValueOnce({
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_available_slots', arguments: '{"date":"garbage"}' },
            }],
          },
        })
        .mockResolvedValueOnce({
          message: { role: 'assistant', content: 'Qaysi sanani nazarda tutdingiz?' },
        }),
    };
    (service as any).llm = llm;

    const reply = await service.handleMessage({ telegramId: 'test-user', text: 'ertaga' });

    expect(reply).toContain('Qaysi sanani');
    const secondRequest = llm.createChatCompletion.mock.calls[1][0];
    const toolResult = secondRequest.messages.find((message: any) => message.role === 'tool');
    expect(JSON.parse(toolResult.content)).toEqual({
      error: 'Invalid date format, expected YYYY-MM-DD',
      hint: 'Correct the date/time or arguments and retry, or ask the client to clarify.',
    });
  });

  it('stores detected client language internally and keeps the post-confirmation reply short', async () => {
    const prisma = {
      chatMessage: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const bookingService = {
      createBooking: jest.fn().mockResolvedValue({
        id: 44,
        clientConfirmationSent: true,
        barber: { id: 2, name: 'Bobur' },
      }),
    };
    const service = new AiService(prisma as any, bookingService as any, {} as any);
    const startTimeIso = '2026-11-25T08:00:00.000Z';
    (service as any).pendingConfirmations.set('client-44', {
      serviceId: 1,
      serviceNameRu: 'Haircut',
      serviceNameUz: 'Soch olish',
      startTimeIso,
      barberId: 2,
      barberName: 'Bobur',
      discountPercent: 15,
      finalPrice: 85_000,
      expiresAt: Date.now() + 60_000,
    });
    (service as any).llm = {
      createChatCompletion: jest
        .fn()
        .mockResolvedValueOnce({
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_booking',
              type: 'function',
              function: {
                name: 'create_booking',
                arguments: JSON.stringify({ serviceId: 1, barberId: 2, startTimeIso }),
              },
            }],
          },
        })
        .mockResolvedValueOnce({
          message: { role: 'assistant', content: 'Full booking details with an invented year 2025.' },
        }),
    };

    const reply = await service.handleMessage({
      telegramId: 'client-44',
      text: 'ha',
      languageCode: 'uz',
      firstName: 'Ali',
    });

    expect(bookingService.createBooking).toHaveBeenCalledWith(expect.objectContaining({
      barberId: 2,
      clientLang: 'uz',
      clientName: 'Ali',
    }));
    expect(reply).toContain('Telegramga xabar yuborildi');
    expect(reply).not.toContain('2025');
    expect(reply).not.toContain('85 000');
  });
});
