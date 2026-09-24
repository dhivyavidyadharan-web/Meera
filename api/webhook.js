const fs = require("fs");
const path = require("path");
const { draftPost, generate } = require("../lib/gemini");
const { sendMessage, sendChatAction } = require("../lib/telegram");
const { getHistory, addTurns, clearHistory } = require("../lib/history");
const { scoreKeywords, formatScores } = require("../lib/keywords");

const MAX_HEADLINES = 6;

const DRAFT_SCHEMA = {
  type: "OBJECT",
  properties: {
    post: { type: "STRING" },
    used_headlines: { type: "ARRAY", items: { type: "INTEGER" } },
  },
  required: ["post", "used_headlines"],
};

function ageLabel(days) {
  if (days < 1) return "today";
  const d = Math.round(days);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

function withNewsContext(note, keyword, headlines) {
  const list = headlines.length
    ? headlines.map((a, i) => `[${i + 1}] ${a.title} (${a.source}, ${ageLabel(a.ageDays)})`).join("\n")
    : "(no recent articles found)";
  return `${note}

---
NEWS CONTEXT (automatically attached, not written by Meera)
Top-scoring keyword: ${keyword}
Recent Google News headlines for it:
${list}

Follow the NEWS CONTEXT rules in your instructions. Return JSON: "post" is the
full reply text (the post, or your one clarifying question); "used_headlines" is
the list of headline numbers you actually drew on (empty if none).`;
}

function formatSources(articles) {
  return [
    "Sources used",
    ...articles.map((a) => `\n${a.title}\n${a.source}, ${ageLabel(a.ageDays)}\n${a.link}`),
  ].join("\n");
}

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

async function handleUpdate(update) {
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

    let ranked = [];
    try {
      ranked = await scoreKeywords(turns);
    } catch (err) {
      console.error("Keyword scoring failed, drafting without news:", err);
    }

    if (ranked.length === 0) {
      const draft = await draftPost({ note: text, instructions: loadInstructions(), history });
      addTurns(chatId, { role: "user", text }, { role: "model", text: draft });
      await sendMessage(chatId, draft, replyOpts);
      return;
    }

    await sendMessage(chatId, formatScores(ranked), replyOpts);
    await sendChatAction(chatId, "typing");

    const top = ranked[0];
    const headlines = top.articles.slice(0, MAX_HEADLINES);
    const { post, used_headlines } = await generate({
      system: loadInstructions(),
      turns: [...history, { role: "user", text: withNewsContext(text, top.keyword, headlines) }],
      jsonSchema: DRAFT_SCHEMA,
    });

    addTurns(chatId, { role: "user", text }, { role: "model", text: post });
    await sendMessage(chatId, post, replyOpts);

    const used = [...new Set(used_headlines || [])]
      .map((n) => headlines[n - 1])
      .filter(Boolean);
    if (used.length) {
      await sendMessage(chatId, formatSources(used), {
        ...replyOpts,
        link_preview_options: { is_disabled: true },
      });
    }
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
