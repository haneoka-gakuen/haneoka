import { difficultyPicker } from "./ui/difficulty-picker";
import { LitElement, html, nothing } from "lit";
import { icon } from "./ui/icon";

/**
 * Catalogue table view.
 *
 * Rebuilt as a real <table> inside a single horizontal scroll region.
 *
 * The previous implementation was a div tree with role="table" and a fixed
 * `grid-template-columns` of hard pixel widths — 2,372px for the song
 * presentation — inside a container declared `min-width: max-content;
 * overflow: hidden`. Below that width the right-hand columns were clipped
 * with no scrollbar: unreachable data, no indication it was there. That is
 * the out-of-bounds bug.
 *
 * Now: widths are content-driven with a per-column ceiling, the wrapper owns
 * the overflow and is keyboard-scrollable, the header row sticks vertically,
 * the identity column sticks horizontally, headers carry aria-sort and sort
 * the collection, and numeric columns are tabular and right-aligned so they
 * can actually be compared.
 */

type Item = Record<string, unknown>;
type Controller = Record<string, any>;
type ColumnKind = "entity" | "numeric" | "mark" | "action" | "text";

interface Column {
  key: string;
  kind: ColumnKind;
  /** Sort value understood by CatalogScreen, when the column is sortable. */
  sort?: string;
  /** Sticky identity column. */
  sticky?: boolean;
}

const column = (key: string, kind: ColumnKind = "text", sort?: string, sticky = false): Column => ({
  key,
  kind,
  sort,
  sticky,
});

const COLUMNS: Record<string, Column[]> = {
  member: [
    column("title", "entity", "title", true),
    column("character", "entity", "character"),
    column("band", "entity", "band"),
    column("attribute", "mark", "cardType"),
    column("rarity", "mark", "rarity"),
    column("performance", "numeric", "performance"),
    column("technique", "numeric", "technique"),
    column("visual", "numeric", "visual"),
    column("total", "numeric", "total"),
    column("skills"),
    column("category"),
    column("release", "text", "release"),
  ],
  support: [
    column("title", "entity", "title", true),
    column("character", "entity", "character"),
    column("band", "entity", "band"),
    column("attribute", "mark", "cardType"),
    column("rarity", "mark", "rarity"),
    column("performance", "numeric", "performance"),
    column("technique", "numeric", "technique"),
    column("visual", "numeric", "visual"),
    column("total", "numeric", "total"),
    column("skills"),
    column("release", "text", "release"),
  ],
  character: [
    column("title", "entity", "title", true),
    column("band", "entity", "band"),
    column("part"),
    column("school"),
  ],
  comic: [
    column("title", "entity", "title", true),
    column("subtitle", "text", "subtitle"),
    column("characters", "entity", "characters"),
    column("release", "text", "release"),
  ],
  stamp: [
    column("title", "entity", "title", true),
    column("characters", "entity", "characters"),
    column("release", "text", "release"),
  ],
  song: [
    column("title", "entity", "title", true),
    column("play", "action"),
    column("chart", "action"),
    column("attribute", "mark", "musicType"),
    column("band", "entity", "band"),
    column("difficulty", "numeric", "level"),
    column("time", "numeric", "time"),
    column("score", "numeric", "score"),
    column("eff", "numeric", "eff"),
    column("bpm", "numeric", "bpm"),
    column("n", "numeric", "n"),
    column("nps", "numeric", "nps"),
    column("sr", "numeric", "sr"),
    column("category", "text", "category"),
    column("composer", "text", "composer"),
    column("lyricist", "text", "lyrics"),
    column("arranger", "text", "arrangement"),
    column("release", "text", "release"),
  ],
  band: [column("title", "entity", "title", true)],
  "band-item": [
    column("title", "entity", "title", true),
    column("band", "entity", "band"),
    column("order", "numeric", "order"),
    column("levels", "numeric", "level"),
  ],
  item: [
    column("title", "entity", "title", true),
    column("type", "text", "itemTypeName"),
    column("maximum", "numeric", "max"),
    column("value", "numeric"),
  ],
};

/** Ceilings, so a long composer credit wraps instead of widening the table. */
const CELL_MAX: Record<string, string> = {
  title: "320px",
  character: "200px",
  characters: "260px",
  band: "180px",
  skills: "220px",
  subtitle: "260px",
  school: "220px",
  composer: "180px",
  lyricist: "180px",
  arranger: "180px",
  type: "200px",
  category: "160px",
};

export class CatalogTable extends LitElement {
  static properties = { controller: { attribute: false }, items: { attribute: false }, difficulty: {}, locale: {} };
  declare difficulty: string;
  declare locale: string;
  declare controller: Controller;
  declare items: Item[];
  createRenderRoot() {
    return this;
  }

  render() {
    const c = this.controller;
    if (!c) return nothing;
    const columns = COLUMNS[c.profile.presentation] || COLUMNS.item;
    const label = (key: string) => c.detailLabel(key);
    return html`
      <div class="table-scroll" role="region" tabindex="0" aria-label=${c.label("table", "Table")} data-scroll-region>
        <table class="data-table">
          <thead>
            <tr>${columns.map((entry) => this.header(entry, label(entry.key)))}</tr>
          </thead>
          <tbody>
            ${(this.items || []).map(
              (item) => html`
                <tr
                  class=${c.itemId(item) === c.itemId(c.selected || {}) ? "is-selected" : nothing}
                  @click=${() => c.open(item)}
                >
                  ${columns.map((entry) => this.cell(item, entry))}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  /** Sortable column headers carry aria-sort; the rest are plain. */
  private header(entry: Column, label: string) {
    const c = this.controller;
    const classes = [
      entry.kind === "numeric" ? "is-numeric" : "",
      entry.kind === "mark" || entry.kind === "action" ? "is-compact" : "",
      entry.sticky ? "is-sticky" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const active = entry.sort && c.sort === entry.sort;
    if (!entry.sort)
      return html`
        <th scope="col" class=${classes || nothing}>${label}</th>
      `;
    return html`
      <th
        scope="col"
        class=${classes || nothing}
        aria-sort=${active ? (c.order === "asc" ? "ascending" : "descending") : nothing}
      >
        <button class="table-sort" type="button" @click=${() => c.requestSort(entry.sort)}>
          <span class="truncate">${label}</span>
          ${icon("arrow_upward", 18)}
        </button>
      </th>
    `;
  }

  private cell(item: Item, entry: Column) {
    const c = this.controller;
    const key = entry.key;
    const classes = [
      entry.kind === "numeric" ? "is-numeric" : "",
      entry.kind === "mark" || entry.kind === "action" ? "is-compact" : "",
      entry.sticky ? "is-sticky" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const wrap = (value: unknown) => html`
      <td class=${classes || nothing} style=${CELL_MAX[key] ? `--cell-max:${CELL_MAX[key]}` : nothing}>${value}</td>
    `;
    const characterIds: number[] = c.itemCharacterIds(item);
    const characterId = characterIds[0] || Number(item.characterId || 0);
    const character = c.character(characterId);
    const bandId = Number(item.bandId || (c.profile.presentation === "song" ? 0 : character?.bandId) || 0);
    const band = c.band(bandId);

    if (key === "title") {
      const image = c.image(item);
      // The identity cell holds the row's control: one real button per row,
      // so the table is operable without relying on the row click.
      return html`
        <th scope="row" class=${classes || nothing} style=${CELL_MAX.title ? `--cell-max:${CELL_MAX.title}` : nothing}>
          <button class="table-entity state-layer" type="button" @click=${() => c.open(item)}>
            ${
              image
                ? html`
                    <span class="table-entity__media">
                      <img src=${image} alt="" loading="lazy" decoding="async" />
                    </span>
                  `
                : nothing
            }
            <span class="table-entity__copy">
              <span class="table-entity__name" lang=${c.itemTitleLanguage(item)}>${c.itemTitle(item)}</span>
              ${
                c.tileDescription(item)
                  ? html`
                      <span class="table-entity__sub">${c.tileDescription(item)}</span>
                    `
                  : nothing
              }
            </span>
          </button>
        </th>
      `;
    }
    if (key === "character" || key === "characters") {
      const ids: number[] = characterIds;
      return wrap(html`
        <span class="table-entity">
          ${c.characterAvatars(ids)}
          <span class="table-entity__copy">
            <span class="table-entity__name">${c.formatList(ids.map((id: number) => c.characterName(id))) || "—"}</span>
          </span>
        </span>
      `);
    }
    if (key === "band")
      return wrap(html`
        <span class="table-entity">
          ${
            band?.logo || band?.icon
              ? html`
                  <span class="table-entity__media">
                    <img src=${String(band.logo || band.icon)} alt="" loading="lazy" decoding="async" />
                  </span>
                `
              : nothing
          }
          <span class="table-entity__copy">
            <span class="table-entity__name">
              ${c.profile.presentation === "song" ? c.itemArtistContent(item) : c.bandName(bandId)}
            </span>
          </span>
        </span>
      `);
    if (key === "attribute") {
      const song = c.profile.presentation === "song";
      const source = c.attributeMark(song ? item.musicType : item.cardType, song);
      const text = c.fieldValue(item, song ? "musicType" : "cardType");
      return wrap(
        source
          ? html`
              <img src=${source} alt=${text} title=${text} width="24" height="24" />
            `
          : html`
              ${text || "—"}
            `,
      );
    }
    if (key === "rarity") {
      const source = c.rarityMark(item.rarity);
      const text = c.fieldValue(item, "rarity");
      return wrap(
        source
          ? html`
              <img src=${source} alt=${text} title=${text} width="24" height="24" />
            `
          : text || "—",
      );
    }
    if (["performance", "technique", "visual"].includes(key)) {
      const value = c.stat(item, key);
      return wrap(c.profile.presentation === "support" ? `${(value / 100).toLocaleString()}%` : value.toLocaleString());
    }
    if (key === "total") return wrap(c.total(item).toLocaleString());
    if (key === "skills") {
      const skills =
        item.resolvedSkills && typeof item.resolvedSkills === "object"
          ? Object.entries(item.resolvedSkills as Item).filter(([, value]) => value)
          : [];
      const labels: Record<string, string> = {
        leader: "Leader",
        live: "Live",
        gekisou: "Gekisou",
        support: "Support",
        gekisouSupport: "Gekisou support",
      };
      return wrap(
        skills.length
          ? html`
              <span class="cluster" style="--cluster-gap:4px">
                ${skills.slice(0, 3).map(([name, value]) => {
                  const skill = value as Item;
                  const mark = String(skill.icon || skill.image || "");
                  return html`
                    <span class="chip chip--static chip--assist" style="--chip-height:24px">
                      ${
                        mark
                          ? html`
                              <span class="chip__avatar" style="width:16px;height:16px">
                                <img src=${mark} alt="" />
                              </span>
                            `
                          : nothing
                      }
                      <span class="chip__label">${c.label(`${name}Skill`, labels[name] || name)}</span>
                    </span>
                  `;
                })}
              </span>
            `
          : "—",
      );
    }
    if (key === "play")
      return wrap(
        item.musicUrl
          ? html`
              <button
                class="icon-button icon-button--small"
                type="button"
                @click=${(event: Event) => {
                  event.stopPropagation();
                  void c.toggleSong(c.itemId(item), String(item.musicUrl));
                }}
                aria-label=${c.label("play", "Play")}
                title=${c.label("play", "Play")}
              >
                ${icon("play_arrow", 20)}
              </button>
            `
          : nothing,
      );
    if (key === "chart") {
      const rows = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
      return wrap(
        rows.some((row) => row.file)
          ? html`
              <button
                class="icon-button icon-button--small"
                type="button"
                @click=${(event: Event) => {
                  event.stopPropagation();
                  c.open(item);
                  void c.openChart();
                }}
                aria-label=${c.label("chart", "Chart")}
                title=${c.label("chart", "Chart")}
              >
                ${icon("bar_chart", 20)}
              </button>
            `
          : nothing,
      );
    }
    if (key === "difficulty")
      return wrap(
        difficultyPicker({
          rows: Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [],
          selected: c.selectedSongDifficulty,
          locale: c.settings.locale,
          compact: true,
          onSelect: (key) => c.selectSongDifficulty(key),
        }),
      );
    if (key === "category") {
      const value =
        c.profile.presentation === "song"
          ? c.fieldValue(item, "musicCategories")
          : c.displayValue(item.type || item.category);
      return wrap(value ? c.label(value, value) : "—");
    }
    if (["time", "score", "eff", "bpm", "n", "nps", "sr"].includes(key)) return wrap(c.songListMeta(item, key));
    if (key === "release") return wrap(c.release(item.releasedAt || item.publishedAt || item.publicStartAt) || "—");
    if (key === "subtitle") return wrap(c.localized(item.subTitle) || "—");
    if (key === "part") return wrap(c.localized(item.bandPart) || "—");
    if (key === "school") return wrap(c.localized(item.school) || "—");
    if (key === "composer" || key === "lyricist" || key === "arranger")
      return wrap(html`
        <span lang=${c.localizedLanguage(item[key])}>${c.localized(item[key]) || "—"}</span>
      `);
    if (key === "order") return wrap(c.displayValue(item.displayOrder) || "—");
    if (key === "levels") return wrap(Array.isArray(item.levels) ? item.levels.length : 0);
    if (key === "type") return wrap(c.localized(item.itemTypeName) || "—");
    if (key === "maximum") return wrap(c.displayValue(item.max) || "—");
    if (key === "value") return wrap(c.displayValue(item.value) || "—");
    return wrap(c.fieldValue(item, key) || "—");
  }
}

customElements.define("catalog-table-view", CatalogTable);

export type { Column as CatalogTableColumn };
