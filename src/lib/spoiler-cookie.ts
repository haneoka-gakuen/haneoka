export const SPOILER_COOKIE = "haneoka.spoilers";

export function spoilerCookieEnabled(cookie: string | null): boolean {
  return !(cookie || "").split(";").some((part) => part.trim() === `${SPOILER_COOKIE}=0`);
}
