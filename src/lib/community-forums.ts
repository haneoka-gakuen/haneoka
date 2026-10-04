export type ForumLocale = "ja" | "en" | "zh-TW" | "zh-CN" | "ko";
export const FORUM_LOCALES: ForumLocale[] = ["ja", "en", "zh-TW", "zh-CN", "ko"];
export type ForumReadAudience = "public" | "member" | "verified" | "moderator" | "admin" | "none";
export type ForumWriteAudience = "verified" | "moderator" | "admin" | "none";
export interface ForumInput {
  slug: string;
  groupId: string | null;
  names: Partial<Record<ForumLocale, string>>;
  descriptions: Partial<Record<ForumLocale, string>>;
  icon: string;
  sortOrder: number;
  enabled: boolean;
  permissions: {
    read: ForumReadAudience;
    post: ForumWriteAudience;
    reply: ForumWriteAudience;
    manage: "moderator" | "admin";
  };
  defaultPurpose: "general" | "stamp" | null;
}
export interface CommunityForum extends ForumInput {
  id: string;
  defaultName: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  capabilities: { canRead: boolean; canPost: boolean; canReply: boolean; canManage: boolean };
  postCount?: number;
  latestPost?: { id: string; title: string; createdAt: number } | null;
}
export interface ForumGroup {
  id: string;
  slug: string;
  names: Partial<Record<ForumLocale, string>>;
  defaultName: string;
  sortOrder: number;
  version: number;
}
export interface CommunityTagFacet {
  id: string;
  normalizedName: string;
  displayName: string;
  aliases: string[];
  groupId: string | null;
  postCount: number;
}

/** Board artwork uses symbols shipped with this UI, including a visible fallback. */
export const FORUM_ICONS = [
  "forum",
  "chat",
  "style",
  "emoji_emotions",
  "music_note",
  "auto_stories",
  "groups",
  "menu_book",
  "help",
  "lightbulb",
  "flag",
] as const;
export function forumIcon(value: string): string {
  return (FORUM_ICONS as readonly string[]).includes(value) ? value : "forum";
}
