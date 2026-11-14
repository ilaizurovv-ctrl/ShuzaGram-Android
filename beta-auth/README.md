# ShuzaGram Beta test authentication

This is a **separate test identity system**. It does not authenticate users with Telegram and must never replace Telegram's normal MTProto login.

## Behaviour

- A user sends `/stars` to `@ShuzaGramLoginBot`.
- The bot shows **📱 Получить номер**.
- The backend assigns a stable, unique synthetic number to that Telegram account. Numbers are generated as `+7` followed by a monotonically increasing 10-digit sequence (for example, `+70000000001`). They are deliberately non-routable test identifiers, not phone lines.
- The bot sends a six-digit one-time code in the same private Telegram chat.
- The code expires after 5 minutes, is single-use, and is throttled to one issuance per minute. Verification locks the OTP row and allows at most five attempts.
- The Android Beta test-login UI can POST `{ "phone": "+70000000001", "code": "123456" }` to `/api/beta-auth/verify`. A successful response returns a separate Beta test session token. It is not a Telegram account session.

## Environment

Set these variables in the hosting provider's secret/environment settings. Never commit their values:

- `DATABASE_URL` — PostgreSQL connection string.
- `BOT_TOKEN` — token from BotFather for `@ShuzaGramLoginBot`.
- `OTP_PEPPER` — long random secret used to hash one-time codes.
- `SESSION_PEPPER` — separate long random secret used to hash session tokens.
- `PORT` — optional; defaults to 3000.
- `PGSSLMODE=disable` — optional for local PostgreSQL only.

Use Node.js 20 or newer.

## Local run

```sh
cd beta-auth
npm install
DATABASE_URL=postgres://... BOT_TOKEN=... OTP_PEPPER=... SESSION_PEPPER=... npm start
```

Health check: `GET /health`.

## Deployment notes

Run exactly one service instance because this starter uses Telegram long polling. Keep PostgreSQL persistent. Configure a single Render web service with a PostgreSQL database and set the secrets above in the Render Dashboard. Do not expose the bot token to Android clients.

## Important integration boundary

The Android app's existing `LoginActivity` continues to use Telegram's official authentication protocol. The test endpoint above creates a distinct ShuzaGram Beta identity only. A follow-up Android change must add a clearly labelled Beta-only entry point and keep its session isolated from Telegram's MTProto account state.
