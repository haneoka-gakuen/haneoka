const entities: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#34;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

export function parseHtmlJson<T = Record<string, unknown>>(value: string): T {
  return JSON.parse(value.replace(/&(?:amp|quot|apos|lt|gt|#34|#39);/gu, (entity) => entities[entity]!)) as T;
}
