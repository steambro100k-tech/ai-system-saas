export type AppEnv = {
  TELEGRAM_ENABLED: boolean;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_WEBHOOK_URL: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  OPENAI_FALLBACK_MODELS: string[];
  OPENAI_REASONING_EFFORT: string;
  OPENAI_TIMEOUT_MS: number;
  // Backwards compatibility with installations that used Gemini's OpenAI-compatible API.
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  GEMINI_BASE_URL: string;
  GEMINI_FALLBACK_MODELS: string[];
  GEMINI_REASONING_EFFORT: string;
  GEMINI_TIMEOUT_MS: number;
  BARBER_TELEGRAM_IDS: string[];
  ADMIN_KEY: string;
  MINI_APP_URL: string;
  NODE_ENV: string;
  SHOP_ADDRESS: string;
  REMINDER_LEAD_MIN: number;
};

function read(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value);
}

function readInt(name: string, fallback: number): number {
  const raw = read(name, '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getAppEnv(): AppEnv {
  const barberIds = read('BARBER_TELEGRAM_IDS')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const openAiFallbackModels = read('OPENAI_FALLBACK_MODELS')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const geminiFallbackModels = read('GEMINI_FALLBACK_MODELS')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const reasoningEffortRaw = read('GEMINI_REASONING_EFFORT', 'low').trim();

  return {
    TELEGRAM_ENABLED: read('TELEGRAM_ENABLED', 'true').trim().toLowerCase() !== 'false',
    TELEGRAM_BOT_TOKEN: read('TELEGRAM_BOT_TOKEN'),
    TELEGRAM_WEBHOOK_SECRET: read('TELEGRAM_WEBHOOK_SECRET'),
    TELEGRAM_WEBHOOK_URL: read('TELEGRAM_WEBHOOK_URL'),
    OPENAI_API_KEY: read('OPENAI_API_KEY'),
    OPENAI_MODEL: read('OPENAI_MODEL', 'gpt-4o-mini'),
    OPENAI_FALLBACK_MODELS: openAiFallbackModels,
    OPENAI_REASONING_EFFORT: read('OPENAI_REASONING_EFFORT'),
    OPENAI_TIMEOUT_MS: readInt('OPENAI_TIMEOUT_MS', 25000),
    GEMINI_API_KEY: read('GEMINI_API_KEY'),
    GEMINI_MODEL: read('GEMINI_MODEL', 'gemini-3.5-flash'),
    GEMINI_BASE_URL: read(
      'GEMINI_BASE_URL',
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    ),
    GEMINI_FALLBACK_MODELS: geminiFallbackModels,
    GEMINI_REASONING_EFFORT: reasoningEffortRaw,
    GEMINI_TIMEOUT_MS: readInt('GEMINI_TIMEOUT_MS', 25000),
    BARBER_TELEGRAM_IDS: barberIds,
    ADMIN_KEY: read('ADMIN_KEY'),
    MINI_APP_URL: read('MINI_APP_URL'),
    NODE_ENV: read('NODE_ENV', 'dev'),
    SHOP_ADDRESS: read('SHOP_ADDRESS'),
    REMINDER_LEAD_MIN: readInt('REMINDER_LEAD_MIN', 120),
  };
}

export function isProductionEnv(): boolean {
  return getAppEnv().NODE_ENV === 'production';
}
