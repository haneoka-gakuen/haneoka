type RecordValue = Record<string, unknown>;

export function storySourceUrl(value: string, server: string): string {
  return /^(?:Assets|Packages)\//u.test(value)
    ? `/assets/${encodeURIComponent(server)}/${value.split("/").map(encodeURIComponent).join("/")}`
    : value;
}

export function resolveStoryRuntimeAssets(runtime: RecordValue, server: string): RecordValue {
  const chat = runtime.chatAssets as RecordValue | undefined;
  if (!chat) return runtime;
  return {
    ...runtime,
    chatAssets: {
      ...chat,
      iconImagesByAsset: Object.fromEntries(
        Object.entries((chat.iconImagesByAsset as RecordValue) || {}).map(([key, value]) => [
          key,
          storySourceUrl(String(value || ""), server),
        ]),
      ),
    },
  };
}
