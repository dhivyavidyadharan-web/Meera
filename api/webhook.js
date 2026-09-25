const fs = require("fs");
const path = require("path");
const {
  sendMessage,
  sendHtml,
  sendChatAction,
  escapeHtml,
  visibleLength,
  TELEGRAM_MESSAGE_LIMIT,
} = require("../lib/telegram");
const { getHistory, addTurns, clearHistory } = require("../lib/history");
const { scoreKeywords, formatScoresHtml } = require("../lib/keywords");
const { writePost, headlinePool } = require("../lib/draft");
const { formatSourcesHtml, formatNeedsCheckingHtml } = require("../lib/sources");

const DIVIDER = "━━━━━━━━━━━━━━━━";

let cachedInstructions = null;

function loadInstructions() {
  if (process.env.WRITING_INSTRUCTIONS) {
    return process.env.WRITING_INSTRUCTIONS;
  }
  if (cachedInstructions) return cachedInstructions;

  const filePath = path.join(process.cwd(), "config", "instructions.md");
  cachedInstructions = fs.readFileSync(filePath, "utf8");
  return cachedInstructions;
}

async function sendSections(chatId, sections, replyOpts) {
  const combined = sections.join("\n\n");
  if (visibleLength(combined) <= TELEGRAM_MESSAGE_LIMIT) {
    await sendHtml(chatId, combined, replyOpts);
    return;
  }
  // Too long for one message: send each section on its own, in order.
  for (const s of sections.filter((s) => s !== DIVIDER)) {
    await sendHtml(chatId, s, replyOpts);
  }
}

async function handleUpdate(update) {
  const startedAt = Date.now();
  const isChannel = Boolean(update?.channel_post);
  const message = update?.message || update?.edited_message || update?.channel_post;
  const chatId = message?.chat?.id;
  const text = message?.text;

  if (!chatId) return;

  // The bot's drafts in a channel are posted as replies; skipping replies prevents it drafting from its own output.
  if (isChannel && message.reply_to_message) return;

  const replyOpts = isChannel
    ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } }
    : {};

  if (!text) {
    await sendMessage(
      chatId,
      "I can only work with text notes right now. Send the note as a text message and I'll draft a LinkedIn post from it."
    );
    return;
  }

  if (text.startsWith("/start") || text.startsWith("/new")) {
    clearHistory(chatId);
    await sendMessage(
      chatId,
      "Hi Meera. Send me a note (a data point, a story, a customer question) and I'll draft a LinkedIn post from it in your voice. Send /new any time to start a fresh topic.",
      replyOpts
    );
    return;
  }

  try {
    await sendChatAction(chatId, "typing");

    let history = getHistory(chatId);
    const quoted = message.reply_to_message?.text;
    if (quoted && !history.some((t) => t.text === quoted)) {
      history = [...history, { role: "model", text: quoted }];
    }
    const turns = [...history, { role: "user", text }];

    let scored = null;
    try {
      scored = await scoreKeywords(turns);
      if (scored.ranked.length === 0) scored = null;
    } catch (err) {
      console.error("Keyword scoring failed, drafting without news:", err);
    }

    await sendChatAction(chatId, "typing");

    const { post, sources, needsChecking } = await writePost({
      system: loadInstructions(),
      turns,
      note: text,
      topic: scored ? scored.main.keyword : "whatever Meera's note is about",
      headlines: scored ? headlinePool(scored.ranked, scored.main) : [],
      startedAt,
    });

    addTurns(chatId, { role: "user", text }, { role: "model", text: post });

    const sections = [];
    if (scored) sections.push(formatScoresHtml(scored.ranked, scored.main), DIVIDER);
    sections.push(escapeHtml(post));
    if (sources.length || needsChecking.length) sections.push(DIVIDER);
    if (sources.length) sections.push(formatSourcesHtml(sources));
    if (needsChecking.length) sections.push(formatNeedsCheckingHtml(needsChecking));

    await sendSections(chatId, sections, replyOpts);
  } catch (err) {
    console.error("Draft failed:", err);
    await sendMessage(
      chatId,
      "Something went wrong drafting that one. Please try again in a minute.",
      replyOpts
    );
  }
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    res.status(200).send("ok");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret && req.headers["x-telegram-bot-api-secret-token"] !== expectedSecret) {
    res.status(401).send("Unauthorized");
    return;
  }

  // Vercel may freeze the function once the response is sent, so finish all work first.
  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error("Webhook error:", err);
  }

  // Always 200 so Telegram doesn't retry the same update in a loop.
  res.status(200).send("ok");
};
