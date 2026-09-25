const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 40000;
const MAX_ATTEMPTS = 3;

class GeminiError extends Error {
  // kind: "rate_limit" | "time" | "bad_json" | "empty" | "api"
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini's 429 body says how long to wait, e.g. "retryDelay": "12s".
function retryDelayMs(errText, attempt) {
  const m = errText.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(Number(m[1]) * 1000) : 1500 * attempt;
}

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new GeminiError("bad_json", `Gemini returned malformed JSON: ${cleaned.slice(0, 120)}`);
  }
}

const MAIN_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const FAST_MODEL = process.env.GEMINI_FAST_MODEL || "gemini-flash-lite-latest";
let fastModelUnavailable = false;
const thinkingUnsupported = new Set();

// turns: [{ role: "user" | "model", text }], oldest first.
// deadline: absolute ms timestamp; the call (including retries) never runs past it.
// fast: use the lighter model (for simple extraction). thinkingBudget: cap on
// the model's hidden reasoning tokens, the main source of latency.
async function generate({ system, turns, temperature = 0.8, jsonSchema, deadline, fast = false, thinkingBudget }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiError("api", "GEMINI_API_KEY is not set");
  }

  let model = fast && !fastModelUnavailable ? FAST_MODEL : MAIN_MODEL;

  const buildBody = () =>
    JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      generationConfig: {
        temperature,
        ...(jsonSchema ? { responseMimeType: "application/json", responseSchema: jsonSchema } : {}),
        ...(thinkingBudget != null && !thinkingUnsupported.has(model)
          ? { thinkingConfig: { thinkingBudget } }
          : {}),
      },
    });

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline ? deadline - Date.now() : DEFAULT_TIMEOUT_MS;
    if (remaining < 3000) {
      throw lastError || new GeminiError("time", "Not enough time left for another Gemini call");
    }

    let res;
    try {
      res = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: buildBody(),
        signal: AbortSignal.timeout(Math.min(DEFAULT_TIMEOUT_MS, remaining)),
      });
    } catch (err) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new GeminiError("time", "Gemini took too long to respond");
      }
      throw err;
    }

    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
      if (!text) {
        lastError = new GeminiError("empty", `Gemini returned an empty response (${data?.candidates?.[0]?.finishReason || "no candidate"})`);
        continue;
      }
      if (!jsonSchema) return text.trim();
      try {
        return parseJson(text);
      } catch (err) {
        lastError = err;
        continue;
      }
    }

    const errText = await res.text();

    // Fall back instead of failing: the fast model may not exist for this key,
    // and some models reject a thinking budget.
    if (model === FAST_MODEL && (res.status === 404 || res.status === 403)) {
      fastModelUnavailable = true;
      model = MAIN_MODEL;
      attempt--;
      continue;
    }
    if (res.status === 400 && /thinking/i.test(errText) && !thinkingUnsupported.has(model)) {
      thinkingUnsupported.add(model);
      attempt--;
      continue;
    }

    const retryable = res.status === 429 || res.status >= 500;
    lastError = new GeminiError(
      res.status === 429 ? "rate_limit" : "api",
      `Gemini API error ${res.status}: ${errText.slice(0, 300)}`,
      res.status
    );
    if (!retryable) throw lastError;

    const wait = retryDelayMs(errText, attempt);
    if (deadline && Date.now() + wait > deadline - 5000) throw lastError;
    await sleep(wait);
  }
  throw lastError;
}

module.exports = { generate, GeminiError };
