# Meera's notes-to-post bot

Meera sends a text note to a Telegram bot. The bot sends the note + her writing
instructions to Gemini, gets back a drafted post, and replies with it in the
same chat.

```
Meera --(text message)--> Telegram bot --(webhook)--> Vercel function
                                                          |
                                                          v
                                                  Gemini API (draft)
                                                          |
                                                          v
                                              Telegram bot --(reply)--> Meera
```

## Keyword scoring + Google News

For every note, the bot:

1. Asks Gemini for 3-5 keywords in the note, each with a **voice fit** rating
   (0-10) against Meera's themes (formulation, pH, labels vs reality,
   documentation, India climate, specific actives).
2. Searches Google News RSS (India edition, last 7 days) for each keyword as an
   exact phrase, keeping only articles whose headline contains the keyword.
3. Scores **news** 0-100: each article counts less as it ages (half-life 2 days),
   and the total saturates so a few fresh articles already score well.
4. **Total = 50% news + 50% voice fit.** Sends a score table, writes the post
   around the top keyword using 1-2 relevant headlines as a timely hook, then
   sends the links for the headlines actually used.

If a note has no clear topic, or Google News is unreachable, the bot skips
scoring and drafts as before. Weights live in `lib/keywords.js`; the news
window, half-life and saturation are in `lib/news.js`.

## Files

- `api/webhook.js` — the Vercel serverless function Telegram calls on every message.
- `lib/gemini.js` — calls the Gemini API (plain text or structured JSON).
- `lib/keywords.js` — extracts keywords and computes the combined score.
- `lib/news.js` — Google News RSS fetch, parsing, and news score.
- `lib/history.js` — short per-chat conversation memory (`/new` resets it).
- `lib/telegram.js` — sends replies back to Telegram (and splits long ones).
- `config/instructions.md` — Meera's voice/style instructions. **Replace the
  placeholder content in this file with her real instructions** (or set them
  via the `WRITING_INSTRUCTIONS` env var instead — see below).
- `scripts/set-webhook.js`, `webhook-info.js`, `delete-webhook.js` — one-off
  scripts to register/check/remove the Telegram webhook.

No npm dependencies — it uses Node's built-in `fetch`, so there's nothing to
`npm install`.

## 1. Create the Telegram bot

1. Open Telegram, message **@BotFather**, send `/newbot`, follow the prompts.
2. BotFather gives you a token like `123456:ABC-DEF...`. Save it — that's `TELEGRAM_BOT_TOKEN`.

## 2. Get a Gemini API key

Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and
create a key. That's `GEMINI_API_KEY`.

## 3. Add Meera's writing instructions

Edit [`config/instructions.md`](config/instructions.md) and replace the
placeholder with her actual voice/style guidance. This file is sent to Gemini
as the system instruction on every note. (Alternatively, set it as the
`WRITING_INSTRUCTIONS` env var in Vercel — that takes priority over the file
and can be updated without a redeploy.)

## 4. Deploy to Vercel

```bash
npm install -g vercel   # if you don't have it
vercel
```

Follow the prompts (link or create a project). Then add your env vars —
either in the Vercel dashboard (Project → Settings → Environment Variables)
or via CLI:

```bash
vercel env add TELEGRAM_BOT_TOKEN
vercel env add GEMINI_API_KEY
vercel env add TELEGRAM_WEBHOOK_SECRET   # optional but recommended
```

Then deploy to production:

```bash
vercel --prod
```

Note the deployment URL it prints, e.g. `https://meera-notes-bot.vercel.app`.

## 5. Point the Telegram bot at your Vercel URL

**First, turn off Vercel Deployment Protection**, or Telegram gets redirected to a
Vercel login page and never reaches the bot: Project → Settings → Deployment
Protection → Vercel Authentication → Disabled → Save.

Then open `https://<your-production-domain>/api/setup` in a browser (add
`?key=<TELEGRAM_WEBHOOK_SECRET>` if you set one). It checks the env vars,
Telegram, and Gemini, registers the webhook using the server's own keys, and
shows Telegram's last delivery error if any.

Alternatively, run this once from your own machine:

```bash
TELEGRAM_BOT_TOKEN=xxx DEPLOY_URL=https://meera-notes-bot.vercel.app TELEGRAM_WEBHOOK_SECRET=yyy node scripts/set-webhook.js
```

(Omit `TELEGRAM_WEBHOOK_SECRET` if you didn't set one.) You should see
`"ok": true` in the response.

To confirm it's registered:

```bash
TELEGRAM_BOT_TOKEN=xxx node scripts/webhook-info.js
```

## 6. Try it

Open a chat with your bot in Telegram and send a note as a text message. It
should reply with a drafted post in a few seconds.

## Notes / things to know

- **Text messages only for now.** If Meera sends a voice memo, the bot will
  ask her to send it as text instead — Telegram voice-note transcription
  isn't wired up. (Easy to add later via Gemini's audio input if wanted.)
- **Long drafts** are automatically split across multiple Telegram messages
  since Telegram caps messages at 4096 characters.
- **Editing instructions later:** just edit `config/instructions.md` and
  redeploy (`vercel --prod`), or set the `WRITING_INSTRUCTIONS` env var in
  the Vercel dashboard for a no-redeploy update.
- **Changing the Gemini model:** set `GEMINI_MODEL` (default `gemini-flash-latest`).
- If you ever need to move the webhook to a new URL, just re-run
  `scripts/set-webhook.js` with the new `DEPLOY_URL` — no need to delete first.
