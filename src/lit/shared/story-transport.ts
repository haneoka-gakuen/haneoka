// L3 — GEB
// Input: A story player's playback state, localized control names and actions.
// Output: The same playback footer in the site and the hosted story embed.
// Pos: [Map](../L2-2.md)；故事播放器的共享操作栏。
// Effects/Dependencies: Lit markup and the Material slider.
import { html, nothing } from "lit";

export interface StoryTransportOptions {
  readonly visible: boolean;
  readonly collapsed: boolean;
  readonly started: boolean;
  readonly completed: boolean;
  readonly auto: boolean;
  readonly fullscreen: boolean;
  readonly ordinal: number;
  readonly maximum: number;
  readonly labels: {
    controls: string; play: string; replay: string; auto: string; progress: string;
    fullscreen: string; fullscreenExit: string; collapse: string;
  };
  readonly iconHref?: (name: string) => string;
  readonly onPlay: () => void;
  readonly onPreviewSeek: (value: number) => void;
  readonly onSeek: (value: number) => void;
  readonly onFullscreen: () => void;
  readonly onCollapse: () => void;
}

export function renderStoryTransport(options: StoryTransportOptions) {
  const { visible, collapsed, started, completed, auto, fullscreen, ordinal, maximum, labels } = options;
  const icon = options.iconHref ?? ((name: string) => `/icons.svg#${name}`);
  const play = completed ? labels.replay : started ? labels.auto : labels.play;
  const fullscreenLabel = fullscreen ? labels.fullscreenExit : labels.fullscreen;
  const value = (event: Event) => Number((event.target as HTMLElement & { value?: number }).value);
  return html`
    <footer class="chart-runtime__controls playback-controls" ?hidden=${!visible || collapsed}
      data-collapsed=${String(collapsed)} aria-label=${labels.controls}>
      <div class="playback-controls__expanded" ?inert=${collapsed} aria-hidden=${collapsed}>
        <button class="icon-button" type="button" aria-pressed=${started && !completed ? auto : nothing}
          aria-label=${play} .title=${play} @click=${options.onPlay}>
          <svg class="material-icon" width="24" height="24">
            <use href=${icon(completed ? "replay" : auto ? "pause" : "play_arrow")}></use>
          </svg>
        </button>
        <div class="chart-runtime__timeline">
          <small>${ordinal}</small>
          <md-slider class="md3-slider md3-slider--runtime" min="0" max=${maximum || 1} step="1"
            .value=${ordinal} aria-label=${labels.progress} aria-valuetext=${`${ordinal} / ${maximum}`}
            ?disabled=${maximum < 1}
            @input=${(event: Event) => options.onPreviewSeek(value(event))}
            @change=${(event: Event) => options.onSeek(value(event))}></md-slider>
          <small>${maximum}</small>
        </div>
        <div class="chart-runtime__actions">
          <button class="icon-button" type="button" aria-pressed=${fullscreen} aria-label=${fullscreenLabel}
            title=${fullscreenLabel} @click=${options.onFullscreen}>
            <svg class="material-icon" width="20" height="20">
              <use href=${icon(fullscreen ? "fullscreen_exit" : "fullscreen")}></use>
            </svg>
          </button>
          <button class="icon-button" type="button" @click=${options.onCollapse} aria-label=${labels.collapse}>
            <svg class="material-icon" width="20" height="20"><use href=${icon("expand_more")}></use></svg>
          </button>
        </div>
      </div>
    </footer>
  `;
}
