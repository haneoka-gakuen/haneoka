import { resolveLocalizedText } from "../lib/localized-text";
import "./ui/image-gallery";
import { renderPane } from "./ui/pane";
import { detailLayout } from "./ui/detail-layout";
import "../styles/bestdori-detail.css";
import { html, nothing, type TemplateResult } from "lit";
import { localizedText, uiText } from "./shared/catalog";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { loadingIndicator } from "./ui/loading-indicator";
type Value = Record<string, unknown>;
export interface BestdoriDetailState {
  locale: string;
  busy: boolean;
  card: Value | null;
  page: boolean;
  label(key: string, fallback: string): string;
}
export interface BestdoriDetailActions {
  closeCard(): void;
  storyHref(id: string): string;
}
const icon = (name: string, size = 20) => html`
  <svg class="material-icon" width=${size} height=${size}><use href=${`/icons.svg#${name}`}></use></svg>
`;
export function renderBestdoriDetail(
  state: BestdoriDetailState,
  actions: BestdoriDetailActions,
): TemplateResult | typeof nothing {
  const { locale, label } = state;
  if (state.card) {
    const card = state.card,
      title = localizedText(card.prefix, locale) || String(card.cardId || "—");
    const images = card.cardImages as Value | undefined;
    const episodes = Array.isArray(card.episodes) ? (card.episodes as Value[]) : [];
    const gallery = [
      {
        id: "normal",
        source: String(images?.normal || card.cardImage || ""),
        label: uiText(locale, "story.labels.illustration"),
      },
      { id: "trained", source: String(images?.trained || ""), label: uiText(locale, "catalog.cards.fields.training") },
    ].filter((image) => image.source);
    return renderPane({
      kind: "card",
      page: state.page,
      hideHeader: state.page,
      id: `gbp-card-${card.cardId}`,
      title,
      titleLanguage: resolveLocalizedText(card.prefix, locale).locale,
      open: true,
      backLabel: label("close", "Close"),
      onClose: actions.closeCard,
      body: detailLayout(
        gallery.length
          ? html`
              <image-gallery .images=${gallery} .locale=${locale} .title=${title}></image-gallery>
            `
          : nothing,
        html`
          <section class="detail-section">
            ${renderDetailSectionHeading(label("stories", "Stories"), "stories", { count: episodes.length, level: 2 })}
            ${
              state.busy
                ? html`
                    ${loadingIndicator({ label: label("loading", "Loading") })}
                  `
                : nothing
            }
            ${episodes.map((episode, index) => {
              const storyId = `card.${episode.resourceSetName || card.resourceSetName}.${episode.scenarioId}`;
              return html`
                <a class="surface surface--outlined bestdori-episode" href=${actions.storyHref(storyId)}>
                  <span>${String(index + 1).padStart(2, "0")}</span>
                  <strong lang=${resolveLocalizedText(episode.title, locale).locale}>
                    ${localizedText(episode.title, locale) || String(episode.scenarioId || storyId)}
                  </strong>
                  ${icon("chevron_right")}
                </a>
              `;
            })}
          </section>
        `,
      ),
    });
  }

  return nothing;
}
