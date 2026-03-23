// backend/index.js
import express from "express";
import pg from "pg";
import crypto from "crypto";

const app = express();
app.use(express.json());

// CORS — разрешаем запросы с твоего фронтенда
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.FRONTEND_URL || "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data");
  next();
});

// --- БД ---
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

await pool.query(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id BIGINT PRIMARY KEY,
    username TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

// --- Проверка подписи Telegram InitData ---
function verifyTelegramData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(process.env.BOT_TOKEN)
    .digest();
  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  return hash === expectedHash;
}

function getUserFromInitData(initData) {
  const params = new URLSearchParams(initData);
  return JSON.parse(params.get("user") || "{}");
}

// --- Проверка подписки ---
app.get("/api/subscription", async (req, res) => {
  const initData = req.headers["x-telegram-init-data"];
  if (!initData || !verifyTelegramData(initData)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const user = getUserFromInitData(initData);
  const result = await pool.query(
    "SELECT expires_at FROM subscriptions WHERE user_id = $1",
    [user.id]
  );
  if (result.rows.length === 0) {
    return res.json({ active: false });
  }
  const expiresAt = new Date(result.rows[0].expires_at);
  return res.json({ active: expiresAt > new Date(), expires_at: expiresAt });
});

// --- Вебхук Telegram (платежи + команды) ---
app.post("/webhook", async (req, res) => {
  const update = req.body;

  // Подтверждение pre-checkout
  if (update.pre_checkout_query) {
    await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/answerPreCheckoutQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pre_checkout_query_id: update.pre_checkout_query.id,
          ok: true,
        }),
      }
    );
    return res.json({ ok: true });
  }

  // Успешная оплата
  if (update.message?.successful_payment) {
    const userId = update.message.from.id;
    const username = update.message.from.username || "";
    // Продлеваем подписку на 30 дней (или добавляем 30 дней к текущей)
    await pool.query(
      `INSERT INTO subscriptions (user_id, username, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')
       ON CONFLICT (user_id) DO UPDATE
       SET expires_at = GREATEST(subscriptions.expires_at, NOW()) + INTERVAL '30 days',
           username = $2`,
      [userId, username]
    );
    await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: userId,
          text: "✅ Подписка активирована на 30 дней! Открой приложение и начни сессию.",
        }),
      }
    );
    return res.json({ ok: true });
  }

  // Команда /start — с параметром subscribe сразу отправляем инвойс
  if (update.message?.text?.startsWith("/start")) {
    const userId = update.message.from.id;
    const firstName = update.message.from.first_name || "друг";
    const param = update.message.text.split(" ")[1];

    if (param === "subscribe") {
      await fetch(
        `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendInvoice`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: userId,
            title: "NLP Коуч — подписка на месяц",
            description: "Доступ к AI-коучу, 4 техникам НЛП и дневнику инсайтов на 30 дней",
            payload: "monthly_sub",
            currency: "XTR",
            prices: [{ label: "Подписка 30 дней", amount: 1 }],
            provider_token: "",
          }),
        }
      );
      return res.json({ ok: true });
    }
    const firstName = update.message.from.first_name || "друг";
    await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: userId,
          text: `Привет, ${firstName}! 🧠\n\nЯ — NLP-коуч для работы с мышлением.\n\nОткрой приложение и начни первую сессию:`,
          reply_markup: {
            inline_keyboard: [[
              { text: "🧠 Открыть NLP-коуч", web_app: { url: process.env.FRONTEND_URL } }
            ]]
          }
        }),
      }
    );
    return res.json({ ok: true });
  }

  // Команда /subscribe — отправляем инвойс на оплату звёздами
  if (update.message?.text === "/subscribe") {
    const userId = update.message.from.id;
    await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendInvoice`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: userId,
          title: "NLP Коуч — подписка на месяц",
          description: "Доступ к AI-коучу, 4 техникам НЛП и дневнику инсайтов на 30 дней",
          payload: "monthly_sub",
          currency: "XTR",        // XTR = Telegram Stars
          prices: [{ label: "Подписка 30 дней", amount: 1 }], // 1 звёзда
          provider_token: "",      // для Stars оставляем пустым
        }),
      }
    );
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log("Server running"));
