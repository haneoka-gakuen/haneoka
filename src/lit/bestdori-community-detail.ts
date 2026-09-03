import { html, nothing, type TemplateResult } from "lit";
import { localizedText } from "./shared/catalog";
type Value = Record<string, unknown>;
export interface BestdoriDetailState {
  locale: string;
  routeKind: string;
  busy: boolean;
  card: Value | null;
  detail: Value | null;
  view: "text" | "player";
  providerBase: string;
  label(key: string, fallback: string): string;
}
export interface BestdoriDetailActions {
  closeCard(): void;
  closeDetail(): void;
  openStory(id: string, title?: unknown): void;
  playSong(song: Value): void;
  setView(view: "text" | "player"): void;
}
const icon = (name: string, size = 20) => html`
  <svg class="material-icon" width=${size} height=${size}><use href=${`/icons.svg#${name}`}></use></svg>
`;
const storyLines = (story: Value, locale: string) => {
  const result: Value[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Value;
    if (localizedText(record.text, locale)) result.push(record);
    for (const [key, nested] of Object.entries(record)) if (key !== "text" && key !== "targets") walk(nested);
  };
  walk(story.commands);
  return result;
};
export function renderBestdoriDetail(
  state: BestdoriDetailState,
  actions: BestdoriDetailActions,
): TemplateResult | typeof nothing {
  const { locale, label } = state;
  if (state.card && !state.detail) {
    const card = state.card,
      title = localizedText(card.prefix, locale) || String(card.cardId || "—");
    const images = card.cardImages as Value | undefined;
    const episodes = Array.isArray(card.episodes) ? (card.episodes as Value[]) : [];
    return html`
      <aside class="bestdori-detail">
        <header>
          <button class="icon-button" aria-label=${label("close", "Close")} @click=${actions.closeCard}>
            ${icon("arrow_back")}
          </button>
          <strong>${title}</strong>
        </header>
        <div class="bestdori-card-detail">
          <div class="bestdori-card-detail__images">
            ${[images?.normal || card.cardImage, images?.trained].filter(Boolean).map(
              (source) => html`
                <img src=${String(source)} alt="" />
              `,
            )}
          </div>
          <h2>${label("storiesBestDori", "Stories")}</h2>
          ${episodes.map((episode, index) => {
            const storyId = `card.${episode.resourceSetName || card.resourceSetName}.${episode.scenarioId}`;
            return html`
              <button
                class="surface surface--outlined bestdori-episode"
                @click=${() => actions.openStory(storyId, episode.title)}
              >
                <span>${String(index + 1).padStart(2, "0")}</span>
                <strong>${localizedText(episode.title, locale) || String(episode.scenarioId || storyId)}</strong>
                ${icon("chevron_right")}
              </button>
            `;
          })}
        </div>
      </aside>
    `;
  }
  const detail = state.detail;
  if (!detail)
    return state.busy
      ? html`
          <div class="bestdori-detail-loading"><md-circular-progress indeterminate></md-circular-progress></div>
        `
      : nothing;
  if (state.routeKind === "bestdori-songs") {
    const title = localizedText(detail.musicTitle || detail.title, locale) || String(detail.musicId || "—");
    const difficulties = Array.isArray(detail.difficulty) ? (detail.difficulty as Value[]) : [];
    const comboGroups =
      detail.comboRewards && typeof detail.comboRewards === "object"
        ? Object.entries(detail.comboRewards as Value)
        : [];
    const reward = (item: Value) => {
      const resolved = (item.resolved as Value | undefined) || {};
      return html`
        <span>
          ${
            resolved.image
              ? html`
                  <img src=${String(resolved.image)} alt="" />
                `
              : icon("redeem", 18)
          }
          <small>
            ${localizedText(resolved.name || item.resourceTypeName, locale) || String(item.resourceType || "")}
          </small>
          <strong>×${Number(item.resourceCount || 0).toLocaleString(locale)}</strong>
        </span>
      `;
    };
    return html`
      <aside class="bestdori-detail">
        <header>
          <button class="icon-button" aria-label=${label("close", "Close")} @click=${actions.closeDetail}>
            ${icon("arrow_back")}
          </button>
          <strong>${title}</strong>
          ${
            detail.musicUrl
              ? html`
                  <button
                    class="icon-button"
                    aria-label=${label("play", "Play")}
                    @click=${() => actions.playSong(detail)}
                  >
                    ${icon("play_arrow")}
                  </button>
                `
              : nothing
          }
        </header>
        <div class="bestdori-song-detail">
          <img src=${String(detail.jacketUrl || detail.jacketThumbUrl || "")} alt="" />
          <dl>
            <div>
              <dt>${label("composer", "Composer")}</dt>
              <dd>${localizedText(detail.composer, locale) || "—"}</dd>
            </div>
            <div>
              <dt>${label("lyricist", "Lyrics")}</dt>
              <dd>${localizedText(detail.lyricist, locale) || "—"}</dd>
            </div>
            <div>
              <dt>${label("arranger", "Arrangement")}</dt>
              <dd>${localizedText(detail.arranger, locale) || "—"}</dd>
            </div>
          </dl>
          <div class="bestdori-difficulties">
            ${difficulties.map(
              (difficulty) => html`
                <span>
                  <small>${String(difficulty.difficultyName || difficulty.difficulty || "")}</small>
                  <strong>${String(difficulty.playLevel || difficulty.displayLevel || difficulty.level || "—")}</strong>
                </span>
              `,
            )}
          </div>
          <section class="bestdori-rewards">
            <h2>${label("rewards", "Rewards")}</h2>
            <div>${(Array.isArray(detail.scoreRewards) ? (detail.scoreRewards as Value[]) : []).map(reward)}</div>
            ${comboGroups.map(
              ([difficulty, items]) => html`
                <h3>${difficulty}</h3>
                <div>${(Array.isArray(items) ? (items as Value[]) : []).map(reward)}</div>
              `,
            )}
          </section>
        </div>
      </aside>
    `;
  }
  const lines = storyLines(detail, locale);
  const title = localizedText(detail.title || detail.chapterName, locale) || String(detail.storyId || "Story");
  return html`
    <aside class="bestdori-detail bestdori-story-detail">
      <header>
        <button class="icon-button" aria-label=${label("close", "Close")} @click=${actions.closeDetail}>
          ${icon("arrow_back")}
        </button>
        <strong>${title}</strong>
        <nav class="segmented">
          <button aria-pressed=${state.view === "text"} @click=${() => actions.setView("text")}>
            ${label("storyText", "Text")}
          </button>
          <button
            aria-pressed=${state.view === "player"}
            @click=${async () => {
              await Promise.all([import("./runtime/vega-story-stage"), import("../styles/story.css")]);
              actions.setView("player");
            }}
          >
            ${label("player", "Player")}
          </button>
        </nav>
      </header>
      ${
        state.view === "player"
          ? html`
              <vega-story-stage
                .story=${detail}
                locale=${locale}
                provider-base=${state.providerBase}
              ></vega-story-stage>
            `
          : html`
              <div class="bestdori-transcript">
                ${lines.map((line) => {
                  const target = Array.isArray(line.targets) ? (line.targets[0] as Value | undefined) : undefined;
                  const targetName = Array.isArray(line.targetTextNames) ? line.targetTextNames[0] : undefined;
                  const speaker = localizedText(
                    line.speakerName || line.characterName || target?.name || targetName,
                    locale,
                  );
                  return html`
                    <article>
                      ${
                        speaker
                          ? html`
                              <strong>${speaker}</strong>
                            `
                          : nothing
                      }
                      <p>${localizedText(line.text, locale)}</p>
                    </article>
                  `;
                })}
              </div>
            `
      }
    </aside>
  `;
}
