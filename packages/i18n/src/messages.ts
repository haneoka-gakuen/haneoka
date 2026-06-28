import { uiLocaleFallbacks, type Locale } from "./locales.js";

export type MessageList = readonly MessageNode[];
export interface MessageTree {
  readonly [key: string]: MessageNode;
}
export type MessageNode = string | MessageTree | MessageList;
export type MessageCatalog = MessageTree;
export type MessageCatalogs = Partial<Record<Locale, MessageCatalog>>;
export type MessageParams = Readonly<Record<string, string | number>> | ReadonlyArray<string | number>;

export type TranslationShape<Value> = Value extends string
  ? string
  : Value extends readonly (infer Item)[]
    ? ReadonlyArray<TranslationShape<Item>>
    : Value extends Readonly<Record<string, unknown>>
      ? { readonly [Key in keyof Value]: TranslationShape<Value[Key]> }
      : never;

export type MessagePath<Value> = {
  [Key in keyof Value & string]: Value[Key] extends string
    ? Key
    : Value[Key] extends readonly unknown[]
      ? never
      : Value[Key] extends Readonly<Record<string, unknown>>
        ? `${Key}.${MessagePath<Value[Key]>}`
        : never;
}[keyof Value & string];

export type MessageGroupKey<Value> = {
  [Key in keyof Value & string]: Value[Key] extends Readonly<Record<string, unknown>> ? Key : never;
}[keyof Value & string];

const isMessageTree = (value: unknown): value is MessageTree =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMessageNode = (value: unknown): value is MessageNode => {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(isMessageNode);
  return isMessageTree(value) && Object.values(value).every(isMessageNode);
};

export const isMessageCatalog = (value: unknown): value is MessageCatalog =>
  isMessageTree(value) && Object.values(value).every(isMessageNode);

export const messageNodeAtPath = (catalog: MessageCatalog | undefined, path: string): MessageNode | undefined => {
  let value: MessageNode | undefined = catalog;
  for (const segment of path.split(".")) {
    if (!isMessageTree(value)) return undefined;
    value = value[segment];
  }
  return value;
};

export const messageAtPath = (catalog: MessageCatalog | undefined, path: string): string | undefined => {
  const value = messageNodeAtPath(catalog, path);
  return typeof value === "string" ? value : undefined;
};

export const interpolateMessage = (message: string, params?: MessageParams): string => {
  if (!params) return message;
  return message.replace(/\{([^{}]+)\}/gu, (placeholder, key: string) => {
    const value = Array.isArray(params)
      ? params[Number.parseInt(key, 10)]
      : (params as Readonly<Record<string, string | number>>)[key];
    return value === undefined ? placeholder : String(value);
  });
};

/** Resolve requested UI copy, then Japanese, and finally expose the key. */
export const resolveUiMessage = (
  catalogs: MessageCatalogs,
  requested: Locale,
  key: string,
  params?: MessageParams,
): string => {
  for (const locale of uiLocaleFallbacks(requested)) {
    const message = messageAtPath(catalogs[locale], key);
    if (message !== undefined) return interpolateMessage(message, params);
  }
  return key;
};

const mergeMessageNodes = (
  fallback: MessageNode | undefined,
  preferred: MessageNode | undefined,
): MessageNode | undefined => {
  if (preferred === undefined) return fallback;
  if (!isMessageTree(fallback) || !isMessageTree(preferred)) return preferred;

  const merged: Record<string, MessageNode> = { ...fallback };
  for (const key of Object.keys(preferred)) {
    const value = mergeMessageNodes(fallback[key], preferred[key]);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
};

/** Resolve a message subtree while retaining Japanese values for missing leaves. */
export const resolveUiMessageNode = (
  catalogs: MessageCatalogs,
  requested: Locale,
  path: string,
): MessageNode | undefined => {
  const [first, second] = uiLocaleFallbacks(requested);
  const preferred = messageNodeAtPath(first ? catalogs[first] : undefined, path);
  const fallback = second ? messageNodeAtPath(catalogs[second], path) : undefined;
  return mergeMessageNodes(fallback, preferred);
};
