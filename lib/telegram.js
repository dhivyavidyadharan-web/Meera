const TELEGRAM_MESSAGE_LIMIT = 4096;

function apiUrl(method) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  return `https://api.telegram.org/bot${token}/${method}`;
}

/**
 * Splits text into chunks that fit Telegram's 4096-char message limit,
 * breaking on paragraph/line boundaries where possible.
 */
function chunkMessage(text, limit = TELEGRAM_MESSAGE_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt < limit * 0.5) splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = limit;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}

async function sendMessage(chatId, text, options = {}) {
  const chunks = chunkMessage(text);

  for (const chunk of chunks) {
    const res = await fetch(apiUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        ...options,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Telegram sendMessage error ${res.status}: ${errText}`);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function htmlToPlain(html) {
  return html
    .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Telegram's 4096 limit counts visible characters, so link URLs don't count.
function visibleLength(html) {
  return htmlToPlain(html.replace(/<a href="[^"]*">/g, "<a>")).length;
}

async function sendHtml(chatId, html, options = {}) {
  try {
    await sendMessage(chatId, html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...options,
    });
  } catch (err) {
    console.error("HTML send failed, retrying as plain text:", err.message);
    await sendMessage(chatId, htmlToPlain(html), { link_preview_options: { is_disabled: true }, ...options });
  }
}

async function sendChatAction(chatId, action = "typing") {
  try {
    await fetch(apiUrl("sendChatAction"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {
    // best-effort only, never block the main flow on this
  }
}

module.exports = {
  sendMessage,
  sendHtml,
  sendChatAction,
  escapeHtml,
  visibleLength,
  TELEGRAM_MESSAGE_LIMIT,
};
