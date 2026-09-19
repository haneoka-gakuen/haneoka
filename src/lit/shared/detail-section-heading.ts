import { html, nothing, type TemplateResult } from "lit";

const DETAIL_SECTION_ICONS = {
  details: "info",
  stats: "monitoring",
  characters: "group",
  content: "description",
  skills: "bolt",
  effects: "trending_up",
  difficulty: "bar_chart",
  media: "videocam",
  diary: "menu_book",
  rewards: "emoji_events",
  cards: "photo_library",
  memberCards: "person",
  supportCards: "photo_library",
  stamps: "sticky_note_2",
  stories: "auto_stories",
  storyText: "article",
  voices: "mic",
  friendships: "handshake",
  missions: "checklist",
  live2d: "accessibility_new",
  songs: "music_note",
  comments: "comment",
  works: "bar_chart",
  accounts: "account_circle",
} as const;

export type DetailSectionKind = keyof typeof DETAIL_SECTION_ICONS;

export interface DetailSectionHeadingOptions {
  count?: number | string;
  level?: 2 | 3;
  className?: string;
}

export function renderDetailSectionHeading(
  label: unknown,
  kind: DetailSectionKind,
  options: DetailSectionHeadingOptions = {},
): TemplateResult {
  const level = options.level || 3;
  const content = html`
    <span class="detail-section-title__icon" aria-hidden="true">
      <svg class="material-icon" width="18" height="18">
        <use href=${`/icons.svg#${DETAIL_SECTION_ICONS[kind]}`}></use>
      </svg>
    </span>
    <span class="detail-section-title__label">${label}</span>
    ${
      options.count === undefined
        ? nothing
        : html`
            <small class="detail-section-title__count">${options.count}</small>
          `
    }
  `;
  const className = `detail-section-title detail-section-title--h${level}${options.className ? ` ${options.className}` : ""}`;
  return level === 2
    ? html`
        <h2 class=${className}>${content}</h2>
      `
    : html`
        <h3 class=${className}>${content}</h3>
      `;
}
