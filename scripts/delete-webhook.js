/**
 * Removes the bot's webhook (useful before switching URLs or debugging).
 * Usage: TELEGRAM_BOT_TOKEN=xxx node scripts/delete-webhook.js
 */

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Usage: TELEGRAM_BOT_TOKEN=xxx node scripts/delete-webhook.js");
  process.exit(1);
}

async function main() {
  const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main();
