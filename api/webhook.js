const fs = require("fs");
const path = require("path");
const { draftPost, generate } = require("../lib/gemini");
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
const { findProblems, tidy } = require("../lib/structure");

const MAX_HEADLINES = 8;
const MIN_SOURCES = 2;
const DIVIDER = "━━━━━━━━━━━━━━━━";

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

// Headlines from the top keyword first, then the others, one per publication
// before any repeats, so the post has distinct sources to cite.
function headlinePool(ranked) {
  const seen = new Set();
  const all = ranked
    .flatMap((k) => k.articles.map((a) => ({ ...a, keyword: k.keyword })))
    .filter((a) => !seen.has(a.title.toLowerCase()) && seen.add(a.title.toLowerCase()));
  const sources = new Set();
  const firstPerSource = all.filter((a) => !sources.has(a.source) && sources.add(a.source));
  const rest = all.filter((a) => !firstPerSource.includes(a));
  return [...firstPerSource, ...rest].slice(0, MAX_HEADLINES);
}

const distinctSources = (articles) => new Set(articles.map((a) => a.source)).size;

function withNewsContext(note, keyword, headlines) {
  const list = headlines.length
    ? headlines
        .map((a, i) => `[${i + 1}] ${a.title} (${a.source}, ${ageLabel(a.ageDays)}; keyword: ${a.keyword})`)
        .join("\n")
    : "(no recent articles found)";
  return `${note}

---
NEWS CONTEXT (automatically attached, not written by Meera)
Top-scoring keyword: ${keyword}
Recent Google News headlines:
${list}

Follow the NEWS CONTEXT rules in your instructions. Return JSON: "post" is the
full reply text (the post, or your one clarifying question); "used_headlines" is
the list of headline numbers you actually cite in the post (empty if none).`;
}

function pickUsed(numbers, headlines) {
  return [...new Set(numbers || [])].map((n) => headlines[n - 1]).filter(Boolean);
}

// One revision pass at most, so a stubborn draft can't loop or blow the time limit.
async function enforceStructure({ post, used }, turns, headlines) {
  const minSources = Math.min(MIN_SOURCES, distinctSources(headlines));
  const problems = findProblems(tidy(post), { minSources, citedSources: distinctSources(used) });
  if (problems.length === 0) return { post: tidy(post), used };

  try {
    const revised = await generate({
      system: loadInstructions(),
      turns: [
        ...turns,
        { role: "model", text: post },
        {
          role: "user",
          text: `Revise this post to follow the POST STRUCTURE and NEWS CONTEXT rules. Fix:\n- ${problems.join("\n- ")}\nKeep the same facts and voice. Return JSON in the same format, with "used_headlines" listing every headline number the revised post cites.`,
        },
      ],
      temperature: 0.4,
      jsonSchema: DRAFT_SCHEMA,
    });
    return { post: tidy(revised.post), used: pickUsed(revised.used_headlines, headlines) };
  } catch (err) {
    console.error("Structure revision failed, sending first draft:", err);
    return { post: tidy(post), used };
  }
}

function formatSourcesHtml(articles) {
  return [
    "<b>SOURCES</b>",
    ...articles.map(
      (a, i) =>
        `${i + 1}. <a href="${escapeHtml(a.link)}">${escapeHtml(a.title)}</a> - ${escapeHtml(a.source)}, ${ageLabel(a.ageDays)}`
    ),
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
      const first = await draftPost({ note: text, instructions: loadInstructions(), history });
      const { post } = await enforceStructure({ post: first, used: [] }, turns, []);
      addTurns(chatId, { role: "user", text }, { role: "model", text: post });
      await sendMessage(chatId, post, replyOpts);
      return;
    }

    await sendChatAction(chatId, "typing");

    const headlines = headlinePool(ranked);
    const draftTurns = [...history, { role: "user", text: withNewsContext(text, ranked[0].keyword, headlines) }];
    const first = await generate({ system: loadInstructions(), turns: draftTurns, jsonSchema: DRAFT_SCHEMA });
    const { post, used } = await enforceStructure(
      { post: first.post, used: pickUsed(first.used_headlines, headlines) },
      draftTurns,
      headlines
    );

    addTurns(chatId, { role: "user", text }, { role: "model", text: post });

    const sections = [formatScoresHtml(ranked), DIVIDER, escapeHtml(post), DIVIDER];
    if (used.length) sections.push(formatSourcesHtml(used));
    const combined = sections.join("\n\n");

    if (visibleLength(combined) <= TELEGRAM_MESSAGE_LIMIT) {
      await sendHtml(chatId, combined, replyOpts);
    } else {
      await sendHtml(chatId, sections.slice(0, 3).join("\n\n"), replyOpts);
      if (used.length) await sendHtml(chatId, formatSourcesHtml(used), replyOpts);
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
