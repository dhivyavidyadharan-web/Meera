const fs = require("fs");
const path = require("path");
const { draftPost } = require("../lib/gemini");
const { sendMessage, sendChatAction } = require("../lib/telegram");

let cachedInstructions = null;

function loadInstructions() {
  // Env var takes priority so instructions can be updated without a redeploy.
  if (process.env.WRITING_INSTRUCTIONS) {
    return process.env.WRITING_INSTRUCTIONS;
  }
  if (cachedInstructions) return cachedInstructions;

  const filePath = path.join(process.cwd(), "config", "instructions.md");
  cachedInstructions = fs.readFileSync(filePath, "utf8");
  return cachedInstructions;
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

  // Optional shared-secret check. Set TELEGRAM_WEBHOOK_SECRET and pass the
  // same value as secret_token when registering the webhook (see scripts/set-webhook.js).
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const gotSecret = req.headers["x-telegram-bot-api-secret-token"];
    if (gotSecret !== expectedSecret) {
      res.status(401).send("Unauthorized");
      return;
    }
  }

  // Always 200 back to Telegram quickly-ish so it doesn't retry the same update.
  res.status(200).send("ok");

  try {
    const update = req.body;
    const message = update?.message || update?.edited_message;
    const chatId = message?.chat?.id;
    const text = message?.text;

    if (!chatId) return;

    if (!text) {
      await sendMessage(
        chatId,
        "I can only work with text notes right now — send me the note as a text message and I'll draft a post from it."
      );
      return;
    }

    if (text.startsWith("/start")) {
      await sendMessage(
        chatId,
        "Hi! Send me a note and I'll draft it into a post in your voice."
      );
      return;
    }

    await sendChatAction(chatId, "typing");

    const instructions = loadInstructions();
    const draft = await draftPost({ note: text, instructions });

    await sendMessage(chatId, draft);
  } catch (err) {
    console.error("Webhook error:", err);
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) {
        await sendMessage(
          chatId,
          "Something went wrong drafting that one — mind trying again in a bit?"
        );
      }
    } catch (sendErr) {
      console.error("Failed to notify chat of error:", sendErr);
    }
  }
};
