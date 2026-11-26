// L3 — GEB
// Input: A bounded, same-origin story search query.
// Output: Multilingual query phrases for searching published dialogue.
// Pos: [Map](L2.md); Workers AI adapter for opt-in dialogue query expansion.
// Effects/Dependencies: Uses the shared public API rate limiter and Workers AI; does not retain the query.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_BYTES = 2048;
const outputLanguages = ["ja", "en", "ko", "zh-CN", "zh-TW"];
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

async function readQuery(request: Request): Promise<string | undefined> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return;
  const reader = request.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let size = 0;
  let raw = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return;
      }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    const { query } = JSON.parse(raw + decoder.decode()) as { query?: unknown };
    return typeof query === "string" && query.trim().length > 0 && query.length <= 240 ? query.trim() : undefined;
  } catch {
    return;
  } finally {
    reader.releaseLock();
  }
}

export async function expandStoryDialogueQuery(request: Request, env: Pick<Env, "AI" | "GAME_API_RATE_LIMITER">): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return Response.json({ error: "origin" }, { status: 403, headers });
  const query = await readQuery(request);
  if (!query) return Response.json({ error: "query" }, { status: 400, headers });
  const { success } = await env.GAME_API_RATE_LIMITER.limit({ key: `story-search:${request.headers.get("cf-connecting-ip") || "local"}` });
  if (!success) return Response.json({ error: "rate_limit" }, { status: 429, headers });
  try {
    const answer = await env.AI.run(MODEL, {
      messages: [
        {
          role: "system",
          content: "Expand the search description into short phrases likely to occur in dialogue. Give two or three distinctive alternatives for each language key: ja is Japanese (kana and kanji), en English, ko Korean (Hangul), zh-CN Simplified Chinese (简体字), and zh-TW Traditional Chinese (繁體字). Use native writing systems without romanization. Prefer snippets characters would naturally say. Avoid generic filler and invented plot facts.",
        },
        { role: "user", content: query },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: Object.fromEntries(outputLanguages.map((locale) => [locale, {
            type: "array", items: { type: "string" }, minItems: 2, maxItems: 3,
          }])),
          required: outputLanguages,
        },
      },
      max_tokens: 480,
      temperature: 0.1,
    });
    const result = typeof answer === "object" && "response" in answer ? answer.response : answer;
    const payload = (typeof result === "string" ? JSON.parse(result) : result) as Record<string, unknown> | null;
    const terms = [...new Set(outputLanguages.flatMap((locale) => {
      const phrases = payload?.[locale];
      return Array.isArray(phrases) ? phrases.slice(0, 3)
        .flatMap((phrase) => typeof phrase === "string" ? [phrase.trim()] : []) : [];
    }).filter((term) => term.length >= 2 && term.length <= 48))];
    if (!terms.length) throw new TypeError("story_expansion_terms");
    return Response.json({ terms }, { headers });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers });
  }
}
