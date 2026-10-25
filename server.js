
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "10kb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Дозволяємо запити лише з сайту EL-Księgowość.
const ALLOWED_ORIGINS = new Set([
  "https://xn--el-ksigowo-zhb5s46a.pl",
  "https://el-księgowość.pl"
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calculator_visits (
      visitor_id TEXT PRIMARY KEY,
      details JSONB NOT NULL,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      submitted BOOLEAN NOT NULL DEFAULT FALSE,
      notified BOOLEAN NOT NULL DEFAULT FALSE,
      left_at TIMESTAMPTZ
    )
  `);
}

app.get("/", (req, res) => {
  res.send("EL-Księgowość calculator analytics is running.");
});

// Зберігаємо останній вибір. У Telegram тут нічого не надсилаємо.
app.post("/track", async (req, res) => {
  try {
    const { visitorId, details } = req.body || {};

    if (
      typeof visitorId !== "string" ||
      !/^calc_user_[a-z0-9]+$/i.test(visitorId) ||
      !details ||
      typeof details !== "object" ||
      Array.isArray(details)
    ) {
      return res.status(400).json({ error: "Invalid data" });
    }

    await pool.query(
      `INSERT INTO calculator_visits
         (visitor_id, details, last_seen, submitted, notified, left_at)
       VALUES ($1, $2, NOW(), FALSE, FALSE, NULL)
       ON CONFLICT (visitor_id) DO UPDATE SET
         details = EXCLUDED.details,
         last_seen = NOW(),
         submitted = FALSE,
         notified = FALSE,
         left_at = NULL`,
      [visitorId, JSON.stringify(details)]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Track error:", error.message);
    res.status(500).json({ error: "Could not save visit" });
  }
});

// Сигналізуємо серверу про вихід. Якщо цей запит не дійде,
// сервер усе одно перевірятиме час останнього heartbeat.
app.post("/leave", async (req, res) => {
  try {
    const { visitorId } = req.body || {};

    if (typeof visitorId !== "string") {
      return res.status(400).json({ error: "Invalid visitor" });
    }

    await pool.query(
      `UPDATE calculator_visits
       SET left_at = NOW()
       WHERE visitor_id = $1 AND submitted = FALSE`,
      [visitorId]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Leave error:", error.message);
    res.status(500).json({ error: "Could not record exit" });
  }
});

// Викликати лише після успішного надсилання заявки.
app.post("/submitted", async (req, res) => {
  try {
    const { visitorId } = req.body || {};

    if (typeof visitorId !== "string") {
      return res.status(400).json({ error: "Invalid visitor" });
    }

    await pool.query(
      `UPDATE calculator_visits
       SET submitted = TRUE
       WHERE visitor_id = $1`,
      [visitorId]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Submission error:", error.message);
    res.status(500).json({ error: "Could not update visit" });
  }
});

// Надсилаємо одне повідомлення після виходу або тривалої неактивності.
// Дані вже збережені в PostgreSQL, тож браузер не мусить чекати.
async function checkInactiveVisits() {
  const result = await pool.query(`
    UPDATE calculator_visits
    SET notified = TRUE
    WHERE visitor_id IN (
      SELECT visitor_id
      FROM calculator_visits
      WHERE submitted = FALSE
        AND notified = FALSE
        AND (
          (left_at IS NOT NULL AND left_at < NOW() - INTERVAL '15 seconds')
          OR last_seen < NOW() - INTERVAL '90 seconds'
        )
      ORDER BY last_seen
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    RETURNING visitor_id, details
  `);

  for (const visit of result.rows) {
    try {
      const text =
        "📊 Niezakończona kalkulacja\n" +
        "ID: " + visit.visitor_id + "\n" +
        JSON.stringify(visit.details, null, 2);

      const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text
          })
        }
      );

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.description || "Telegram send failed");
      }
    } catch (error) {
      console.error("Telegram error:", error.message);

      // Дозволяємо повторну спробу, якщо Telegram не прийняв повідомлення.
      await pool.query(
        `UPDATE calculator_visits
         SET notified = FALSE
         WHERE visitor_id = $1`,
        [visit.visitor_id]
      );
    }
  }
}

async function start() {
  await initDb();

  setInterval(() => {
    checkInactiveVisits().catch(error =>
      console.error("Inactive check error:", error.message)
    );
  }, 15000);

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("Calculator analytics started"));
}

start().catch(error => {
  console.error("Startup error:", error);
  process.exit(1);
});
