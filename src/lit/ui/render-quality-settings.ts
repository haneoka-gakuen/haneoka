// L3 — GEB
// Input: 当前语言、画面偏好与故事设置可见性。
// Output: 共用分辨率、锐度和故事帧率选择器。
// Pos: [Map](L2-2.md)；播放器设置中的共享画面控件。
// Effects/Dependencies: 订阅本地偏好，加载消息并即时保存选择。
import { LitElement, html, nothing, type PropertyValues } from "lit";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import { initializeI18nClient } from "../../i18n/client";
import { isLocale } from "../../i18n/locales";
import type { Catalog } from "@haneoka/i18n";
import {
  observeRenderQuality,
  readRenderQuality,
  writeRenderQuality,
  STORY_FRAME_RATE_LIMITS,
  type RenderQuality,
} from "../../lib/render-quality";
import "../../styles/components/render-quality.css";

export class RenderQualitySettings extends LitElement {
  static properties = {
    locale: { type: String },
    settings: { state: true },
    catalog: { state: true },
    story: { type: Boolean },
  };
  declare locale: string;
  declare settings: RenderQuality;
  declare story: boolean;
  private stopObserving?: () => void;
  declare private catalog: Catalog;
  private catalogRequest?: AbortController;

  constructor() {
    super();
    this.catalog = initializeI18nClient().current();
    this.locale = "en";
    this.settings = readRenderQuality();
    this.story = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.stopObserving = observeRenderQuality((settings) => {
      this.settings = settings;
    });
  }

  disconnectedCallback() {
    this.stopObserving?.();
    this.catalogRequest?.abort();
    super.disconnectedCallback();
  }

  protected willUpdate(changed: PropertyValues) {
    if (!changed.has("locale")) return;
    this.catalogRequest?.abort();
    const locale = isLocale(this.locale) ? this.locale : "en";
    const client = initializeI18nClient();
    if (client.current().locale === locale) {
      this.catalog = client.current();
      return;
    }
    const request = new AbortController();
    this.catalogRequest = request;
    void client
      .ensure(locale, ["media"], request.signal)
      .then((catalog) => {
        if (!request.signal.aborted) this.catalog = catalog;
      })
      .catch((error: unknown) => {
        if (!request.signal.aborted) console.error("[render-quality] locale loading failed", error);
      });
  }

  private text(key: string) {
    return this.catalog.text(`media.rendering.${key}`);
  }

  render() {
    return html`
      <section class="render-quality-settings">
        <h4>${this.text("title")}</h4>
        ${this.story ? html`
            <md-outlined-select
              menu-positioning="fixed"
              label=${this.text("frameRateLimit")}
              .value=${String(this.settings.storyFrameRateLimit)}
              @change=${(event: Event) => writeRenderQuality({
                ...this.settings,
                storyFrameRateLimit: Number((event.currentTarget as HTMLElement & { value: string }).value),
              })}
            >
              ${STORY_FRAME_RATE_LIMITS.map((limit) => html`
                <md-select-option value=${String(limit)} ?selected=${limit === this.settings.storyFrameRateLimit}>
                  <div slot="headline">${limit === 0 ? this.text("unlimited") : `${limit} FPS`}</div>
                </md-select-option>
              `)}
            </md-outlined-select>
        ` : nothing}
          <md-outlined-select
            menu-positioning="fixed"
            label=${this.text("resolution")}
            .value=${String(this.settings.factor)}
            @change=${(event: Event) =>
              writeRenderQuality({
                ...this.settings,
                factor: Number((event.currentTarget as HTMLElement & { value: string }).value) as RenderQuality["factor"],
              })}
          >
            <md-select-option value="1" ?selected=${this.settings.factor === 1}><div slot="headline">${this.text("native")}</div></md-select-option>
            <md-select-option value="1.3" ?selected=${this.settings.factor === 1.3}><div slot="headline">${this.text("quality")} (1.3×)</div></md-select-option>
            <md-select-option value="1.5" ?selected=${this.settings.factor === 1.5}><div slot="headline">${this.text("balanced")} (1.5×)</div></md-select-option>
          </md-outlined-select>
        <label class="render-quality-settings__row render-quality-settings__row--slider">
          <span>${this.text("sharpness")}</span>
          <output>${Math.round(this.settings.sharpness * 100)}%</output>
          <md-slider
            min="0"
            max="1"
            step="0.01"
            labeled
            aria-label=${this.text("sharpness")}
            .value=${this.settings.sharpness}
            .valueLabel=${`${Math.round(this.settings.sharpness * 100)}%`}
            ?disabled=${this.settings.factor === 1}
            @input=${(event: Event) =>
              writeRenderQuality({
                ...this.settings,
                sharpness: Number((event.currentTarget as HTMLElement & { value: number }).value),
              })}
          ></md-slider>
        </label>
      </section>
    `;
  }
}

customElements.define("render-quality-settings", RenderQualitySettings);
