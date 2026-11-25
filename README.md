# SavdoAI API

NestJS + Prisma API and Telegram receptionist for a Tashkent barbershop. The app uses Asia/Tashkent (UTC+5) for business hours and stores timestamps in UTC.

## Local setup

1. Install Node.js 20.19+ and pnpm, then run `pnpm install`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `OPENAI_API_KEY`, and the Telegram settings you use locally. Set `BARBER_TELEGRAM_IDS` and `ADMIN_TELEGRAM_IDS` to comma-separated Telegram numeric IDs and `ADMIN_KEY` to a long random value.
3. Apply migrations and create the demo services:

   ```sh
   pnpm exec prisma migrate deploy
   pnpm seed
   ```

4. Start the API with `pnpm dev`. The API uses `/api/v1`; Swagger is available at `/docs` outside production. Health check: `GET /api/v1/health`.

The bot uses long polling in development. In production, set `NODE_ENV=production`, `TELEGRAM_WEBHOOK_SECRET`, and `TELEGRAM_WEBHOOK_URL` to the Railway public base URL; app startup registers `https://<host>/api/v1/telegram/webhook`. Run `pnpm telegram:webhook` to re-register it manually if needed. Railway runs migrations on startup through `pnpm start:prod`.

## Barber Mini App API

Set `MINI_APP_URL` and add the Mini App's origin to `CORS_ORIGINS`. In local development, Telegram requires an HTTPS Mini App URL; expose the Vite server (port 5173) through an HTTPS tunnel and set that URL as `MINI_APP_URL`. For local desktop testing, allow the tunnel origin in `CORS_ORIGINS`; the Mini App API base URL must still reach the local backend on port 3000. Add the owner's Telegram numeric ID to `ADMIN_TELEGRAM_IDS`; `/start` then offers an admin button that opens the Mini App. Barber endpoints accept signed Telegram Mini App data in `x-telegram-init-data`; `x-admin-key` is available for controlled admin access.

- `GET /api/v1/bookings/services` lists services.
- `GET /api/v1/bookings/slots?date=YYYY-MM-DD` returns the day's 30-minute slots and booking details.
- `POST /api/v1/bookings/block` and `DELETE /api/v1/bookings/block/:id` block and unblock time.
- `PATCH /api/v1/bookings/:id/cancel` cancels a booking.

Use `x-admin-key` for `POST /api/v1/bookings/seed` in development. Demo seed and reset routes are disabled in production.

## AI configuration

Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` (defaults to `gpt-4o-mini`), `OPENAI_FALLBACK_MODELS`, `OPENAI_REASONING_EFFORT`, `OPENAI_TIMEOUT_MS`, and `AI_MEMORY_LIMIT`. Older Gemini OpenAI-compatible environment variables remain supported when `OPENAI_API_KEY` is unset.

## Checks

```sh
pnpm run build
pnpm test -- --runInBand
pnpm run lint
```
