const { generate } = require("./gemini");
const { findProblems, tidy, postWordCount, MAX_WORDS } = require("./structure");
const { validateCitations, factCheck, describeIssue, ageLabel } = require("./sources");

const MAX_HEADLINES = 8;
const MIN_SOURCES = 2;
// Replies shorter than this are clarifying questions; they skip the checks.
const MIN_POST_WORDS = 80;
// Vercel kills the function at 60s (maxDuration); everything must finish before this.
const TOTAL_BUDGET_MS = 55000;
// Minimum time left to start each optional step.
const NEED_FOR_FIRST_CHECK_MS = 28000;
const NEED_FOR_REVISION_MS = 16000;
const NEED_FOR_FINAL_CHECK_MS = 9000;
const FACT_CHECK_MAX_MS = 14000;
// Hidden reasoning is the main source of latency; these caps keep each call quick.
const DRAFT_THINKING = 1024;
const REVISE_THINKING = 512;
const MAX_RELATED = 3;

const DRAFT_SCHEMA = {
  type: "OBJECT",
  properties: {
    post: { type: "STRING" },
    citations: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          headline: { type: "INTEGER" },
          sentence: { type: "STRING" },
        },
        required: ["headline", "sentence"],
      },
    },
  },
  required: ["post", "citations"],
};

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
const distinctSources = (articles) => new Set(articles.map((a) => a.source)).size;

// Meera's topic first, then the other keywords; one per publication before repeats.
function headlinePool(ranked, main) {
  const ordered = [main, ...ranked.filter((k) => k !== main)];
  const seen = new Set();
  const deduped = ordered
    .flatMap((k) => k.articles.map((a) => ({ ...a, keyword: k.keyword })))
    .filter((a) => !seen.has(a.link) && !seen.has(a.title.toLowerCase()) && seen.add(a.link) && seen.add(a.title.toLowerCase()));
  // Real articles (any keyword, Meera's topic first) before product listings.
  const all = [...deduped.filter((a) => !looksLikeListing(a.title)), ...deduped.filter((a) => looksLikeListing(a.title))];
  const sources = new Set();
  const firstPerSource = all.filter((a) => !sources.has(a.source) && sources.add(a.source));
  return [...firstPerSource, ...all.filter((a) => !firstPerSource.includes(a))].slice(0, MAX_HEADLINES);
}

function withNewsContext(note, topic, headlines) {
  const list = headlines.length
    ? headlines.map((a, i) => `[${i + 1}] "${a.title}" - ${a.source}, ${ageLabel(a.ageDays)} (keyword: ${a.keyword})`).join("\n")
    : "(no recent articles found - do not cite any publication)";
  return `${note}

---
NEWS CONTEXT (automatically attached, not written by Meera)
Meera's topic: ${topic}
Recent Google News headlines - the ONLY sources that exist for this post:
${list}

${mustCite(headlines)}
Follow the NEWS CONTEXT and CITATION RULES. Return JSON: "post" is the full
reply text (the post, or your one clarifying question). "citations" lists, for
every headline the post cites, its number and the exact sentence from the post
(copied verbatim) that names its publication. Empty if none.`;
}

// [1] and [2] are the best headlines from two different publications (see headlinePool).
function mustCite(headlines) {
  if (headlines.length === 0) return "";
  if (distinctSources(headlines) < 2) {
    return `REQUIRED: cite headline [1] (${headlines[0].source}) by name in the hook or the turn.\n`;
  }
  return `REQUIRED: cite headline [1] (${headlines[0].source}) in the hook or the turn, and headline [2] (${headlines[1].source}) in one of the factor paragraphs, each by publication name. You may add [3] if it fits. If [1] or [2] is a product listing, an ad, or off-topic, cite a different listed headline from another publication instead - never name the product or brand. A post that cites fewer than 2 headlines will be rejected.\n`;
}

// Retail/product-listing headlines ("Brand X Serum - 30ml", "Up to 50% Off") make poor
// citations and invite naming competitor brands.
function looksLikeListing(title) {
  return /\b\d+(\.\d+)?\s?(ml|fl\.? ?oz|oz)\b|\d+%\s*off\b|\bup to \d+%|\b(sale|deals|discount|coupon|price drop|buy now)\b|under (₹|rs\.?)\s?\d|\s-\s\d+(\.\d+)?%\s/i.test(title);
}

async function audit(post, citations, headlines, { runFactCheck = true, deadline } = {}) {
  const { valid, problems: citationProblems } = validateCitations(post, citations, headlines);
  const minSources = Math.min(MIN_SOURCES, distinctSources(headlines));
  const structureProblems = findProblems(post, {
    minSources,
    citedSources: distinctSources(valid.map((v) => v.article)),
  });
  let factIssues = [];
  let factCheckRan = false;
  if (runFactCheck) {
    try {
      factIssues = (await factCheck(post, headlines, deadline)).map(describeIssue);
      factCheckRan = true;
    } catch (err) {
      console.error("Fact-check failed:", err);
    }
  }
  return { valid, citationProblems, structureProblems, factIssues, factCheckRan };
}

// Draft, verify, revise once, verify again. Anything still unverified is
// returned in needsChecking so it is shown to Meera instead of hidden.
async function writePost({ system, turns, note, topic, headlines, startedAt }) {
  const deadline = startedAt + TOTAL_BUDGET_MS;
  const left = () => deadline - Date.now();
  const checkDeadline = () => Math.min(deadline, Date.now() + FACT_CHECK_MAX_MS);

  const draftTurns = [...turns.slice(0, -1), { role: "user", text: withNewsContext(note, topic, headlines) }];
  const first = await generate({
    system,
    turns: draftTurns,
    jsonSchema: DRAFT_SCHEMA,
    deadline,
    thinkingBudget: DRAFT_THINKING,
  });
  let post = tidy(first.post);
  let citations = first.citations;

  if (wordCount(post) < MIN_POST_WORDS) {
    return finish(post, [], [], headlines);
  }

  const firstCheckRuns = left() > NEED_FOR_FIRST_CHECK_MS;
  const firstAudit = await audit(post, citations, headlines, {
    runFactCheck: firstCheckRuns,
    deadline: checkDeadline(),
  });
  const toFix = [...firstAudit.citationProblems, ...firstAudit.factIssues, ...firstAudit.structureProblems];

  if (toFix.length === 0 && firstAudit.factCheckRan) {
    return finish(post, firstAudit.valid, [], headlines);
  }

  if (toFix.length === 0 || left() < NEED_FOR_REVISION_MS) {
    return finish(post, firstAudit.valid, unresolved(firstAudit, post, headlines), headlines);
  }

  try {
    const revised = await generate({
      system,
      turns: [
        ...draftTurns,
        { role: "model", text: JSON.stringify({ post, citations }) },
        {
          role: "user",
          text: `Revise the post. Fix every item:\n- ${toFix.join("\n- ")}\n\nKeep Meera's voice and the POST STRUCTURE. Cite only the listed headlines, saying only what each headline says. Return JSON in the same format, with "citations" copied verbatim from the revised post.`,
        },
      ],
      temperature: 0.4,
      jsonSchema: DRAFT_SCHEMA,
      deadline: deadline - NEED_FOR_FINAL_CHECK_MS + 2000,
      thinkingBudget: REVISE_THINKING,
    });
    post = tidy(revised.post);
    citations = revised.citations;
  } catch (err) {
    console.error("Revision failed, keeping first draft:", err);
  }

  const finalAudit = await audit(post, citations, headlines, {
    runFactCheck: left() > NEED_FOR_FINAL_CHECK_MS,
    deadline: Math.min(deadline - 1500, checkDeadline()),
  });
  return finish(post, finalAudit.valid, unresolved(finalAudit, post, headlines), headlines);
}

// Everything still wrong after the last check, in the order Meera should fix it.
function unresolved(a, post, headlines) {
  const items = [...a.citationProblems, ...a.factIssues];

  const cited = distinctSources(a.valid.map((v) => v.article));
  const wanted = Math.min(MIN_SOURCES, distinctSources(headlines));
  if (cited < wanted) {
    items.push(
      `The post cites ${cited} of the ${wanted} news sources it should. The news articles linked above are real; work one into the post, or post it without news references.`
    );
  }

  const n = postWordCount(post);
  if (n > MAX_WORDS) items.push(`The post is ${n} words, over the ${MAX_WORDS}-word limit. Trim ${n - MAX_WORDS}+ words before posting.`);

  if (!a.factCheckRan) {
    items.push(
      "The AI fact-check was skipped to stay within the time limit (or Gemini was busy), so claims in the post are unchecked. Compare them against the linked articles before posting."
    );
  }
  return items;
}

// related: fetched articles the post didn't cite, so Meera always gets real links.
function finish(post, sources, needsChecking, headlines) {
  const citedLinks = new Set(sources.map((s) => s.article.link));
  const related = headlines.filter((h) => !citedLinks.has(h.link)).slice(0, MAX_RELATED);
  return { post, sources, needsChecking, related };
}

module.exports = { writePost, headlinePool };
