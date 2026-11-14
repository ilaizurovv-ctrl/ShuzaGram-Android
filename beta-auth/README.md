# ShuzaGram Beta test authentication

This is a **separate test identity system**. It does not authenticate users with Telegram and must never replace Telegram's normal MTProto login.

## Behaviour

- A user sends `/stars` to `@ShuzaGramLoginBot`.
- The bot shows **📱 Получить номер**.
- The backend assigns a stable, unique synthetic number to that Telegram account. Numbers are generated as `+7` followed by a monotonically increasing 10-digit sequence (for example, `+70000000001`). They are deliberately non-routable test identifiers, not phone lines.
- The bot sends a six-digit one-time code in the same private Telegram chat.
- The code expires after 5 minutes, is single-use, and is throttled to one issuance per minute. Verification locks the OTP row and allows at most five attempts.
- The Android Beta test-login UI can POST `{ "phone": "+70000000001", "code": "123456" }` to `/api/beta-auth/verify`. A successful response returns a separate Beta test session token. It is not a Telegram account session.

## Hosting

The intended free setup is one Koyeb Free Web Service plus a separate Neon Free PostgreSQL project. The Koyeb service must be a **Web Service**, not a Worker: the free instance does not support Worker Services and may scale to zero after one hour without incoming traffic. Telegram updates therefore use a webhook rather than long polling.

In Koyeb, connect this GitHub repository and select:

- Branch: `feature/beta-test-auth`
- Work directory: `beta-auth`
- Build command: `npm install`
- Run command: `npm start`
- Instance: Free
- Service type: Web Service
- Health check path: `/health`

Koyeb supplies `KOYEB_PUBLIC_DOMAIN` automatically. On startup the server registers `https://<KOYEB_PUBLIC_DOMAIN>/telegram/webhook` with Telegram and validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header.

## Environment variables

Set these in the Koyeb service settings. Keep all values private:

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
