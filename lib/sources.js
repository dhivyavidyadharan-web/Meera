const { generate } = require("./gemini");
const { escapeHtml } = require("./telegram");
const { sentences } = require("./structure");

// Wording that presents something as coming from an outside source. Any sentence
// like this must be one of the verified citations, or it gets flagged.
const ATTRIBUTION = new RegExp(
  [
    "according to",
    "\\b(?:a|one|the|this|that) (?:new |recent |large |small |\\d{4} )?(?:study|survey|trial|paper|meta-analysis|review)\\b",
    "\\bstudies (?:show|suggest|found|find|have)",
    "\\b(?:a|one|the|this|that) (?:new |recent |\\d{4} )?report (?:by|from|in|found|shows|says)",
    "\\breports? (?:that|show|shows|found|suggest|suggests)\\b",
    "\\b(?:was |were |has been |have been )?reported (?:by|in|that)",
    "\\bresearch(?:ers)? (?:show|shows|suggest|suggests|found|find|say|says)",
    "\\bpublished (?:in|by)\\b",
    "\\bjournal\\b",
    "\\b(?:piece|article|headline|column|op-ed)\\b",
    "\\b(?:experts?|dermatologists?|scientists?|doctors?) (?:say|says|said|recommend|recommends|note|found|agree|warn)",
  ].join("|"),
  "i"
);

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*[—–]\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();

function sourceNames(source) {
  const full = norm(source);
  const core = full
    .replace(/^the\s+/, "")
    .replace(/^www\./, "")
    .replace(/\.(com|in|co\.in|net|org|co\.uk|news)$/, "")
    .trim();
  return [...new Set([full, core])].filter((n) => n.length >= 4);
}

const namesSource = (sentence, source) => sourceNames(source).some((n) => norm(sentence).includes(n));

// citations: [{ headline: 1-based number, sentence }] as returned by Gemini.
// Returns only citations the code could verify, plus a problem for each that failed.
function validateCitations(post, citations, headlines) {
  const body = norm(post);
  const valid = [];
  const problems = [];

  for (const c of citations || []) {
    const h = headlines[c.headline - 1];
    const sentence = (c.sentence || "").trim();
    if (!h) {
      problems.push(`A citation points to headline ${c.headline}, which does not exist. Cite only the listed headlines.`);
    } else if (!sentence || !body.includes(norm(sentence))) {
      problems.push(`The citation for headline ${c.headline} (${h.source}) is not a sentence that appears in the post. Copy the citing sentence exactly.`);
    } else if (!namesSource(sentence, h.source)) {
      problems.push(`The sentence citing headline ${c.headline} must name its publication, ${h.source}: "${sentence}"`);
    } else if (!valid.some((v) => v.article === h)) {
      valid.push({ article: h, sentence });
    }
  }

  const cited = new Set(valid.map((v) => norm(v.sentence)));
  for (const s of sentences(post.replace(/\n+/g, " "))) {
    if (!ATTRIBUTION.test(s)) continue;
    if ([...cited].some((c) => c.includes(norm(s)) || norm(s).includes(c))) continue;
    problems.push(
      `This sentence reads like it cites a source but is not tied to a listed headline: "${s}". Either cite a listed headline by publication name, or rewrite it as Meera's own statement without implying a source.`
    );
  }

  for (const h of headlines) {
    if (valid.some((v) => v.article === h)) continue;
    const mention = sentences(post.replace(/\n+/g, " ")).find((s) => norm(s).includes(norm(h.source)));
    if (mention) problems.push(`The post names ${h.source} but does not list it as a citation: "${mention}"`);
  }

  return { valid, problems };
}

const FACT_CHECK_PROMPT = `You are a strict fact-checker for LinkedIn posts written in the voice of
Meera Pillai, a former pharma formulator who never overclaims. You get the post
and the ONLY sources it may cite: news headlines (the model that wrote the post
saw only the headlines, never the articles).

Report every problem of these kinds:
1. headline_mismatch: a sentence attributes to a publication anything the
   headline itself does not say (a finding, a detail, an opinion, an emphasis).
   Restating the headline's topic is fine. Meera's own commentary is fine only
   in a separate sentence that does not attribute it to the publication.
2. invented_source: any publication, study, survey, report, journal, expert,
   brand statement, or statistic source that is not in the headline list.
3. overclaim: a scientific or factual claim stated more strongly than
   well-established cosmetic science supports - absolute verbs (halts, cures,
   proves, dictates, destroys, always, never), invented precise numbers, or
   sweeping generalisations ("most brands", "every formula") with no basis.
4. hype: words Meera avoids (e.g. immensely, game-changer, miracle, revolutionary,
   amazing, holy grail, must-have, glow).
5. brand_named: the post names a specific skincare brand or product other
   than Skinstinct (including when quoting a headline). Publications and
   generic ingredient names are fine.

For each problem give the exact quote from the post (verbatim), the kind, what
is wrong in under 25 words, and a calmer, accurate replacement. Return an empty
list if the post is clean. Do not flag stylistic choices that are not listed.`;

const FACT_CHECK_SCHEMA = {
  type: "OBJECT",
  properties: {
    issues: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          quote: { type: "STRING" },
          kind: { type: "STRING", enum: ["headline_mismatch", "invented_source", "overclaim", "hype", "brand_named"] },
          problem: { type: "STRING" },
          suggestion: { type: "STRING" },
        },
        required: ["quote", "kind", "problem", "suggestion"],
      },
    },
  },
  required: ["issues"],
};

async function factCheck(post, headlines) {
  const list = headlines.length
    ? headlines.map((a, i) => `[${i + 1}] "${a.title}" - ${a.source}`).join("\n")
    : "(none - the post must not cite any publication)";
  const { issues } = await generate({
    system: FACT_CHECK_PROMPT,
    turns: [{ role: "user", text: `HEADLINES (the only allowed sources):\n${list}\n\nPOST:\n${post}` }],
    temperature: 0,
    jsonSchema: FACT_CHECK_SCHEMA,
  });
  return issues || [];
}

const describeIssue = (i) => `[${i.kind}] "${i.quote}" - ${i.problem} Suggested: "${i.suggestion}"`;

function ageLabel(days) {
  if (days < 1) return "today";
  const d = Math.round(days);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

const link = (url, text) => `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function formatSourcesHtml(valid) {
  return [
    "<b>SOURCES</b> <i>(real Google News results, each checked against the post)</i>",
    ...valid.map(({ article: a, sentence }, i) => {
      const publisher = a.sourceUrl ? link(a.sourceUrl, hostOf(a.sourceUrl) || a.source) : escapeHtml(a.source);
      return [
        `\n${i + 1}. ${link(a.link, a.title)}`,
        `${escapeHtml(a.source)} (${publisher}), ${ageLabel(a.ageDays)}`,
        `Used in post: <i>"${escapeHtml(clip(sentence, 160))}"</i>`,
      ].join("\n");
    }),
  ].join("\n");
}

function formatNeedsCheckingHtml(items) {
  return [
    "<b>NEEDS CHECKING</b> <i>(not verified - edit these before posting)</i>",
    ...items.map((t) => `- ${escapeHtml(clip(t, 300))}`),
  ].join("\n");
}

module.exports = {
  validateCitations,
  factCheck,
  describeIssue,
  formatSourcesHtml,
  formatNeedsCheckingHtml,
  ageLabel,
};
