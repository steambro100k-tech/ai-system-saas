export function resolveTelegramWebhookUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/api/v1/telegram/webhook')) return trimmed;
  if (trimmed.endsWith('/telegram/webhook')) {
    return trimmed.replace(/\/telegram\/webhook$/, '/api/v1/telegram/webhook');
  }
  return `${trimmed}/api/v1/telegram/webhook`;
}
