/**
 * Prints Telegram's current webhook status for this bot.
 * Usage: TELEGRAM_BOT_TOKEN=xxx node scripts/webhook-info.js
 */

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Usage: TELEGRAM_BOT_TOKEN=xxx node scripts/webhook-info.js");
  process.exit(1);
}

async function main() {
  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main();
