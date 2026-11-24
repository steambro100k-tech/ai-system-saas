import 'dotenv/config';
import { Bot } from 'grammy';
import { resolveTelegramWebhookUrl } from '../src/modules/telegram/telegram-webhook-url';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const rawUrl = process.env.TELEGRAM_WEBHOOK_URL;

  if (!token || !secret || !rawUrl) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, and TELEGRAM_WEBHOOK_URL must be set',
    );
  }

  const url = resolveTelegramWebhookUrl(rawUrl);
  const bot = new Bot(token);
  await bot.api.setWebhook(url, { secret_token: secret });
  console.log(`Webhook set to ${url}`);
}

main().catch(() => {
  console.error('Failed to register Telegram webhook');
  process.exit(1);
});
