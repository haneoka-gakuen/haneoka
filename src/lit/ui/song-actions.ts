// L3 — GEB
// Input: 歌曲／社区谱面播放、谱面页、GBP 编辑器与 Sonolus 入口。
// Output: 共用详情图标、编辑器导入和谱面页下载／视图切换控件。
// Pos: [Map](L2-2.md)；歌曲媒体入口模板。
// Effects/Dependencies: Lit 模板与已有共享样式；行为由调用者持有。
import { html, nothing } from "lit";
import { clientText } from "../../i18n/client";
import { segmented } from "./controls";
import { icon } from "./icon";

function editChartAction(locale: string, href?: string) {
  const label = clientText(locale, "editors.chart.importGbp");
  return href ? html`<a class="icon-button" href=${href} aria-label=${label} title=${label}>${icon("edit")}</a>` : nothing;
}

export function songDetailActions(options: {
  locale: string;
  leading?: unknown;
  onPlay?: () => void;
  onChart?: () => void;
  sonolus?: string;
  editor?: string;
}) {
  const t = (key: string) => clientText(options.locale, key);
  return html`
    <span class="detail-header-actions">
      ${options.leading ?? nothing}
      ${editChartAction(options.locale, options.editor)}
      ${
        options.onPlay
          ? html`
              <button class="icon-button" @click=${options.onPlay} aria-label=${t("common.actions.play")}>
                <svg class="material-icon" width="21" height="21"><use href="/icons.svg#play_arrow"></use></svg>
              </button>
            `
          : nothing
      }
      ${
        options.onChart
          ? html`
              <button class="icon-button" @click=${options.onChart} aria-label=${t("navigation.chart")}>
                <svg class="material-icon" width="21" height="21"><use href="/icons.svg#sports_esports"></use></svg>
              </button>
            `
          : nothing
      }
      ${
        options.sonolus
          ? html`
              <a
                class="icon-button"
                href=${options.sonolus}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Sonolus"
              >
                <img class="sonolus-icon" src="/images/sonolus-icon.png" alt="" />
              </a>
            `
          : nothing
      }
    </span>
  `;
}

export function chartPageActions(options: {
  locale: string;
  mode: "simple" | "watch";
  onMode: (mode: "simple" | "watch") => void;
  onDownload: () => void;
  editor?: string;
}) {
  const t = (key: string) => clientText(options.locale, key);
  return html`
    ${editChartAction(options.locale, options.editor)}
    <button
      class="icon-button"
      @click=${options.onDownload}
      aria-label=${t("common.actions.downloadChart")}
      title=${t("common.actions.downloadChart")}
    >
      <svg class="material-icon" width="20" height="20"><use href="/icons.svg#download"></use></svg>
    </button>
    ${segmented({
      label: t("common.actions.view"),
      appBarSwitch: "view",
      value: options.mode,
      iconOnly: true,
      options: [
        { value: "simple" as const, label: t("common.layout.simple"), icon: "view_week" },
        { value: "watch" as const, label: t("common.actions.watch"), icon: "play_circle" },
      ],
      onSelect: options.onMode,
    })}
  `;
}
