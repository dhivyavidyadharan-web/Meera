/**
 * Registers your deployed Vercel URL as the Telegram bot's webhook.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx DEPLOY_URL=https://your-app.vercel.app node scripts/set-webhook.js
 *
 * Optionally set TELEGRAM_WEBHOOK_SECRET (same value as in Vercel env vars)
 * to have Telegram sign requests with a secret token.
 */

const token = process.env.TELEGRAM_BOT_TOKEN;
const deployUrl = process.env.DEPLOY_URL;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token || !deployUrl) {
  console.error(
    "Usage: TELEGRAM_BOT_TOKEN=xxx DEPLOY_URL=https://your-app.vercel.app node scripts/set-webhook.js"
  );
  process.exit(1);
}

const webhookUrl = `${deployUrl.replace(/\/$/, "")}/api/webhook`;

async function main() {
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      ...(secret ? { secret_token: secret } : {}),
    }),
  });

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));

  if (!data.ok) process.exit(1);
}

main();
