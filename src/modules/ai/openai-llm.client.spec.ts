import { OpenAiLlmClient } from './openai-llm.client';

describe('OpenAiLlmClient', () => {
  it('uses Flash-Lite as the default fallback for legacy Gemini config', () => {
    const names = [
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GEMINI_FALLBACK_MODELS',
    ];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env.OPENAI_API_KEY = '';
      process.env.GEMINI_API_KEY = 'test-key';
      process.env.GEMINI_MODEL = 'gemini-3.5-flash';
      process.env.GEMINI_FALLBACK_MODELS = '';

      const client = new OpenAiLlmClient();
      expect((client as any).fallbackModels).toEqual(['gemini-3.5-flash-lite']);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('switches to the configured fallback model after a 429', async () => {
    const client = new OpenAiLlmClient({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      fallbackModels: ['gemini-3.5-flash-lite'],
      maxRetriesPerModel: 0,
      totalBudgetMs: 5000,
    });
    const create = jest
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'Ready' } }],
      });
    (client as any).client = { chat: { completions: { create } } };

    const result = await client.createChatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(create.mock.calls.map(([request]) => request.model)).toEqual([
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
    ]);
    expect(result.message.content).toBe('Ready');
  });
});
