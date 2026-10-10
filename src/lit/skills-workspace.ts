import { LitElement, html, nothing } from "lit";
import { clientText } from "../i18n/client";
import { localizedText } from "./shared/catalog";
import { resolveLocalizedText } from "../lib/localized-text";
import { resourcePath } from "../lib/resource-route";
import { readPageData } from "../lib/page-data";
import type { Locale } from "../i18n/locales";
import type { SkillCatalogEntry, SkillCatalogPayload, SkillFamily } from "../server/skill-catalog";
import { skillPageId } from "../lib/skill-page";
import { setAppBarSearch } from "../lib/app-bar";
import { clearBrowseBar, renderBrowse } from "./ui/browse";
import { collectionView, viewSwitch, collectionList, collectionTable, type CollectionView } from "./ui/collection-view";
import { filterChip, inputChip } from "./ui/controls";
import { facet } from "./ui/facet";
import { tile } from "./ui/tile";
import { icon } from "./ui/icon";
import { LazyImages, nextImageCandidate } from "./ui/lazy-images";
import { paneSection, renderPane } from "./ui/pane";
import { detailLayout } from "./ui/detail-layout";
import "./ui/image-gallery";
import { emptyState } from "./ui/state";
import { upgradeCost } from "./ui/upgrade-cost";
import { renderLevelSwitch } from "./ui/level-switch";
import "../styles/card-detail.css";

/**
 * Skills, as a catalogue collection: grid, list and table views linking to
 * one canonical page per skill, the shared browse bar and filter sheet, and
 * search in the app bar. On a skill's page the shell's app bar carries its
 * title, Back and the neighbouring skills.
 */
const FAMILY_LABELS: Record<SkillFamily, string> = {
  leader: "catalog.cards.fields.leaderSkill",
  live: "catalog.cards.fields.liveSkill",
  gekisou: "catalog.cards.fields.gekisouSkill",
  support: "catalog.cards.fields.supportSkill",
  gekisouSupport: "catalog.cards.fields.gekisouSupportSkill",
};
const FAMILIES = Object.keys(FAMILY_LABELS) as SkillFamily[];
const SEARCH_OWNER = "skills";

type Facet = "family" | "effect";

export class SkillsWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    entityId: { type: String, attribute: "entity-id" },
    query: { state: true },
    facets: { state: true },
    includeUnlinked: { state: true },
    view: { state: true },
    filtersOpen: { state: true },
  };
  declare locale: string;
  declare entityId: string;
  declare private query: string;
  declare private facets: Record<Facet, string[]>;
  declare private includeUnlinked: boolean;
  declare private view: CollectionView;
  declare private filtersOpen: boolean;
  private data?: SkillCatalogPayload;
  private targets = new Map<string, number>();
  private lazyImages = new LazyImages();
  private releaseSearch?: () => void;

  constructor() {
    super();
    this.locale = "en";
    this.entityId = "";
    this.query = "";
    this.facets = { family: [], effect: [] };
    this.includeUnlinked = false;
    this.view = "grid";
    this.filtersOpen = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.data = readPageData<SkillCatalogPayload>(this);
    this.replaceChildren();
    if (this.entityId) return;
    const params = new URLSearchParams(location.search);
    const legacy = this.data?.entries.find((entry) => entry.key === params.get("skill"));
    if (legacy) {
      location.replace(this.skillHref(legacy));
      return;
    }
    this.query = params.get("q") ?? "";
    this.view = collectionView(params.get("view"));
    this.includeUnlinked = params.get("unlinked") === "1";
    this.facets = { family: params.getAll("filter.family"), effect: params.getAll("filter.effect") };
    this.releaseSearch = setAppBarSearch(SEARCH_OWNER, {
      value: this.query,
      label: this.text("common.actions.search", "Search"),
      onInput: (value) => {
        this.query = value;
        this.sync();
      },
    });
  }
  disconnectedCallback() {
    this.releaseSearch?.();
    clearBrowseBar();
    this.lazyImages.disconnect();
    super.disconnectedCallback();
  }
  private sync() {
    const params = new URLSearchParams(location.search);
    for (const key of ["q", "view", "unlinked", "filter.family", "filter.effect"]) params.delete(key);
    if (this.query) params.set("q", this.query);
    if (this.view !== "grid") params.set("view", this.view);
    if (this.includeUnlinked) params.set("unlinked", "1");
    for (const key of ["family", "effect"] as const)
      for (const value of this.facets[key]) params.append(`filter.${key}`, value);
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private text(key: string, fallback: string, params?: Record<string, string | number>) {
    return clientText(this.locale, key, fallback, params);
  }
  private name(value: unknown) {
    return localizedText(value, this.locale);
  }
  private familyLabel(family: SkillFamily) {
    return this.text(FAMILY_LABELS[family], family);
  }
  private effectNames(entry: SkillCatalogEntry) {
    return entry.effects.map((effect) => this.name(effect.name) || String(effect.id)).join(" · ");
  }
  private levelRange(entry: SkillCatalogEntry) {
    const levels = entry.levels.map((level) => level.level);
    if (!levels.length) return "—";
    const low = Math.min(...levels);
    const high = Math.max(...levels);
    return low === high ? `Lv.${low}` : `Lv.${low}–${high}`;
  }
  private lines(value: unknown) {
    const text = this.name(value).trim();
    if (!text) return this.text("common.states.unavailable", "Unavailable");
    return text.split(/\r?\n/u).map((line, index) =>
      index
        ? html`
            <br />
            ${line}
          `
        : line,
    );
  }
  private skillTitle(entry: SkillCatalogEntry) {
    return html`
      <span lang=${resolveLocalizedText(entry.name, this.locale).locale}>${this.name(entry.name) || entry.key}</span>
    `;
  }
  private skillHref(entry: SkillCatalogEntry) {
    return resourcePath({
      server: this.data!.server,
      locale: this.locale as Locale,
      kind: "skills",
      id: skillPageId(entry),
    });
  }
  private toggle(key: Facet, value: string) {
    const current = this.facets[key];
    this.facets = {
      ...this.facets,
      [key]: current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
    };
    this.sync();
  }
  updated() {
    this.lazyImages.observe(this);
  }

  protected render() {
    const data = this.data;
    if (!data) return nothing;
    if (this.entityId) {
      const entry = data.entries.find((row) => skillPageId(row) === this.entityId);
      return entry ? this.renderDetail(data, entry) : nothing;
    }
    const source = data.entries.filter((entry) => this.includeUnlinked || entry.cards.length > 0);
    const needle = this.query.trim().normalize("NFKC").toLocaleLowerCase(this.locale);
    const matches = (entry: SkillCatalogEntry, skip?: Facet) =>
      (skip === "family" || !this.facets.family.length || this.facets.family.includes(entry.family)) &&
      (skip === "effect" ||
        !this.facets.effect.length ||
        entry.effects.some((effect) => this.facets.effect.includes(String(effect.id)))) &&
      (!needle ||
        `${entry.id} ${this.name(entry.name)} ${this.effectNames(entry)} ${entry.levels.map((level) => this.name(level.description)).join(" ")}`
          .normalize("NFKC")
          .toLocaleLowerCase(this.locale)
          .includes(needle));
    const rows = source.filter((entry) => matches(entry));
    const effects = new Map<string, unknown>();
    for (const entry of source) for (const effect of entry.effects) effects.set(String(effect.id), effect.name);
    const cardCount = (entry: SkillCatalogEntry) =>
      this.text("catalog.skills.cardCount", "{count} cards", { count: entry.cards.length });
    const results =
      this.view === "grid"
        ? html`
            <div class="collection collection--item">
              ${rows.map((entry) =>
                tile({
                  kind: "item",
                  title: this.skillTitle(entry),
                  subtitle: this.familyLabel(entry.family),
                  label: this.name(entry.name) || entry.key,
                  image: entry.image,
                  fit: "contain",
                  aspectRatio: 1,
                  placeholder: icon("bolt", 32),
                  onImageError: nextImageCandidate,
                  href: this.skillHref(entry),
                }),
              )}
            </div>
          `
        : this.view === "list"
          ? collectionList(
              rows.map((entry) => ({
                id: entry.key,
                title: this.skillTitle(entry),
                subtitle: [this.familyLabel(entry.family), this.effectNames(entry)].filter(Boolean).join(" · "),
                image: entry.image,
                trailing: entry.cards.length ? cardCount(entry) : nothing,
                href: this.skillHref(entry),
              })),
            )
          : collectionTable(
              this.text("catalog.cards.fields.skills", "Skills"),
              [
                this.text("common.fields.title", "Title"),
                this.text("catalog.fields.type", "Type"),
                this.text("catalog.fields.effects", "Effects"),
                this.text("common.fields.level", "Level"),
                this.text("navigation.cards", "Cards"),
                "ID",
              ],
              rows.map((entry) => [
                html`
                  <a class="table-entity" href=${this.skillHref(entry)}>
                    <img src=${entry.image} alt="" loading="lazy" decoding="async" />
                    ${this.skillTitle(entry)}
                  </a>
                `,
                this.familyLabel(entry.family),
                this.effectNames(entry) || "—",
                this.levelRange(entry),
                entry.cards.length.toLocaleString(this.locale),
                entry.id,
              ]),
            );
    const remove = this.text("common.actions.remove", "Remove");
    const applied = [
      ...this.facets.family.map((value) =>
        inputChip(this.familyLabel(value as SkillFamily), remove, () => this.toggle("family", value)),
      ),
      ...this.facets.effect.map((value) =>
        inputChip(this.name(effects.get(value)) || value, remove, () => this.toggle("effect", value)),
      ),
      ...(this.includeUnlinked
        ? [
            inputChip(this.text("catalog.skills.includeUnlinked", "Include skills without cards"), remove, () => {
              this.includeUnlinked = false;
              this.sync();
            }),
          ]
        : []),
    ];
    return renderBrowse({
      kind: "skills",
      count: {
        value: rows.length,
        label: rows.length === source.length ? "" : `/ ${source.length.toLocaleString(this.locale)}`,
      },
      modes: viewSwitch(this.locale, this.view, (view) => {
        this.view = view;
        this.sync();
      }),
      applied,
      results: rows.length
        ? results
        : emptyState({ title: this.text("common.states.empty", "No results"), icon: "search_off" }),
      filters: {
        label: this.text("common.actions.filter", "Filter"),
        open: this.filtersOpen,
        count: this.facets.family.length + this.facets.effect.length + Number(this.includeUnlinked),
        closeLabel: this.text("common.actions.close", "Close"),
        resetLabel: this.text("common.actions.reset", "Reset"),
        onOpen: () => (this.filtersOpen = true),
        onClose: () => (this.filtersOpen = false),
        onReset: () => {
          this.facets = { family: [], effect: [] };
          this.includeUnlinked = false;
          this.sync();
        },
        body: html`
          ${facet(
            this.text("catalog.fields.type", "Type"),
            this.locale,
            FAMILIES.map((family) => ({
              value: family,
              label: this.familyLabel(family),
              count: source.filter((entry) => entry.family === family && matches(entry, "family")).length,
            })).filter((option) => option.count || this.facets.family.includes(option.value)),
            this.facets.family,
            (value) => this.toggle("family", value),
          )}
          ${facet(
            this.text("catalog.fields.effects", "Effects"),
            this.locale,
            [...effects].map(([id, label]) => ({
              value: id,
              label: this.name(label) || id,
              count: source.filter(
                (entry) => entry.effects.some((effect) => String(effect.id) === id) && matches(entry, "effect"),
              ).length,
            })),
            this.facets.effect,
            (value) => this.toggle("effect", value),
          )}
          ${filterChip({
            label: this.text("catalog.skills.includeUnlinked", "Include skills without cards"),
            selected: this.includeUnlinked,
            onToggle: () => {
              this.includeUnlinked = !this.includeUnlinked;
              this.sync();
            },
          })}
        `,
      },
    });
  }

  private renderDetail(data: SkillCatalogPayload, entry: SkillCatalogEntry) {
    const title = this.name(entry.name) || entry.key;
    const cardHref = (card: SkillCatalogEntry["cards"][number]) =>
      resourcePath({ server: data.server, locale: this.locale as Locale, kind: card.kind, id: card.id });
    const members = entry.cards.filter((card) => card.kind === "member-cards");
    const supports = entry.cards.filter((card) => card.kind === "support-cards");
    const cardGrid = (cards: SkillCatalogEntry["cards"], kind: "member" | "support") => html`
      <div class=${`collection collection--${kind}`}>
        ${cards.map((card) =>
          tile({
            kind,
            title: this.name(card.name) || card.id,
            label: this.name(card.name) || card.id,
            image: card.image,
            fit: "contain",
            placeholder: icon("image", 32),
            onImageError: nextImageCandidate,
            href: cardHref(card),
          }),
        )}
      </div>
    `;
    const costs = entry.costs.filter((cost) => cost.steps.length);
    const costBlock = (cost: SkillCatalogEntry["costs"][number]) => {
      const key = `${data.server}:${data.releaseId}:${entry.key}:${cost.key}`;
      const stages = [1, ...new Set(cost.steps.map((step) => step.to))].sort((a, b) => a - b);
      const to = this.targets.get(key) ?? stages.at(-1)!;
      const label = this.text(
        cost.kind === "awakening"
          ? "catalog.cards.fields.rankUp"
          : cost.kind === "rank"
            ? "catalog.cards.fields.rank"
            : "common.fields.level",
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
          name: this.name(value.reference?.name) || this.text("common.fields.required", "Required"),
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
      const users = entry.cards.filter((card) => card.costKey === cost.key);
      return html`
        <div class="card-detail-controls">
          ${
            costs.length > 1 || users.length < entry.cards.length
              ? html`
                  <div class="card-relation-list">
                    ${users.map(
                      (card) => html`
                        <a href=${cardHref(card)}>
                          ${
                            card.image
                              ? html`
                                  <img src=${card.image} alt="" loading="lazy" decoding="async" />
                                `
                              : nothing
                          }
                          ${this.name(card.name) || card.id}
                        </a>
                      `,
                    )}
                  </div>
                `
              : nothing
          }
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
        </div>
      `;
    };
    return renderPane({
      title,
      titleLanguage: resolveLocalizedText(entry.name, this.locale).locale,
      kind: "skill",
      style: "--detail-media-size:200px",
      open: true,
      page: true,
      hideHeader: true,
      backLabel: this.text("common.actions.back", "Back"),
      onClose: () => undefined,
      body: detailLayout(
        entry.image
          ? html`
              <image-gallery
                .images=${[{ id: entry.key, source: entry.image, label: title }]}
                locale=${this.locale}
                title=${title}
              ></image-gallery>
            `
          : nothing,
        html`
          ${paneSection(
            this.text("common.actions.details", "Details"),
            icon("info", 20),
            html`
              <dl class="spec-list spec-list--split">
                <div>
                  <dt>${this.text("catalog.fields.type", "Type")}</dt>
                  <dd>${this.familyLabel(entry.family)}</dd>
                </div>
                <div>
                  <dt>${this.text("catalog.fields.effects", "Effects")}</dt>
                  <dd>${this.effectNames(entry) || "—"}</dd>
                </div>
                <div>
                  <dt>${this.text("common.fields.level", "Level")}</dt>
                  <dd>${this.levelRange(entry)}</dd>
                </div>
                <div>
                  <dt>ID</dt>
                  <dd>${entry.id}</dd>
                </div>
              </dl>
            `,
          )}
          ${
            entry.levels.length
              ? paneSection(
                  this.text("catalog.cards.fields.effectsByLevel", "Effects by level"),
                  icon("trending_up", 20),
                  html`
                    <dl class="spec-list">
                      ${entry.levels.map(
                        (level) => html`
                          <div>
                            <dt>Lv.${level.level}</dt>
                            <dd lang=${resolveLocalizedText(level.description, this.locale).locale}>
                              ${this.lines(level.description)}
                            </dd>
                          </div>
                        `,
                      )}
                    </dl>
                  `,
                  entry.levels.length,
                )
              : nothing
          }
          ${
            costs.length
              ? paneSection(
                  this.text("catalog.skills.upgradeCosts", "Upgrade materials"),
                  icon("inventory_2", 20),
                  html`
                    ${costs.map(costBlock)}
                  `,
                )
              : nothing
          }
          ${
            members.length
              ? paneSection(
                  this.text("navigation.memberCards", "Members"),
                  icon("person", 20),
                  cardGrid(members, "member"),
                  members.length,
                )
              : nothing
          }
          ${
            supports.length
              ? paneSection(
                  this.text("navigation.supportCards", "Support cards"),
                  icon("photo_library", 20),
                  cardGrid(supports, "support"),
                  supports.length,
                )
              : nothing
          }
        `,
      ),
    });
  }
}
if (typeof customElements !== "undefined" && !customElements.get("skills-workspace"))
  customElements.define("skills-workspace", SkillsWorkspace);
