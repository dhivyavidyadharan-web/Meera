const { scoreKeywords } = require("../lib/keywords");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

async function telegram(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function checkGemini() {
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const res = await fetch(`${GEMINI_API_BASE}/models/${model}`, {
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
  });
  if (res.ok) return { ok: true, model };
  const data = await res.json().catch(() => ({}));
  return { ok: false, model, status: res.status, error: data?.error?.message };
}

module.exports = async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.query.key !== secret) {
    res.status(401).json({ error: "Add ?key=<TELEGRAM_WEBHOOK_SECRET> to the URL" });
    return;
  }

  const report = {
    env: {
      TELEGRAM_BOT_TOKEN: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
      TELEGRAM_WEBHOOK_SECRET: Boolean(secret),
    },
  };

  if (!report.env.TELEGRAM_BOT_TOKEN || !report.env.GEMINI_API_KEY) {
    report.next_step =
      "Add the missing env vars in Vercel (Project > Settings > Environment Variables), then redeploy and reload this page.";
    res.status(500).json(report);
    return;
  }

  try {
    const me = await telegram("getMe");
    report.telegram_bot = me.ok ? `@${me.result.username}` : { error: me.description };

    report.gemini = await checkGemini();

    const before = await telegram("getWebhookInfo");
    report.webhook_before_setup = {
      url: before.result?.url,
      pending_update_count: before.result?.pending_update_count,
      last_error_date: before.result?.last_error_date
        ? new Date(before.result.last_error_date * 1000).toISOString()
        : null,
      last_error_message: before.result?.last_error_message || null,
    };

    if (req.query.test === "keywords") {
      const t0 = Date.now();
      try {
        const { ranked, main } = await scoreKeywords([{ role: "user", text: "sunscreen for men" }], {
          deadline: Date.now() + 20000,
        });
        report.keyword_test = {
          ok: true,
          ms: Date.now() - t0,
          main: main?.keyword,
          keywords: ranked.map((k) => `${k.keyword}: ${k.total} (${k.articleCount} articles)`),
        };
      } catch (err) {
        report.keyword_test = { ok: false, ms: Date.now() - t0, kind: err.kind, error: String(err.message).slice(0, 500) };
      }
    }

    if (req.query.check === "1") {
      res.status(200).json(report);
      return;
    }

    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers.host;
    const webhookUrl = `https://${host}/api/webhook`;
    const set = await telegram("setWebhook", {
      url: webhookUrl,
      allowed_updates: ["message", "edited_message", "channel_post"],
      drop_pending_updates: true,
      ...(secret ? { secret_token: secret } : {}),
    });
    report.set_webhook = set.ok ? `registered ${webhookUrl}` : { error: set.description };

    const info = await telegram("getWebhookInfo");
    report.webhook_info = {
      url: info.result?.url,
      pending_update_count: info.result?.pending_update_count,
      last_error_message: info.result?.last_error_message || null,
    };
  } catch (err) {
    report.error = String(err);
  }

  res.status(200).json(report);
};
