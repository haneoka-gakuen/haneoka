export interface ForumNavigationGroup {
  id: string;
  names: Readonly<Record<string, string | undefined>>;
  sortOrder: number;
}
export interface VisibleForumNavigationRecord {
  id: string;
  slug: string;
  names: Readonly<Record<string, string | undefined>>;
  icon: string;
  sortOrder: number;
  enabled: boolean;
  capabilities: { canRead: boolean };
  groupId?: string | null;
  /** Optional real service metadata; absent forums share one directory group. */
  group?: ForumNavigationGroup | null;
}
export interface ForumNavigationSnapshot {
  forums: readonly VisibleForumNavigationRecord[];
  groups?: readonly ForumNavigationGroup[];
  activeForumId?: string | null;
}
export interface ForumNavigationPayload extends ForumNavigationSnapshot {
  groups: readonly ForumNavigationGroup[];
  locale: string;
  viewerId: string;
}
export interface ForumNavigationLink {
  id: string;
  href: string;
  title: string;
  language: string;
  icon: string;
  active: boolean;
}
export interface ProjectedForumNavigationGroup {
  id: string;
  title: string;
  language: string;
  order: number;
  links: ForumNavigationLink[];
}

function text(names: Readonly<Record<string, string | undefined>>, locale: string) {
  const resolved=resolveLocalizedText(names,locale);
  return resolved.text ? {title:resolved.text,language:resolved.lang} : null;
}

/** Projects only the caller's current ACL response; no I/O or private cache. */
export function projectForumNavigation(
  snapshot: ForumNavigationSnapshot,
  locale: string,
  fallbackGroupTitle: string,
  availableIcons: ReadonlySet<string>,
): ProjectedForumNavigationGroup[] {
  const groups = new Map<string, ProjectedForumNavigationGroup>();
  const sourceGroups = new Map((snapshot.groups ?? []).map(group => [group.id,group]));
  const seen = new Set<string>();
  const forums = [...snapshot.forums].sort((a,b) => a.sortOrder-b.sortOrder || a.id.localeCompare(b.id));
  for (const forum of forums) {
    if (!forum.enabled || forum.capabilities.canRead !== true || seen.has(forum.id)) continue;
    const name = text(forum.names, locale);
    if (!name || !forum.id || !forum.slug) continue;
    seen.add(forum.id);
    const sourceGroup = forum.group ?? (forum.groupId ? sourceGroups.get(forum.groupId) : undefined);
    const groupName = sourceGroup ? text(sourceGroup.names, locale) : null;
    const groupId = sourceGroup?.id || 'visible-forums';
    let group = groups.get(groupId);
    if (!group) {
      group = { id:groupId, title:groupName?.title || fallbackGroupTitle,
        language:groupName?.language || locale, order:sourceGroup?.sortOrder ?? 0, links:[] };
      groups.set(groupId,group);
    }
    group.links.push({ id:forum.id,
      href:'/'+encodeURIComponent(locale)+'/community/forums/'+encodeURIComponent(forum.slug)+'/',
      title:name.title,language:name.language,
      icon:availableIcons.has(forum.icon) ? forum.icon : 'forum',
      active:forum.id === snapshot.activeForumId });
  }
  return [...groups.values()].sort((a,b) => a.order-b.order || a.id.localeCompare(b.id));
}
import {resolveLocalizedText} from './localized-text';
