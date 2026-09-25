const { generate } = require("./gemini");
const { fetchNews, newsScore } = require("./news");
const { escapeHtml } = require("./telegram");

const NEWS_WEIGHT = 0.5;
const FIT_WEIGHT = 0.5;

const EXTRACT_PROMPT = `You extract topic keywords from notes sent by Meera Pillai, founder of
Skinstinct, an Indian skincare brand. She is a former pharma formulator whose
writing focuses on: formulation and delivery base, pH, concentration and
stability, documentation (CoA, stability testing, sourcing), the gap between
label/marketing claims and formulation reality, unregulated claims ("clinically
tested", "natural", "clean"), India-specific context (humidity, heat, UV), specific
actives and ingredient forms, and questions customers should ask any brand.

From the conversation (focus on Meera's latest message, using earlier messages
for context), return 3 to 5 keywords worth writing a LinkedIn post about.
Prefer specific ingredients, claims, or concepts over generic words ("skincare",
"post", "brands" alone are too generic unless nothing better exists).

For each keyword give:
- keyword: 1-3 words, the plain name as it would appear in a news headline
  (e.g. "salicylic acid", "sunscreen", "clean beauty"); it is searched as an
  exact phrase
- voice_fit: integer 0-10, how well it fits the focus areas above
  (10 = core formulation/label-honesty topic, 0 = unrelated to her work)
- fit_reason: under 12 words
- is_main_topic: true for exactly ONE keyword - the one closest to what Meera
  actually asked to write about - and false for the rest

If the message has no topic at all (e.g. "hi", "write me a post"), return an
empty list.`;

const EXTRACT_SCHEMA = {
  type: "OBJECT",
  properties: {
    keywords: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          keyword: { type: "STRING" },
          voice_fit: { type: "INTEGER" },
          fit_reason: { type: "STRING" },
          is_main_topic: { type: "BOOLEAN" },
        },
        required: ["keyword", "voice_fit", "fit_reason", "is_main_topic"],
      },
    },
  },
  required: ["keywords"],
};

async function extractKeywords(turns, deadline) {
  const { keywords } = await generate({
    system: EXTRACT_PROMPT,
    turns,
    temperature: 0.2,
    jsonSchema: EXTRACT_SCHEMA,
    deadline,
    fast: true,
    thinkingBudget: 0,
  });
  return (keywords || []).slice(0, 5);
}

// Returns keywords ranked by total score, each with its matching news articles,
// plus the keyword to write around: Meera's own topic, so a news-heavy side
// keyword can never pull the post away from what she asked about.
async function scoreKeywords(turns, { deadline } = {}) {
  const extracted = await extractKeywords(turns, deadline);

  const ranked = (
    await Promise.all(
      extracted.map(async (k) => {
        const articles = await fetchNews(k.keyword).catch((err) => {
          console.error(err.message);
          return [];
        });
        const news = newsScore(articles);
        const fit = Math.max(0, Math.min(10, k.voice_fit)) * 10;
        return {
          keyword: k.keyword,
          fitReason: k.fit_reason,
          news,
          fit,
          total: Math.round(NEWS_WEIGHT * news + FIT_WEIGHT * fit),
          articleCount: articles.length,
          isMainTopic: Boolean(k.is_main_topic),
          articles,
        };
      })
    )
  ).sort((a, b) => b.total - a.total);

  const main = ranked.find((k) => k.isMainTopic) || ranked[0];
  return { ranked, main };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function formatScoresHtml(ranked, main) {
  const lines = ranked.map(
    (k, i) =>
      `${i + 1}. <b>${escapeHtml(k.keyword)}</b>: ${k.total}  (news ${k.news}, ${plural(k.articleCount, "article")} | voice fit ${k.fit})${k === main ? "  <i>your topic</i>" : ""}`
  );
  return [
    "<b>KEYWORD SCORES</b>",
    "<i>50% Google News volume + recency (7 days), 50% fit with your voice</i>",
    "",
    ...lines,
    "",
    `Writing around: <b>${escapeHtml(main.keyword)}</b>`,
  ].join("\n");
}

module.exports = { scoreKeywords, formatScoresHtml };
