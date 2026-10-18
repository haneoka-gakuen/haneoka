import { LitElement, html, type PropertyValues } from "lit";
import { initializeI18nClient } from "../../i18n/client";
import { isLocale } from "../../i18n/locales";
import type { Catalog } from "@haneoka/i18n";
import {
  observeRenderQuality,
  readRenderQuality,
  writeRenderQuality,
  type RenderQuality,
} from "../../lib/render-quality";
import "../../styles/components/render-quality.css";

export class RenderQualitySettings extends LitElement {
  static properties = {
    locale: { type: String },
    settings: { state: true },
    catalog: { state: true },
  };
  declare locale: string;
  declare settings: RenderQuality;
  private stopObserving?: () => void;
  declare private catalog: Catalog;
  private catalogRequest?: AbortController;

  constructor() {
    super();
    this.catalog = initializeI18nClient().current();
    this.locale = "en";
    this.settings = readRenderQuality();
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
        <label class="render-quality-settings__row">
          <span>${this.text("resolution")}</span>
          <select
            aria-label=${this.text("resolution")}
            @change=${(event: Event) =>
              writeRenderQuality({
                ...this.settings,
                factor: Number((event.currentTarget as HTMLSelectElement).value) as RenderQuality["factor"],
              })}
          >
            <option value="1" ?selected=${this.settings.factor === 1}>${this.text("native")}</option>
            <option value="1.3" ?selected=${this.settings.factor === 1.3}>${this.text("quality")} (1.3×)</option>
            <option value="1.5" ?selected=${this.settings.factor === 1.5}>${this.text("balanced")} (1.5×)</option>
          </select>
        </label>
        <label class="render-quality-settings__row render-quality-settings__row--slider">
          <span>${this.text("sharpness")}</span>
          <output>${Math.round(this.settings.sharpness * 100)}%</output>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            aria-label=${this.text("sharpness")}
            .value=${String(this.settings.sharpness)}
            ?disabled=${this.settings.factor === 1}
            @input=${(event: Event) =>
              writeRenderQuality({
                ...this.settings,
                sharpness: Number((event.currentTarget as HTMLInputElement).value),
              })}
          />
        </label>
      </section>
    `;
  }
}

customElements.define("render-quality-settings", RenderQualitySettings);
