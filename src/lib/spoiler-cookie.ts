export const SPOILER_COOKIE = "haneoka.spoilers";

export function spoilerCookieEnabled(cookie: string | null): boolean {
  return !(cookie || "").split(";").some((part) => part.trim() === `${SPOILER_COOKIE}=0`);
}

export function spoilerOverrideEnabled(url: URL): boolean {
  const value = Number(url.searchParams.get("spoiler"));
  return Number.isFinite(value) && value !== 0;
}
