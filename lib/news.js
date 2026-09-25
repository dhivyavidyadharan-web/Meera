const WINDOW_DAYS = 7;
const RECENCY_HALF_LIFE_DAYS = 2;
// Weighted article count at which the news score reaches ~63/100.
const SATURATION = 3;

function feedUrl(query) {
  const q = encodeURIComponent(`${query} when:${WINDOW_DAYS}d`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
}

function parseItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const source = tag(item, "source");
    let title = tag(item, "title");
    // Google News appends " - Source Name", and publishers often add it too, so strip repeatedly.
    const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
    for (let m; source && (m = title.match(/\s[-–—|]\s([^-–—|]+)$/)) && norm(m[1]) === norm(source); ) {
      title = title.slice(0, m.index).trim();
    }
    const sourceUrl = (item.match(/<source[^>]*\burl="([^"]+)"/) || [])[1] || "";
    return {
      title,
      source,
      sourceUrl: decode(sourceUrl),
      link: tag(item, "link"),
      published: new Date(tag(item, "pubDate")),
    };
  });
}

const isHttpUrl = (s) => /^https?:\/\/[^\s"<>]+$/.test(s);

// Only items with a real title, publisher and clickable link can ever be cited.
function isCitable(a) {
  return a.title && a.source && isHttpUrl(a.link) && !Number.isNaN(a.published.getTime());
}

// Google News matches loosely (article body, related terms), so only headlines
// that contain every significant word of the keyword count.
function isRelevant(title, keyword) {
  const t = title.toLowerCase();
  return keyword
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .every((w) => t.includes(w));
}

async function fetchNews(keyword, { timeoutMs = 6000 } = {}) {
  const res = await fetch(feedUrl(`"${keyword}"`), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MeeraNotesBot/1.0)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Google News RSS ${res.status} for "${keyword}"`);
  const now = Date.now();
  return parseItems(await res.text())
    .filter((a) => isCitable(a) && isRelevant(a.title, keyword))
    .map((a) => ({
      ...a,
      sourceUrl: isHttpUrl(a.sourceUrl) ? a.sourceUrl : "",
      ageDays: Math.max(0, (now - a.published.getTime()) / 86400000),
    }))
    .filter((a) => a.ageDays <= WINDOW_DAYS)
    .sort((a, b) => a.ageDays - b.ageDays);
}

// 0-100: each article counts less the older it is, and the total saturates so a
// handful of fresh articles scores well without needing hundreds.
function newsScore(articles) {
  const weighted = articles.reduce(
    (sum, a) => sum + Math.pow(0.5, a.ageDays / RECENCY_HALF_LIFE_DAYS),
    0
  );
  return Math.round(100 * (1 - Math.exp(-weighted / SATURATION)));
}

module.exports = { fetchNews, newsScore };
