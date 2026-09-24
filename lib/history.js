// Best-effort per-chat memory. Lives in the warm serverless instance, so it can
// reset on a cold start; the reply-to text in webhook.js covers that case.
const MAX_TURNS = 10;
const TTL_MS = 60 * 60 * 1000;

const chats = new Map();

function getHistory(chatId) {
  const entry = chats.get(chatId);
  if (!entry || Date.now() - entry.updatedAt > TTL_MS) {
    chats.delete(chatId);
    return [];
  }
  return entry.turns;
}

function addTurns(chatId, ...turns) {
  const next = [...getHistory(chatId), ...turns].slice(-MAX_TURNS);
  chats.set(chatId, { turns: next, updatedAt: Date.now() });
}

function clearHistory(chatId) {
  chats.delete(chatId);
}

module.exports = { getHistory, addTurns, clearHistory };
