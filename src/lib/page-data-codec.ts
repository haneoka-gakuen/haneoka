// L3 — GEB
// Input: Page payloads with repeated JSON subtrees.
// Output: Compact serialized data and independently restored values.
// Pos: [Map](L2-2.md); shared page payload codec for SSR, browsers and Worker responses.
// Effects/Dependencies: Pure JSON transformation with HTML-safe serialization.
/**
 * Page payloads repeat large subtrees (a cross-server row is also its active
 * and ownership variant). Each repeated subtree of at least SHARED_MIN bytes is
 * written once and referenced; readPageData restores an independent copy per
 * reference, so readers see exactly the JSON the producer serialised.
 */
const SHARED_MIN = 1024;
const WRAPPER = "\u0000page-data";
const REFERENCE = "\u0000";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function encodePageData(value: unknown): string {
  const text = new Map<object, string>();
  const counts = new Map<string, number>();
  const normal = (input: unknown): unknown =>
    input && typeof input === "object" && typeof (input as { toJSON?: unknown }).toJSON === "function"
      ? (input as { toJSON(): unknown }).toJSON()
      : input;
  const measure = (input: unknown, inArray: boolean): string | undefined => {
    const node = normal(input);
    if (node === null || typeof node !== "object") {
      const primitive = JSON.stringify(node) as string | undefined;
      return primitive === undefined && inArray ? "null" : primitive;
    }
    let json = text.get(node);
    if (json === undefined) {
      if (Array.isArray(node)) json = `[${node.map((item) => measure(item, true)).join(",")}]`;
      else {
        const fields: string[] = [];
        for (const key of Object.keys(node)) {
          const field = measure((node as Record<string, unknown>)[key], false);
          if (field !== undefined) fields.push(`${JSON.stringify(key)}:${field}`);
        }
        json = `{${fields.join(",")}}`;
      }
      text.set(node, json);
    }
    if (json.length >= SHARED_MIN) counts.set(json, (counts.get(json) ?? 0) + 1);
    return json;
  };
  const plain = measure(value, false);
  if (plain === undefined || ![...counts.values()].some((count) => count > 1)) return plain ?? "";
  const shared: string[] = [];
  const indices = new Map<string, number>();
  const emit = (input: unknown, inArray: boolean): string | undefined => {
    const node = normal(input);
    if (node === null || typeof node !== "object") {
      const primitive = JSON.stringify(node) as string | undefined;
      return primitive === undefined && inArray ? "null" : primitive;
    }
    const json = text.get(node)!;
    if ((counts.get(json) ?? 0) < 2) return body(node);
    let index = indices.get(json);
    if (index === undefined) {
      index = shared.length;
      indices.set(json, index);
      shared.push("");
      shared[index] = body(node);
    }
    return `{${JSON.stringify(REFERENCE)}:${index}}`;
  };
  const body = (node: object): string => {
    if (Array.isArray(node)) return `[${node.map((item) => emit(item, true)).join(",")}]`;
    const fields: string[] = [];
    for (const key of Object.keys(node)) {
      const field = emit((node as Record<string, unknown>)[key], false);
      if (field !== undefined) fields.push(`${JSON.stringify(key)}:${field}`);
    }
    return `{${fields.join(",")}}`;
  };
  const root = emit(value, false)!;
  return `{${JSON.stringify(WRAPPER)}:[${shared.join(",")}],"value":${root}}`;
}

export function decodePageData(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const shared = (data as Record<string, unknown>)[WRAPPER];
  if (!Array.isArray(shared) || Object.keys(data).length !== 2 || !("value" in data)) return data;
  const templates = new Map<number, Json>();
  const resolve = (index: number): Json => {
    let template = templates.get(index);
    if (template === undefined) {
      template = walk(shared[index] as Json);
      templates.set(index, template);
    }
    return structuredClone(template);
  };
  const walk = (node: Json): Json => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) node[index] = walk(node[index]!);
      return node;
    }
    const keys = Object.keys(node);
    if (keys.length === 1 && keys[0] === REFERENCE && typeof node[REFERENCE] === "number")
      return resolve(node[REFERENCE]);
    for (const key of keys) node[key] = walk(node[key]!);
    return node;
  };
  return walk((data as { value: Json }).value);
}

export function serializePageData(value: unknown): string {
  return encodePageData(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}
