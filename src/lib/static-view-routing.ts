import { isReleaseServer, isCharacterDetailSection, parseResourceRoute, resourcePath } from "./resource-route.ts";
import { englishInterfacePath, interfaceLanguageFromPath, interfacePath } from "../i18n/interface-route.ts";
import { isLocale } from "@haneoka/i18n";

export { CHARACTER_DETAIL_SECTIONS } from "./resource-route.ts";

const validGroup = (value: string | null): value is string => !!value && /^[A-Za-z0-9_:-]+$/u.test(value);
export function missionGroupFromPath(pathname: string) {
  const [server, locale, kind, groups, encoded, ...extra] = englishInterfacePath(pathname).split("/").filter(Boolean);
  if (!isReleaseServer(server) || !isLocale(locale) || kind !== "missions" || groups !== "groups" || !encoded || extra.length)
    return undefined;
  try {
    const group = decodeURIComponent(encoded);
    if (validGroup(group)) return { server, locale, group };
  } catch { return undefined; }
  return undefined;
}

export function staticViewFromUrl(url: URL): string | undefined {
  const account = /^\/(ja|en|ko|zh-CN|zh-TW)\/account\/games\/?$/u.exec(englishInterfacePath(url.pathname));
  if (account) return `/${account[1]}/account/`;
  const mission = missionGroupFromPath(url.pathname);
  if (mission) return resourcePath({ ...mission, kind: "missions" });
  const route = parseResourceRoute(url.pathname);
  if (route?.kind === "characters" && route.id && route.section && route.section !== "profile")
    return `/static-views/${route.server}/${route.locale}/characters/${encodeURIComponent(route.id)}/${route.section}/`;
  if (route?.kind === "help" && route.id === "tips")
    return `/static-views/${route.server}/${route.locale}/help/tips/`;
  return undefined;
}

export function legacyStaticViewRedirectTarget(pathname: string, search: string): string | undefined {
  if (!search) return;
  const query = new URLSearchParams(search);
  if (/^\/[^/]+\/account\/?$/u.test(pathname) && query.get("section") === "games") {
    const locale = englishInterfacePath(pathname).split("/")[1];
    if (!isLocale(locale)) return;
    query.delete("section");
    return `${pathname.replace(/\/$/u, "")}/games/${query.size ? `?${query}` : ""}`;
  }
  const [server, locale, kind, id, ...extra] = englishInterfacePath(pathname).split("/").filter(Boolean);
  if (!isReleaseServer(server) || !isLocale(locale) || extra.length) return;
  let target: string;
  const section = query.get("section");
  if (kind === "characters" && id && isCharacterDetailSection(section)) {
    const route = parseResourceRoute(pathname);
    if (!route) return;
    target = resourcePath({ ...route, section });
    query.delete("section");
  } else if (kind === "help" && !id && query.get("mode") === "tips") {
    target = resourcePath({ server, locale, kind: "help", id: "tips" });
    query.delete("mode");
    query.delete("topic");
  } else if (kind === "missions" && !id) {
    const group = query.get("group");
    if (!validGroup(group)) return;
    target = `${resourcePath({ server, locale, kind: "missions" })}groups/${encodeURIComponent(group)}/`;
    query.delete("group");
  } else return;
  const language = interfaceLanguageFromPath(pathname);
  return (language ? interfacePath(target, language.value) : target) + (query.size ? `?${query}` : "");
}
