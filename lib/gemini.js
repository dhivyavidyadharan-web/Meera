const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// turns: [{ role: "user" | "model", text }], oldest first.
async function generate({ system, turns, temperature = 0.8, jsonSchema }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    generationConfig: {
      temperature,
      ...(jsonSchema ? { responseMimeType: "application/json", responseSchema: jsonSchema } : {}),
    },
  };

  const res = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";

  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return jsonSchema ? JSON.parse(text) : text.trim();
}

module.exports = { generate };
