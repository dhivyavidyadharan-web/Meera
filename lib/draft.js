const { generate } = require("./gemini");
const { findProblems, tidy } = require("./structure");
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
  const all = ordered
    .flatMap((k) => k.articles.map((a) => ({ ...a, keyword: k.keyword })))
    .filter((a) => !seen.has(a.link) && !seen.has(a.title.toLowerCase()) && seen.add(a.link) && seen.add(a.title.toLowerCase()));
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

Follow the NEWS CONTEXT and CITATION RULES. Return JSON: "post" is the full
reply text (the post, or your one clarifying question). "citations" lists, for
every headline the post cites, its number and the exact sentence from the post
(copied verbatim) that names its publication. Empty if none.`;
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
  const first = await generate({ system, turns: draftTurns, jsonSchema: DRAFT_SCHEMA, deadline });
  let post = tidy(first.post);
  let citations = first.citations;

  if (wordCount(post) < MIN_POST_WORDS) {
    return { post, sources: [], needsChecking: [] };
  }

  const firstCheckRuns = left() > NEED_FOR_FIRST_CHECK_MS;
  const firstAudit = await audit(post, citations, headlines, {
    runFactCheck: firstCheckRuns,
    deadline: checkDeadline(),
  });
  const toFix = [...firstAudit.citationProblems, ...firstAudit.factIssues, ...firstAudit.structureProblems];

  if (toFix.length === 0 && firstAudit.factCheckRan) {
    return { post, sources: firstAudit.valid, needsChecking: [] };
  }

  if (toFix.length === 0 || left() < NEED_FOR_REVISION_MS) {
    const needsChecking = [...firstAudit.citationProblems, ...firstAudit.factIssues];
    if (!firstAudit.factCheckRan) needsChecking.push(SKIPPED_CHECK);
    return { post, sources: firstAudit.valid, needsChecking };
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
  const needsChecking = [...finalAudit.citationProblems, ...finalAudit.factIssues];
  if (!finalAudit.factCheckRan) needsChecking.push(SKIPPED_CHECK);

  return { post, sources: finalAudit.valid, needsChecking };
}

const SKIPPED_CHECK =
  "The AI fact-check was skipped to stay within the time limit (or Gemini was busy). Sources above are still verified; cross-check the claims against them before posting.";

module.exports = { writePost, headlinePool };
