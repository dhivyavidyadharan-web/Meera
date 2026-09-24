const fs = require("fs");
const path = require("path");
const { draftPost } = require("../lib/gemini");
const { sendMessage, sendChatAction } = require("../lib/telegram");

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
  const message = update?.message || update?.edited_message;
  const chatId = message?.chat?.id;
  const text = message?.text;

  if (!chatId) return;

  if (!text) {
    await sendMessage(
      chatId,
      "I can only work with text notes right now. Send the note as a text message and I'll draft a LinkedIn post from it."
    );
    return;
  }

  if (text.startsWith("/start")) {
    await sendMessage(
      chatId,
      "Hi Meera. Send me a note (a data point, a story, a customer question) and I'll draft a LinkedIn post from it in your voice."
    );
    return;
  }

  try {
    await sendChatAction(chatId, "typing");
    const draft = await draftPost({ note: text, instructions: loadInstructions() });
    await sendMessage(chatId, draft);
  } catch (err) {
    console.error("Draft failed:", err);
    await sendMessage(
      chatId,
      "Something went wrong drafting that one. Please try again in a minute."
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
