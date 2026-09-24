const MAX_SENTENCES_PER_PARAGRAPH = 3;
const MAX_WORDS_PER_SENTENCE = 25;
const MAX_WORDS = 420;
// Replies shorter than this are clarifying questions, not posts.
const MIN_POST_WORDS = 80;

const words = (s) => s.split(/\s+/).filter(Boolean).length;
const sentences = (p) => p.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).filter((s) => s.trim());

function splitNote(text) {
  const m = text.match(/\n\s*Note:[\s\S]*$/);
  return m ? { body: text.slice(0, m.index).trim(), note: m[0].trim() } : { body: text.trim(), note: "" };
}

function tidy(text) {
  return text.replace(/\s*[—–]\s*/g, " - ").replace(/[ \t]{2,}/g, " ");
}

function findProblems(text) {
  const { body } = splitNote(text);
  if (words(body) < MIN_POST_WORDS) return [];

  const problems = [];
  const total = words(body);
  if (total > MAX_WORDS) problems.push(`The post is ${total} words; cut it to 250-400.`);

  body.split(/\n\s*\n/).forEach((p, i) => {
    const ss = sentences(p);
    if (ss.length > MAX_SENTENCES_PER_PARAGRAPH) {
      problems.push(`Paragraph ${i + 1} has ${ss.length} sentences; split or cut it to at most 3.`);
    }
    ss.filter((s) => words(s) > MAX_WORDS_PER_SENTENCE).forEach((s) => {
      problems.push(`This sentence is ${words(s)} words; shorten or split it: "${s.slice(0, 60)}..."`);
    });
  });

  return problems;
}

module.exports = { findProblems, tidy };
