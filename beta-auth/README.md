# ShuzaGram Beta test authentication

This is a **separate test identity system**. It does not authenticate users with Telegram and must never replace Telegram's normal MTProto login.

## Behaviour

- A user sends `/stars` to `@ShuzaGramLoginBot`.
- The bot shows **📱 Получить номер**.
- The backend assigns a stable, unique synthetic number to that Telegram account. Numbers use the display format `+7 904 XXX-XX-XX` (for example, `+79041234567`) with a random seven-digit suffix. They are synthetic Beta test identifiers, not provisioned phone lines; the `904` prefix is also used in real numbering, so these identifiers must not be used to call or message anyone.
- The bot sends a five-digit one-time code in the same private Telegram chat.
- The code expires after 5 minutes, is single-use, and is throttled to one issuance per minute. Verification locks the OTP row and allows at most five attempts.
- The Android Beta test-login UI can POST `{ "phone": "+70000000001", "code": "12345" }` to `/api/beta-auth/verify`. A successful response returns a separate Beta test session token. It is not a Telegram account session.

## Hosting

The intended free setup is one Render Free Web Service plus a separate Neon Free PostgreSQL project. The Render service must be a **Web Service**. Free web services spin down after inactivity, so the first request after sleep can be delayed. Telegram updates therefore use a webhook rather than long polling.

In Render, create a Blueprint from this repository and select branch `feature/beta-test-auth`. The root `render.yaml` defines the service and sets its root directory to `beta-auth`.

Render supplies `RENDER_EXTERNAL_HOSTNAME` automatically. On startup the server registers `https://<RENDER_EXTERNAL_HOSTNAME>/telegram/webhook` with Telegram and validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header.

## Environment variables

Set these in the Render service settings. Keep all values private:

- `DATABASE_URL` — Neon PostgreSQL connection string (prefer the pooled connection string).
- `BOT_TOKEN` — token from BotFather for `@ShuzaGramLoginBot`.
- `OTP_PEPPER` — long random secret used to hash one-time codes.
- `SESSION_PEPPER` — a different long random secret used to hash session tokens.
- `WEBHOOK_SECRET` — random 32+ character value using only letters, digits, underscores, and hyphens.
- `PORT` — optional; Koyeb supplies this automatically.
- `PGSSLMODE=disable` — optional for local PostgreSQL only; do not set this on Koyeb.

Use Node.js 20 or newer. Never commit secrets or expose the bot token to Android clients.

## Local run

The production entry point requires Koyeb's `KOYEB_PUBLIC_DOMAIN` so it can register the webhook. For local development, run with a temporary public HTTPS tunnel and set that domain, or adapt the startup registration for a local-only test environment.

Health check: `GET /health`.

## Important integration boundary

The Android app's existing `LoginActivity` continues to use Telegram's official authentication protocol. The test endpoint above creates a distinct ShuzaGram Beta identity only. A follow-up Android change must add a clearly labelled Beta-only entry point and keep its session isolated from Telegram's MTProto account state.
