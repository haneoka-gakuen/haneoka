import { renderWorkspace, useStaticLocale } from "./render-workspace";
import type { Locale } from "../i18n/locales";
import { publicForumDirectory } from "./public-forum-directory";
export { publicForumDirectory } from "./public-forum-directory";

export async function publicForumNavigation(locale: Locale, route: string) {
  const [data, { CommunityForumNavigation }] = await Promise.all([
    publicForumDirectory(),
    import("../lit/community-forum-navigation"),
  ]);
  useStaticLocale(locale, route);
  const navigation = new CommunityForumNavigation();
  navigation.preparePublicDirectory(data, locale, route);
  return { snapshot: data, body: renderWorkspace(navigation, locale, route) };
}
