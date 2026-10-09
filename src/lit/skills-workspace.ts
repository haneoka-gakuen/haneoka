import { LitElement, html, nothing } from "lit";
import { clientText } from "../i18n/client";
import { localizedText } from "./shared/catalog";
import { resourcePath } from "../lib/resource-route";
import type { Locale } from "../i18n/locales";
import type { SkillCatalogPayload, SkillFamily } from "../server/skill-catalog";
import { upgradeCost } from "./ui/upgrade-cost";
import { renderLevelSwitch } from "./ui/level-switch";
import { filterChip } from "./ui/controls";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "../styles/card-detail.css";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  "all": "common.states.all",
  "awakening": "catalog.cards.fields.awakening",
  "cards": "navigation.cards",
  "effects": "catalog.fields.effects",
  "gekisouSkill": "catalog.cards.fields.gekisouSkill",
  "gekisouSupportSkill": "catalog.cards.fields.gekisouSupportSkill",
  "items": "navigation.items",
  "leaderSkill": "catalog.cards.fields.leaderSkill",
  "level": "common.fields.level",
  "liveSkill": "catalog.cards.fields.liveSkill",
  "rank": "catalog.cards.fields.rank",
  "required": "common.fields.required",
  "search": "common.actions.search",
  "skills": "catalog.cards.fields.skills",
  "supportSkill": "catalog.cards.fields.supportSkill",
  "type": "catalog.fields.type",
  "unavailable": "common.states.unavailable"
};


const familyLabels: Record<SkillFamily, string> = {
  leader: "leaderSkill",
  live: "liveSkill",
  gekisou: "gekisouSkill",
  support: "supportSkill",
  gekisouSupport: "gekisouSupportSkill",
};

export class SkillsWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    query: { state: true },
    family: { state: true },
    selected: { state: true },
    effect: { state: true },
    includeUnlinked: { state: true },
  };
  declare locale: string;
  declare private query: string;
  declare private family: string;
  declare private selected: string;
  declare private effect: string;
  declare private includeUnlinked: boolean;
  private data?: SkillCatalogPayload;
  private targets = new Map<string, number>();
  constructor() {
    super();
    this.locale = "en";
    this.query = "";
    this.family = "";
    this.selected = "";
    this.effect = "";
    this.includeUnlinked = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    const seed = this.querySelector<HTMLScriptElement>("script[data-skill-catalog]");
    if (seed?.textContent) this.data = JSON.parse(seed.textContent) as SkillCatalogPayload;
    this.replaceChildren();
    this.readLocation();
    addEventListener("popstate", this.readLocation);
  }
  disconnectedCallback() {
    removeEventListener("popstate", this.readLocation);
    super.disconnectedCallback();
  }
  private readLocation = () => {
    this.selected = new URL(location.href).searchParams.get("skill") ?? "";
  };
  private text(key: string, fallback: string) {
    return clientText(this.locale, (uiLabelPaths[key] ?? key), fallback);
  }
  protected render() {
    if (!this.data) return nothing;
    const data = this.data;
    const name = (value: unknown) => localizedText(value, this.locale);
    const needle = this.query.trim().toLocaleLowerCase(this.locale);
    const eligible = data.entries.filter((entry) => this.includeUnlinked || entry.cards.length > 0);
    const effects = new Map(
      eligible.flatMap((entry) => entry.effects).map((effect) => [String(effect.id), effect.name]),
    );
    const rows = eligible.filter(
      (entry) =>
        (!this.family || entry.family === this.family) &&
        (!this.effect || entry.effects.some((effect) => String(effect.id) === this.effect)) &&
        (!needle ||
          `${entry.id} ${name(entry.name)} ${entry.levels.map((level) => name(level.description)).join(" ")}`
            .toLocaleLowerCase(this.locale)
            .includes(needle)),
    );
    const chosen = data.entries.find((entry) => entry.key === this.selected);
    const open = (event: MouseEvent, key: string) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      const url = new URL(location.href);
      url.searchParams.set("skill", key);
      history.pushState(null, "", url);
      this.selected = key;
      void this.updateComplete.then(() =>
        this.querySelector<HTMLElement>("[data-skill-detail]")?.scrollIntoView({ block: "center" }),
      );
    };
    return html`
      <div class="page">
        <div class="card-detail-controls__pair">
          <md-outlined-text-field
            label=${this.text("search", "Search")}
            type="search"
            .value=${this.query}
            @input=${(event: Event) => {
              this.query = (event.target as HTMLInputElement).value;
            }}
          ></md-outlined-text-field>
          <md-outlined-select
            label=${this.text("type", "Type")}
            .value=${this.family || "all"}
            @change=${(event: Event) => {
              const value = (event.target as HTMLSelectElement).value;
              this.family = value === "all" ? "" : value;
            }}
          >
            <md-select-option value="all"><span slot="headline">${this.text("all", "All")}</span></md-select-option>
            ${Object.entries(familyLabels).map(
              ([family, key]) => html`
                <md-select-option value=${family}>
                  <span slot="headline">${this.text(key, family)}</span>
                </md-select-option>
              `,
            )}
          </md-outlined-select>
          <md-outlined-select
            label=${this.text("effects", "Effects")}
            .value=${this.effect || "all"}
            @change=${(event: Event) => {
              const value = (event.target as HTMLSelectElement).value;
              this.effect = value === "all" ? "" : value;
            }}
          >
            <md-select-option value="all"><span slot="headline">${this.text("all", "All")}</span></md-select-option>
            ${[...effects]
              .sort((a, b) => name(a[1]).localeCompare(name(b[1]), this.locale))
              .map(
                ([id, label]) => html`
                  <md-select-option value=${id}><span slot="headline">${name(label) || id}</span></md-select-option>
                `,
              )}
          </md-outlined-select>
        </div>
        ${filterChip({
          label: this.text("catalog.skills.includeUnlinked", "Include skills without associated cards"),
          selected: this.includeUnlinked,
          onToggle: () => {
            this.includeUnlinked = !this.includeUnlinked;
          },
        })}
        <p role="status">${rows.length.toLocaleString(this.locale)} / ${eligible.length.toLocaleString(this.locale)}</p>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>${this.text("skills", "Skills")}</th>
                <th>${this.text("type", "Type")}</th>
                <th>${this.text("level", "Level")}</th>
                <th>${this.text("cards", "Cards")}</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                (entry) => html`
                  <tr>
                    <td>
                      <a
                        href=${`?skill=${encodeURIComponent(entry.key)}`}
                        @click=${(event: MouseEvent) => open(event, entry.key)}
                      >
                        ${name(entry.name) || entry.key}
                      </a>
                    </td>
                    <td>${this.text(familyLabels[entry.family], entry.family)}</td>
                    <td>${entry.levels.map((level) => level.level).join(", ")}</td>
                    <td>${entry.cards.length.toLocaleString(this.locale)}</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
        ${
          chosen
            ? html`
                <section class="detail-section" data-skill-detail aria-label=${name(chosen.name)}>
                  <h2>${name(chosen.name) || chosen.key}</h2>
                  ${
                    chosen.image
                      ? html`
                          <img src=${chosen.image} alt="" width="48" height="48" loading="lazy" />
                        `
                      : nothing
                  }
                  <p>${this.text(familyLabels[chosen.family], chosen.family)} · ${chosen.id}</p>
                  <dl class="spec-list">
                    ${chosen.levels.map(
                      (level) => html`
                        <div>
                          <dt>${this.text("level", "Level")} ${level.level}</dt>
                          <dd>${name(level.description) || this.text("unavailable", "Unavailable")}</dd>
                        </div>
                      `,
                    )}
                  </dl>
                  <h3>${this.text("required", "Required")}</h3>
                  ${chosen.costs.map((cost) => {
                    const key = `${data.server}:${data.releaseId}:${chosen.key}:${cost.key}`;
                    const stages = [1, ...new Set(cost.steps.map((step) => step.to))].sort((a, b) => a - b);
                    const to = this.targets.get(key) ?? stages.at(-1)!;
                    const label = this.text(
                      cost.kind === "awakening" ? "awakening" : cost.kind === "rank" ? "rank" : "level",
                      cost.kind,
                    );
                    const steps = cost.steps.map((step) => ({
                      from: step.from,
                      to: step.to,
                      items: step.costs.map((value) => ({
                        identity: value.reference
                          ? `${value.reference.resource}:${value.reference.id}`
                          : value.itemId !== undefined
                            ? `items:${value.itemId}`
                            : "",
                        name: name(value.reference?.name) || this.text("required", "Required"),
                        count: value.count,
                        image: String(value.reference?.image ?? ""),
                        ...(value.reference?.resource === "items" || value.reference?.resource === "support-cards"
                          ? {
                              href: resourcePath({
                                server: data.server,
                                locale: this.locale as Locale,
                                kind: value.reference.resource,
                                id: value.reference.id,
                              }),
                            }
                          : {}),
                      })),
                    }));
                    return html`
                      <div class="card-detail-controls">
                        <div class="card-relation-list">
                          ${chosen.cards
                            .filter((card) => card.costKey === cost.key)
                            .map(
                              (card) => html`
                                <a
                                  href=${resourcePath({ server: data.server, locale: this.locale as Locale, kind: card.kind, id: card.id })}
                                >
                                  ${name(card.name) || card.id}
                                </a>
                              `,
                            )}
                        </div>
                        ${
                          cost.steps.length
                            ? html`
                                ${renderLevelSwitch(
                                  label,
                                  stages,
                                  to,
                                  (value) => {
                                    this.targets.set(key, value);
                                    this.requestUpdate();
                                  },
                                  String,
                                  { context: key },
                                )}
                                ${upgradeCost({ label, from: Math.max(1, to - 1), to, initial: 1, locale: this.locale, scope: key, items: [], steps })}
                              `
                            : html`
                                <p>${this.text("unavailable", "Unavailable")}</p>
                              `
                        }
                      </div>
                    `;
                  })}
                  <h3>${this.text("cards", "Cards")}</h3>
                  <p class="detail-copy">
                    ${this.text("catalog.skills.costsHint", "Open a related card to view its upgrade costs.")}
                  </p>
                  <div class="card-relation-list">
                    ${chosen.cards.map(
                      (card) => html`
                        <a
                          href=${resourcePath({ server: data.server, locale: this.locale as Locale, kind: card.kind, id: card.id })}
                        >
                          ${
                            card.image
                              ? html`
                                  <img src=${card.image} alt="" loading="lazy" />
                                `
                              : nothing
                          }
                          ${name(card.name) || card.id}
                        </a>
                      `,
                    )}
                  </div>
                </section>
              `
            : nothing
        }
      </div>
    `;
  }
}
if (typeof customElements !== "undefined" && !customElements.get("skills-workspace"))
  customElements.define("skills-workspace", SkillsWorkspace);
