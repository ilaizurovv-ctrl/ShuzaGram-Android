const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

const required = ["DATABASE_URL", "BOT_TOKEN", "OTP_PEPPER", "SESSION_PEPPER", "WEBHOOK_SECRET"];
for (const key of required) {
  if (!process.env[key]) {
    console.error("Missing required environment variable: " + key);
    process.exit(1);
  }
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(process.env.WEBHOOK_SECRET)) {
  console.error("WEBHOOK_SECRET must contain 1-256 letters, digits, underscores, or hyphens");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  max: 5,
});
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));

const PORT = Number(process.env.PORT || 3000);
const BOT_API = "https://api.telegram.org/bot" + process.env.BOT_TOKEN;
const OTP_TTL_SECONDS = 5 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const otpDigest = (phone, code) => sha256(phone + ":" + code + ":" + process.env.OTP_PEPPER);
const sessionDigest = (token) => sha256(token + ":" + process.env.SESSION_PEPPER);

async function telegram(method, payload = {}) {
  const response = await fetch(BOT_API + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(35000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error("Telegram API error: " + (result.description || response.status));
  }
  return result.result;
}

async function initDb() {
  await pool.query(\`
    CREATE SEQUENCE IF NOT EXISTS beta_phone_seq START 1;
    CREATE TABLE IF NOT EXISTS beta_test_users (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_code_sent_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS beta_test_otps (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL REFERENCES beta_test_users(phone) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS beta_test_otps_phone_created
      ON beta_test_otps(phone, created_at DESC);
    CREATE TABLE IF NOT EXISTS beta_test_sessions (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL REFERENCES beta_test_users(phone) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  \`);
}

async function getOrCreateUser(telegramId) {
  const result = await pool.query(\`
    INSERT INTO beta_test_users (telegram_id, phone)
    VALUES ($1, '+7' || LPAD(nextval('beta_phone_seq')::text, 10, '0'))
    ON CONFLICT (telegram_id) DO UPDATE SET telegram_id = EXCLUDED.telegram_id
    RETURNING phone
  \`, [String(telegramId)]);
  return result.rows[0].phone;
}

async function issueCode(telegramId) {
  const phone = await getOrCreateUser(telegramId);
  const recent = await pool.query(
    "SELECT last_code_sent_at FROM beta_test_users WHERE telegram_id = $1",
    [String(telegramId)]
  );
  const lastSent = recent.rows[0] && recent.rows[0].last_code_sent_at;
  if (lastSent && Date.now() - new Date(lastSent).getTime() < 60000) {
    return { phone, throttled: true };
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE beta_test_users SET last_code_sent_at = NOW() WHERE telegram_id = $1",
      [String(telegramId)]
    );
    await client.query(
      "UPDATE beta_test_otps SET used_at = NOW() WHERE phone = $1 AND used_at IS NULL",
      [phone]
    );
    await client.query(
      "INSERT INTO beta_test_otps (phone, code_hash, expires_at) VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval)",
      [phone, otpDigest(phone, code), OTP_TTL_SECONDS]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { phone, code, throttled: false };
}

async function handleBotUpdate(update) {
  const message = update.message;
  if (!message || message.chat?.type !== "private" || !message.from || message.from.is_bot) return;
  const messageText = (message.text || "").trim();

  if (messageText === "/start" || messageText.startsWith("/start ")) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "Добро пожаловать в ShuzaGram Beta! Это отдельный тестовый вход. Нажмите /stars, чтобы получить персональный тестовый номер +7 и одноразовый код. Эти номера не принимают реальные SMS и не работают в обычном Telegram.",
    });
    return;
  }

  if (messageText === "/stars" || messageText.startsWith("/stars ")) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "ShuzaGram Beta — тестовая авторизация",
      reply_markup: {
        inline_keyboard: [[{ text: "📱 Получить номер", callback_data: "beta_get_number" }]],
      },
    });
  }
}

async function handleCallback(update) {
  const query = update.callback_query;
  if (!query || query.data !== "beta_get_number" || query.message?.chat?.type !== "private") return;
  await telegram("answerCallbackQuery", { callback_query_id: query.id });
  const telegramId = query.from.id;
  const chatId = query.message.chat.id;

  try {
    const issued = await issueCode(telegramId);
    if (issued.throttled) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: "Ваш тестовый номер: " + issued.phone + "\nНовый код можно запросить через минуту. Предыдущий код мог истечь через 5 минут.",
      });
      return;
    }
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "Ваш персональный тестовый номер ShuzaGram Beta:\n" + issued.phone +
        "\n\nКод подтверждения: " + issued.code +
        "\n\nКод действует 5 минут и используется один раз. Это тестовые данные, не реальные SMS.",
    });
  } catch (error) {
    console.error("Bot callback failed:", error.message);
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "Не удалось выдать тестовый код. Попробуйте немного позже.",
    }).catch(() => {});
  }
}

function validWebhookSecret(received) {
  if (typeof received !== "string") return false;
  const expected = Buffer.from(process.env.WEBHOOK_SECRET);
  const actual = Buffer.from(received);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "shuzagram-beta-auth" }));

app.post("/telegram/webhook", async (req, res) => {
  if (!validWebhookSecret(req.get("x-telegram-bot-api-secret-token"))) {
    return res.sendStatus(401);
  }
  try {
    const update = req.body || {};
    if (update.callback_query) await handleCallback(update);
    else await handleBotUpdate(update);
    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook update failed:", error.message);
    return res.sendStatus(500);
  }
});

app.post("/api/beta-auth/verify", async (req, res) => {
  const phone = String(req.body?.phone || "").trim();
  const code = String(req.body?.code || "").trim();
  if (!/^\+7\d{10}$/.test(phone) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      \`SELECT id, attempts, expires_at, used_at, code_hash
       FROM beta_test_otps
       WHERE phone = $1
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE\`,
      [phone]
    );
    const otp = found.rows[0];
    if (!otp || otp.used_at || new Date(otp.expires_at).getTime() <= Date.now() || otp.attempts >= 5) {
      await client.query("ROLLBACK");
      return res.status(401).json({ error: "code_expired_or_invalid" });
    }
    if (otp.code_hash !== otpDigest(phone, code)) {
      await client.query("UPDATE beta_test_otps SET attempts = attempts + 1 WHERE id = $1", [otp.id]);
      await client.query("COMMIT");
      return res.status(401).json({ error: "code_expired_or_invalid" });
    }

    await client.query("UPDATE beta_test_otps SET used_at = NOW() WHERE id = $1", [otp.id]);
    const token = crypto.randomBytes(32).toString("base64url");
    await client.query(
      "INSERT INTO beta_test_sessions (phone, token_hash, expires_at) VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval)",
      [phone, sessionDigest(token), SESSION_TTL_SECONDS]
    );
    await client.query("COMMIT");
    return res.json({
      ok: true,
      phone,
      access_token: token,
      token_type: "Bearer",
      expires_in: SESSION_TTL_SECONDS,
      auth_mode: "shuzagram_beta_test_only",
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("OTP verification failed:", error.message);
    return res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

async function start() {
  await initDb();
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log("ShuzaGram Beta API listening on port " + PORT);
  });
  const domain = process.env.KOYEB_PUBLIC_DOMAIN;
  if (!domain) {
    server.close();
    throw new Error("KOYEB_PUBLIC_DOMAIN is missing; configure this service as a public Koyeb Web Service");
  }
  const webhookUrl = "https://" + domain + "/telegram/webhook";
  try {
    await telegram("setWebhook", {
      url: webhookUrl,
      secret_token: process.env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    console.log("Telegram webhook registered at " + webhookUrl);
  } catch (error) {
    server.close();
    throw error;
  }
}

start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
