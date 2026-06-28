export interface StoryCatalogSourceContext {
  readonly locale: string;
}

export interface StoryLive2dSourceContext extends StoryCatalogSourceContext {
  readonly story: Readonly<Record<string, unknown>>;
}

export interface StoryCatalogSourceAdapter {
  readonly id: string;
  readonly detailQuery?: (context: StoryCatalogSourceContext) => Readonly<Record<string, string>> | undefined;
  readonly live2dQuery?: (context: StoryLive2dSourceContext) => Readonly<Record<string, string>> | undefined;
}

const adapters = new Map<string, StoryCatalogSourceAdapter>();

export const registerStoryCatalogSource = (adapter: StoryCatalogSourceAdapter): void => {
  const id = String(adapter.id || "").trim();
  if (!id) throw new TypeError("Story catalog source id must not be empty");
  adapters.set(id, { ...adapter, id });
};

export const resolveStoryCatalogSource = (id: string | undefined): StoryCatalogSourceAdapter | undefined =>
  id ? adapters.get(id) : undefined;
