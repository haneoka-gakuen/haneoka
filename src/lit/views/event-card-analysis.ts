// L3 — GEB
// Input: Per-song public team aggregates and card catalogue entries.
// Output: Lineup comparisons, member–snapshot pairs, rank-band differences and card lookup.
// Pos: [Map](../L2-2.md); interactive card analysis within event ranking statistics.
// Effects/Dependencies: Keeps tab and picker state locally; renders card catalog links and imagery.
import { html, LitElement, nothing } from "lit";
import type { EventCardAnalysis, EventCardBoard, EventCardTier } from "../../lib/event-card-analysis";
import { normalizeSearchText } from "../../lib/search-text";
import { catalogCardTile } from "../shared/card-tile";
import { catalogCharacterRelationship } from "../shared/catalog-relationships";
import { rankingCardThumbnail } from "../shared/game-records-cards";
import type { RankingCardCharacter } from "../../lib/game-records";
import { clientText } from "../../i18n/client";
import { resolveLocalizedText } from "../../lib/localized-text";
import { catalogQueryNames } from "../../lib/catalog-query";
import { chooserFacet } from "../ui/chooser-filters";
import { renderDetailSectionHeading as heading } from "../shared/detail-section-heading";
import { accordion } from "../ui/accordion";
import { segmented } from "../ui/controls";
import { LazyImages } from "../ui/lazy-images";
import { historySelect } from "../ui/history-select";
import { selectionPane } from "../ui/selection-pane";
import { specList } from "../ui/spec";
import { emptyState } from "../ui/state";
import "../ui/scrollable-tabs";

type Kind = "member" | "support";
type Tab = "lineups" | "partners" | "tiers" | "lookup";
export type CardInfo = (kind: Kind, id: number) => {
  label: string;
  titleLanguage?: string;
  image?: string;
  href?: string;
  attributeIcon?: string;
  rarityIcon?: string;
  rarityLabel?: string;
  rarity?: number;
  cardType?: number;
  attributeLabel?: string;
  characters?: ({ id: number } & RankingCardCharacter)[];
};
type Card = ReturnType<CardInfo>;
type Facets = { character: string; attribute: string; rarity: string };
const emptyFacets = (): Facets => ({ character: "", attribute: "", rarity: "" });
type Label = (key: string, fallback: string) => string;
type Scope = Pick<EventCardBoard, "members" | "supports">;
const usage = (scope: Scope, kind: Kind) => (kind === "member" ? scope.members : scope.supports);
const bandName = (tier: EventCardTier) => `#${tier.from}–${tier.to}`;

class EventStatisticsCards extends LitElement {
  static properties = {
    data: { attribute: false },
    cardInfo: { attribute: false },
    t: { attribute: false },
    locale: {},
    tab: { state: true },
    kind: { state: true },
    card: { state: true },
    first: { state: true },
    second: { state: true },
    chooser: { state: true },
    filters: { state: true },
    facets: { state: true },
    query: { state: true },
    expanded: { state: true },
  };
  declare data: EventCardAnalysis;
  declare cardInfo: CardInfo;
  declare t: Label;
  declare locale: string;
  declare private tab: Tab;
  declare private kind: Kind;
  declare private card: number;
  declare private first: number;
  declare private second: number;
  declare private chooser: boolean;
  declare private filters: boolean;
  declare private facets: Facets;
  declare private query: string;
  declare private expanded: Set<string>;
  constructor() {
    super();
    this.tab = "lineups";
    this.kind = "member";
    this.card = 0;
    this.first = 0;
    this.second = 1;
    this.chooser = false;
    this.filters = false;
    this.facets = emptyFacets();
    this.query = "";
    this.expanded = new Set();
  }
  private readonly images = new LazyImages();
  createRenderRoot() {
    return this;
  }
  updated() {
    this.images.observe(this);
  }
  disconnectedCallback() {
    this.images.disconnect();
    super.disconnectedCallback();
  }
  private percent(n: number, total: number) {
    return total
      ? new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 1 }).format(n / total)
      : "—";
  }
  private fold(id: string, label: string, content: unknown) {
    return accordion({
      id: `event-card-${id}`,
      label,
      expanded: this.expanded.has(id),
      content,
      onExpandedChange: (open) => {
        const next = new Set(this.expanded);
        if (open) next.add(id);
        else next.delete(id);
        this.expanded = next;
      },
    });
  }
  private kindSwitch() {
    return segmented<Kind>({
      label: this.t("cardKind", "Card type"),
      value: this.kind,
      grow: false,
      options: [
        { value: "member", label: this.t("member", "Members") },
        { value: "support", label: this.t("support", "Snapshots") },
      ],
      onSelect: (kind) => {
        this.kind = kind;
        this.card = 0;
        this.facets = emptyFacets();
      },
    });
  }
  private relation(card: Card) {
    const characters = card.characters ?? [];
    return catalogCharacterRelationship(characters.map(character => character.id), this.locale,
      id => characters.find(character => character.id === id));
  }

  private chooserTile(card: Card) {
    return catalogCardTile({
      kind: this.kind, title: card.label, titleLanguage: card.titleLanguage, relation: this.relation(card),
      image: card.image ?? "", attributeIcon: card.attributeIcon ?? "", attributeLabel: card.attributeLabel ?? "",
      rarityIcon: card.rarityIcon ?? "", rarityLabel: card.rarityLabel ?? "",
    });
  }

  private identity(kind: Kind, id: number, short = false) {
    const card = this.cardInfo(kind, id);
    const face = rankingCardThumbnail({
      name: card.label, href: short ? card.href : undefined, support: kind === "support",
      image: card.image, attributeIcon: card.attributeIcon, rarityIcon: card.rarityIcon,
    });
    if (short) return face;
    const relation = this.relation(card);
    const content = html`${face}<span class="tile__identity detail-object__copy">
      <strong class="tile__title" lang=${card.titleLanguage || nothing}>${card.label}</strong>
      ${relation.label ? html`<small class="tile__subtitle">${relation.adornment}<span>${relation.content}</span></small>` : nothing}
    </span>`;
    return card.href ? html`<a class="detail-object" href=${card.href}>${content}</a>`
      : html`<span class="detail-object">${content}</span>`;
  }
  private table(headers: string[], rows: unknown[][]) {
    return html`
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              ${headers.map(
        (label) => html`
          <th scope="col">${label}</th>
        `,
      )}
            </tr>
          </thead>
          <tbody>
            ${rows.map(
      ([label, ...cells]) => html`
        <tr>
          <th scope="row">${label}</th>
          ${cells.map(
            (cell) => html`
              <td>${cell}</td>
            `,
          )}
        </tr>
      `,
    )}
          </tbody>
        </table>
      </div>
    `;
  }
  private faces(kind: Kind, ids: number[]) {
    return ids.length
      ? html`
          <div class="cluster stats-faces">${ids.map((id) => this.identity(kind, id, true))}</div>
        `
      : "—";
  }
  private lineups() {
    const { t } = this,
      board = this.data.selected,
      list = board.lineups;
    if (!list.length) return emptyState({ title: t("noTeams", "No public teams") });
    const options = list.map((line, index) => ({
      value: String(index),
      label: `#${index + 1} · ${this.percent(line.count, board.teamCount)}`,
    }));
    const ai = Math.min(this.first, list.length - 1),
      bi = Math.min(this.second, list.length - 1);
    const a = list[ai]!,
      b = list[bi]!,
      across = this.data.acrossSongs;
    const coll = (ids: number[]) => this.faces("member", ids);
    return html`
      <div class="stack">
        ${specList(
        [
          { label: t("formations", "Member lineups"), value: list.length },
          { label: t("topLineup", "Most used lineup"), value: this.percent(list[0]!.count, board.teamCount) },
          {
            label: t("topThree", "Top three coverage"),
            value: this.percent(
              list.slice(0, 3).reduce((n, v) => n + v.count, 0),
              board.teamCount,
            ),
          },
        ],
        { split: true, numeric: true },
      )}
        <div class="cluster stats-selects">
          ${historySelect(t("lineupA", "Baseline lineup"), String(ai), options, (v) => {
          this.first = Number(v);
        })}
          ${
          list.length > 1
            ? historySelect(t("lineupB", "Comparison lineup"), String(bi), options, (v) => {
                this.second = Number(v);
              })
            : nothing
        }
        </div>
        ${
        list.length > 1
          ? specList([
              {
                label: t("sharedCards", "Shared members"), wide: true,
                value: coll(a.members.filter((id) => b.members.includes(id))),
              },
              { label: t("onlyA", "Only in baseline"), value: coll(a.members.filter((id) => !b.members.includes(id))) },
              { label: t("onlyB", "Only in comparison"), value: coll(b.members.filter((id) => !a.members.includes(id))) },
            ], { split: true })
          : coll(a.members)
      }
        ${this.fold(
        "lineup-slots",
        t("typicalPairs", "Most frequent slot pairings"),
        html`
          <div class="grid grid--fit statistics-overview">
            ${[...new Set([ai, bi])].map(
              (i) => html`
                <section class="stack stack--tight">
                  ${heading(options[i]!.label, "cards")}
                  ${this.table(
            [t("member", "Members"), t("support", "Snapshots")],
            list[i]!.slots.map((slot) => [
              this.identity("member", slot.memberId),
              slot.supportId ? this.identity("support", slot.supportId) : "—",
            ]),
          )}
                </section>
              `,
            )}
          </div>
        `,
      )}
        ${
        this.data.boards.length > 1
          ? this.fold(
              "reuse",
              t("reuse", "Teams across songs"),
              specList(
                [
                  { label: t("multipleSongs", "Players on multiple songs"), value: across.players },
                  { label: t("unchanged", "Same lineup and pairings"), value: across.same },
                  { label: t("reordered", "Swapped pairings"), value: across.reordered },
                  { label: t("changedSupports", "Changed snapshots"), value: across.changedSupports },
                  { label: t("changedMembers", "Changed members"), value: across.changedMembers },
                  { label: t("allSongsSame", "Same team on every song"), value: across.allSongsSame },
                ],
                { split: true, numeric: true },
              ),
            )
          : nothing
      }
      </div>
    `;
  }
  private available() {
    const boards = this.tab === "lookup" ? this.data.boards : [this.data.selected];
    const ids = new Set<number>();
    for (const board of [this.data.selected, ...boards]) for (const card of usage(board, this.kind)) ids.add(card.id);
    return [...ids];
  }
  private async closeChooser() {
    this.chooser = false;
    await this.updateComplete;
    this.querySelector<HTMLElement>(".stats-card-trigger")?.focus();
  }

  private picker(ids: number[], id: number) {
    const { t } = this;
    const common = (key: string, fallback: string) => clientText(this.locale, key, fallback);
    const options = this.chooser ? ids.map(id => ({ id, card: this.cardInfo(this.kind, id) })) : [];
    const terms = normalizeSearchText(this.query, this.locale).split(/\s+/u).filter(Boolean);
    const items = options.flatMap(({ id, card }) => {
      const characters = card.characters ?? [];
      if (this.facets.character && !characters.some(ch => String(ch.id) === this.facets.character)
        || this.facets.attribute && String(card.cardType) !== this.facets.attribute
        || this.facets.rarity && String(card.rarity) !== this.facets.rarity) return [];
      const item = this.chooserTile(card);
      const names = characters.flatMap(character => catalogQueryNames(character, "character"));
      const haystack = normalizeSearchText([`#${id}`, item.label, ...names].join(" "), this.locale);
      return terms.every(term => haystack.includes(term)) ? [{ ...item, value: String(id) }] : [];
    });
    const facet = (key: keyof Facets, label: string, values: {value: string; label: string; image?: string}[]) =>
      chooserFacet({ label, allLabel: common("common.states.all", "All"), value: this.facets[key],
        options: [...new Map(values.map(option => [option.value, option])).values()].sort((a,b)=>Number(a.value)-Number(b.value)),
        change: value => { this.facets = { ...this.facets, [key]: value }; } });
    return html`
      <div class="cluster">
        ${this.kindSwitch()}
        <md-filled-tonal-button class="stats-card-trigger"
          type="button"
          @click=${() => {
        this.chooser = true;
        this.query = "";
        this.filters = false;
        this.facets = emptyFacets();
      }}
        >
          ${t("pickCard", "Choose card")}
        </md-filled-tonal-button>
      </div>
      ${id ? this.identity(this.kind, id) : nothing}
      ${
      this.chooser
        ? selectionPane({
            id: "event-statistics-card-picker",
            managed: true,
            title: t("pickCard", "Choose card"),
            closeLabel: t("close", "Close"),
            close: () => void this.closeChooser(),
            searchLabel: t("searchCards", "Search cards"),
            filterLabel: t("filters", "Filters"),
            filtersOpen: this.filters,
            toggleFilters: () => {
              this.filters = !this.filters;
            },
            query: this.query,
            search: (v) => {
              this.query = v;
            },
            quickFilters: this.kindSwitch(),
            filterCount: Object.values(this.facets).filter(Boolean).length,
            filters: html`
              ${facet("character", common("catalog.fields.character", "Character"),
                options.flatMap(({card}) => (card.characters ?? []).map(ch => ({ value: String(ch.id),
                  label: resolveLocalizedText(ch.characterName, this.locale).text || resolveLocalizedText(ch.englishName, this.locale).text,
                  image: ch.faceImage }))))}
              ${facet("attribute", common("catalog.fields.attribute", "Attribute"), options.flatMap(({card}) =>
                card.cardType && card.attributeLabel ? [{value: String(card.cardType), label: card.attributeLabel, image: card.attributeIcon}] : []))}
              ${facet("rarity", common("catalog.cards.fields.rarity", "Rarity"), options.flatMap(({card}) =>
                card.rarity && card.rarityLabel ? [{value: String(card.rarity), label: card.rarityLabel, image: card.rarityIcon}] : []))}
            `,
            filterLayout: "facets",
            kind: this.kind,
            items,
            selected: String(id),
            select: (v) => {
              this.card = Number(v);
              void this.closeChooser();
            },
            countLabel: t("pickerCount", "{count} cards").replace("{count}", String(items.length)),
            emptyLabel: t("noCards", "No matching cards"),
            preview: nothing,
          })
        : nothing
    }
    `;
  }
  private pairs(id: number) {
    const { t } = this,
      board = this.data.selected;
    const own = usage(board, this.kind).find((c) => c.id === id),
      member = this.kind === "member";
    const rows = board.pairs
      .filter((p) => (member ? p.memberId : p.supportId) === id)
      .sort((a, b) => b.count - a.count);
    return rows.length
      ? this.table(
          [
            member ? t("support", "Snapshots") : t("member", "Members"),
            t("pairShare", "Share with selected card"),
          ],
          rows.map((p) => [
            this.identity(member ? "support" : "member", member ? p.supportId : p.memberId),
            this.percent(p.count, own?.count ?? 0),
          ]),
        )
      : emptyState({ title: t("noPairs", "No recorded pairings") });
  }
  private cards() {
    const { t } = this,
      board = this.data.selected,
      ids = this.available(),
      id = ids.includes(this.card) ? this.card : (ids[0] ?? 0);
    const card = usage(board, this.kind).find((c) => c.id === id);
    return html`
      <div class="stack">
        ${this.picker(ids, id)}
        ${
        id
          ? html`
              ${specList(
                [
                  { label: t("usage", "Team usage"), value: this.percent(card?.count ?? 0, board.teamCount) },
                  this.kind === "member" ? { label: t("leader", "Leader"), value: card?.leaderCount ?? 0 } : null,
                ],
                { split: true, numeric: true },
              )}
              ${
        this.tab === "partners"
          ? this.pairs(id)
          : html`
              ${this.table(
          [t("board", "Board"), t("usage", "Team usage"), t("bestRank", "Best rank")],
          this.data.boards.map((b) => {
            const u = usage(b, this.kind).find((c) => c.id === id);
            return [b.label, this.percent(u?.count ?? 0, b.teamCount), u?.ranks.length ? `#${Math.min(...u.ranks)}` : "—"];
          }),
        )}
              ${this.table(
          [t("rankBand", "Rank band"), t("usage", "Team usage")],
          board.tiers.map((tier) => [
            bandName(tier),
            this.percent(usage(tier, this.kind).find((c) => c.id === id)?.count ?? 0, tier.teamCount),
          ]),
        )}
              ${this.fold(
          "lookup-ranks",
          t("appearanceRanks", "Appearance ranks"),
          html`
            <p class="tabular">${card?.ranks.map((r) => `#${r}`).join(" · ") || "—"}</p>
          `,
        )}
              ${this.fold("lookup-partners", t("partners", "Pairings"), this.pairs(id))}
            `
      }
            `
          : emptyState({ title: t("noCards", "No matching cards") })
      }
      </div>
    `;
  }
  private tiers() {
    const { t } = this,
      board = this.data.selected,
      tiers = board.tiers;
    if (!tiers.length) return emptyState({ title: t("noTeams", "No public teams") });
    const head = tiers[0]!,
      tail = tiers.at(-1)!;
    const rates = tiers.map((tier) => new Map(usage(tier, this.kind).map((card) => [card.id, card.count])));
    const freq = (i: number, id: number) => (tiers[i]!.teamCount ? (rates[i]!.get(id) ?? 0) / tiers[i]!.teamCount : 0);
    const sorted = usage(board, this.kind)
      .map((c) => ({ id: c.id, delta: freq(0, c.id) - freq(tiers.length - 1, c.id) }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.id - b.id);
    const difference = (delta: number) =>
      new Intl.NumberFormat(this.locale, { signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(delta * 100);
    const growth = (field: "awaken" | "supportRanks", level: number, tier: EventCardTier) => {
      const all = tier[field].reduce((sum, v) => sum + v.count, 0);
      return this.percent(tier[field].find((v) => v.level === level)?.count ?? 0, all);
    };
    const highlights = [
      ...sorted.filter(row => row.delta > 0).slice(0, 5),
      ...sorted.filter(row => row.delta < 0).slice(0, 5),
    ];
    const rateTable = (entries: typeof sorted) => this.table(
      [t("card", "Card"), t("deltaPp", "First − last (pp)"), ...tiers.map(bandName)],
      entries.map(row => [
        this.identity(this.kind, row.id),
        head !== tail && head.teamCount && tail.teamCount ? difference(row.delta) : "—",
        ...tiers.map((ti, i) => this.percent(rates[i]!.get(row.id) ?? 0, ti.teamCount)),
      ]),
    );
    return html`
      <div class="stack">
        ${this.kindSwitch()}
        ${board.power ? specList([
          { label: t("powerMedian", "Median power"), value: board.power.median.toLocaleString(this.locale) },
          { label: t("powerP90", "P90 power"), value: board.power.p90.toLocaleString(this.locale) },
          { label: t("powerMin", "Lowest power"), value: board.power.min.toLocaleString(this.locale) },
          { label: t("powerMax", "Highest power"), value: board.power.max.toLocaleString(this.locale) },
        ], { split: true, numeric: true }) : nothing}
        ${rateTable(highlights.length ? highlights : sorted)}
        ${highlights.length && highlights.length < sorted.length
          ? this.fold("all-tier-cards", t("allCards", "All cards"), rateTable(sorted)) : nothing}
        ${this.fold(
        "tier-growth",
        t("powerGrowth", "Power and growth"),
        this.table(
          [t("rankBand", "Rank band"), ...tiers.map(bandName)],
          [
            [t("teams", "Public teams"), ...tiers.map((ti) => ti.teamCount)],
            [
              t("powerMedian", "Median power"),
              ...tiers.map((ti) => ti.power?.median.toLocaleString(this.locale) ?? "—"),
            ],
            [t("powerP90", "P90 power"), ...tiers.map((ti) => ti.power?.p90.toLocaleString(this.locale) ?? "—")],
            [t("powerMin", "Lowest power"), ...tiers.map(ti=>ti.power ? `${ti.power.min.toLocaleString(this.locale)} · #${ti.power.lowest.rank}` : "—")],
            [t("powerMax", "Highest power"), ...tiers.map(ti=>ti.power?.max.toLocaleString(this.locale) ?? "—")],
            ...(["awaken", "supportRanks"] as const).flatMap((field) => {
              const levels = [...new Set(tiers.flatMap((ti) => ti[field].map((v) => v.level)))].sort((a, b) => b - a);
              return levels.map((level) => [
                `${t(field, field === "awaken" ? "Member awakening" : "Snapshot limit break")} ${level}`,
                ...tiers.map((ti) => growth(field, level, ti)),
              ]);
            }),
          ],
        ),
      )}
      </div>
    `;
  }
  render() {
    if (!this.data) return nothing;
    const { t } = this,
      tabs: [Tab, string][] = [
        ["lineups", t("lineups", "Lineups")],
        ["partners", t("partners", "Pairings")],
        ["tiers", t("tiers", "Rank bands")],
        ["lookup", t("lookup", "Card lookup")],
      ];
    return html`
      <div class="stack event-statistics-cards">
        <scrollable-tabs
          .locale=${this.locale}
          .label=${t("cardAnalysis", "Card analysis")}
          .items=${tabs.map(([id, label]) => ({ id, label }))}
          .value=${this.tab}
          .onSelect=${(tab: Tab) => {
          this.tab = tab;
          this.expanded = new Set();
        }}
        ></scrollable-tabs>
        ${this.tab === "lineups" ? this.lineups() : this.tab === "tiers" ? this.tiers() : this.cards()}
        ${
        this.data.unavailable.length
          ? html`
              <small>${t("unavailableSongs", "Unavailable songs")} · ${this.data.unavailable.join(" · ")}</small>
            `
          : nothing
      }
      </div>
    `;
  }
}
if (!customElements.get("event-statistics-cards"))
  customElements.define("event-statistics-cards", EventStatisticsCards);
