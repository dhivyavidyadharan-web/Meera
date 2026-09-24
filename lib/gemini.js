const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Sends a note + Meera's style instructions to Gemini and returns the drafted post.
 */
async function draftPost({ note, instructions }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

  const body = {
    system_instruction: {
      parts: [{ text: instructions }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: note }],
      },
    ],
    generationConfig: {
      temperature: 0.8,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
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

  return text.trim();
}

module.exports = { draftPost };
