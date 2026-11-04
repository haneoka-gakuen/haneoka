import { html, nothing } from "lit";
import { icon } from "../ui/icon";
import type { TileMark, TileOptions } from "../ui/tile";

type Episode = Record<string, unknown>;
export interface StoryTileOptions extends Omit<TileOptions, "kind" | "label" | "marks" | "placeholder"> {
  title: string;
  identityImage?: string;
  duration?: string;
}

/** The story catalog's tile construction, shared with linked event episodes. */
export function storyTile(
  episode: Episode,
  options: StoryTileOptions,
  extraMarks: ReadonlyArray<TileMark | null> = [],
): TileOptions {
  const { identityImage, duration, ...base } = options;
  return {
    ...base,
    kind: "story",
    label: options.title,
    aspectRatio: "16 / 9",
    adornment: identityImage
      ? html`
          <img
            src=${identityImage}
            alt=""
            width="16"
            height="16"
            loading="lazy"
            referrerpolicy=${base.referrerPolicy || nothing}
          />
        `
      : undefined,
    placeholder: icon("auto_stories", 32),
    marks: [
      episode.episodeNumber ? { at: "start", text: `#${String(episode.episodeNumber).padStart(2, "0")}` } : null,
      duration ? { at: "bottom-end", text: duration } : null,
      ...extraMarks,
    ],
  };
}
