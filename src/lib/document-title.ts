export const withoutSiteSuffix = (title: string): string =>
  title.replace(/(?:^|\s*[-·/|]\s*)haneoka(?:\s*-\s*BanG Dream! Our Notes.*)?$/u, "").trim();

export function formatDocumentTitle(title: string, siteTitle: string): string {
  const name = withoutSiteSuffix(title).replace(/\s*\/\s*/gu, " - ");
  return `${name && name !== "haneoka" ? `${name} - ` : ""}haneoka - ${siteTitle}`;
}
