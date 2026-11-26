// L3 — GEB
// Input: A server's published dialogue index and a user-entered query.
// Output: Matching lines with neighbouring context and available speaker labels.
// Pos: [Map](../L2.md); cross-episode search runs in a dedicated browser Worker.
// Effects/Dependencies: Fetches a same-origin static index; regex runs off the main thread.
import type { DialogueHit, DialogueIndex, DialogueQuery, DialogueReply, DialogueText } from "../lib/story-dialogue";
import { normalizeSearchText } from "../lib/search-text";
import { localizedFallbacks } from "../lib/localized-text";

let index: Promise<DialogueIndex> | undefined;

function preferred(values: DialogueText, locales: string[]): [string, string] {
  for (const locale of locales) if (values[locale]) return [locale, values[locale]];
  return Object.entries(values)[0] ?? ["und", ""];
}

async function search(server: string, request: DialogueQuery): Promise<DialogueReply> {
  const { locale, category, speaker, query, mode } = request;
  const locales = localizedFallbacks(locale);
  let scoreOf: (text: string) => number;
  let terms: string[] | undefined;
  if (mode === "regex") {
    try {
      const pattern = new RegExp(query, "iu");
      scoreOf = (value) => Number(pattern.test(value));
    } catch {
      return { phase: "invalid" };
    }
  } else {
    const needle = normalizeSearchText(query);
    if (mode === "semantic") {
      if (request.terms) terms = request.terms;
      else {
        const response = await fetch("/api/v1/story-dialogue/expand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query }),
        });
        if (!response.ok) throw new Error(`story-dialogue-expansion:${response.status}`);
        ({ terms } = await response.json() as { terms: string[] });
      }
    }
    const expanded = [...new Set((terms ?? []).map((term) => normalizeSearchText(term)))].filter((term) => term.length >= 2 && term !== needle);
    scoreOf = (value) => {
      const text = normalizeSearchText(value);
      if (needle && text.includes(needle)) return mode === "semantic" ? Number.MAX_SAFE_INTEGER : 1;
      return expanded.reduce((score, term) => score + (text.includes(term) ? term.length : 0), 0);
    };
  }
  index ??= fetch(`/data/story-dialogue/${server}.json`).then((response) => {
    if (!response.ok) throw new Error(`story-dialogue:${response.status}`);
    return response.json() as Promise<DialogueIndex>;
  });
  const episodes = await index;
  postMessage({ phase: "index-ready" });
  const speakers = new Set<string>();
  const results: Array<{ score: number; hit: DialogueHit }> = [];
  for (const [id, kind, title, lines] of episodes) {
    if (category && category !== kind) continue;
    const name = preferred(title, locales)[1] || id;
    for (const [lineIndex, [command, names, texts, kind = "dialogue", voices = [], portraits = []]] of lines.entries()) {
      const person = preferred(names, locales)[1];
      if (person) speakers.add(person);
      if (speaker && speaker !== person) continue;
      const [language, text] = preferred(texts, locales);
      let score = scoreOf(text), matchedLocale = language, matchedText = text;
      if (!score || mode === "semantic") {
        for (const [variant, value] of Object.entries(texts)) {
          if (variant === language) continue;
          const candidate = scoreOf(value);
          if (candidate > score) {
            score = candidate;
            matchedLocale = variant;
            matchedText = value;
            if (mode !== "semantic") break;
          }
        }
      }
      if (!score) continue;
      const context = (offset: number) => preferred(lines[lineIndex + offset]?.[2] ?? {}, locales)[1];
      results.push({ score, hit: {
        id, index: lineIndex, command, title: name, speaker: person, text, textLanguage: language, kind, voices,
        avatars: portraits.map((src) => ({ src, name: person })),
        contextBefore: context(-1), contextAfter: context(1),
        ...(matchedLocale !== language ? { matchedText, matchedLocale } : {}),
      } });
    }
  }
  if (mode === "semantic") results.sort((left, right) => right.score - left.score);
  return { phase: "ready", results: results.map(({ hit }) => hit), speakers: [...speakers].sort(new Intl.Collator(locale).compare), terms };
}

self.addEventListener("message", async ({ data }: MessageEvent<{ server: string; request: DialogueQuery }>) => {
  try {
    postMessage(await search(data.server, data.request));
  } catch {
    index = undefined;
    postMessage({ phase: "error" } satisfies DialogueReply);
  }
});
