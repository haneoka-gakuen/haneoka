import { LitElement, html, nothing } from "lit";

type Item = Record<string, unknown>;
type Controller = Record<string, any>;

const columns: Record<string, string[]> = {
  member: "title character band attribute rarity performance technique visual total skills category release".split(" "),
  support: "title character band attribute rarity performance technique visual total skills release".split(" "),
  character: "title band part school".split(" "),
  comic: "title subtitle characters release".split(" "),
  stamp: "title characters release".split(" "),
  song: "title play chart attribute band difficulty time score eff bpm n nps sr category composer lyricist arranger release".split(
    " ",
  ),
  band: ["title"],
  "band-item": "title band order levels".split(" "),
  item: "title type maximum value".split(" "),
};
const widths: Record<string, string> = {
  title: "minmax(240px,2fr)",
  character: "minmax(150px,1fr)",
  characters: "minmax(220px,1.4fr)",
  band: "minmax(150px,1fr)",
  attribute: "72px",
  rarity: "72px",
  performance: "96px",
  technique: "96px",
  visual: "96px",
  total: "104px",
  skills: "minmax(180px,1.2fr)",
  category: "112px",
  release: "132px",
  part: "120px",
  school: "minmax(180px,1fr)",
  subtitle: "minmax(220px,1.4fr)",
  play: "56px",
  chart: "56px",
  difficulty: "220px",
  time: "88px",
  score: "104px",
  eff: "96px",
  bpm: "84px",
  n: "84px",
  nps: "84px",
  sr: "84px",
  composer: "minmax(150px,1fr)",
  lyricist: "minmax(150px,1fr)",
  arranger: "minmax(150px,1fr)",
  order: "88px",
  levels: "88px",
  type: "minmax(160px,1fr)",
  maximum: "96px",
  value: "96px",
};

export class CatalogTable extends LitElement {
  static properties = { controller: { attribute: false }, items: { attribute: false } };
  declare controller: Controller;
  declare items: Item[];
  createRenderRoot() {
    return this;
  }
  render() {
    const c = this.controller;
    if (!c) return nothing;
    const keys = columns[c.profile.presentation] || columns.item;
    return html`
      <div class="catalog-table" role="table" style=${`--table-columns:${keys.map((key) => widths[key]).join(" ")}`}>
        <header role="row">
          ${keys.map(
            (key) => html`
              <span role="columnheader">${c.detailLabel(key)}</span>
            `,
          )}
        </header>
        ${(this.items || []).map(
          (item) => html`
            <div
              class="catalog-table__row"
              role="row"
              tabindex="0"
              @click=${() => c.open(item)}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === "Enter" || event.key === " ") c.open(item);
              }}
            >
              ${keys.map((key) => this.cell(item, key))}
            </div>
          `,
        )}
      </div>
    `;
  }
  private cell(item: Item, key: string) {
    const c = this.controller;
    const image = c.image(item);
    const characterId = Number(item.characterId || 0);
    const character = c.character(characterId);
    const bandId = Number(item.bandId || character?.bandId || 0);
    const band = c.band(bandId);
    const wrap = (value: unknown, className = "") => html`
      <span class=${className} role="cell">${value}</span>
    `;
    if (key === "title")
      return wrap(
        html`
          ${
            image
              ? html`
                  <img src=${image} alt="" loading="lazy" decoding="async" />
                `
              : nothing
          }
          <strong>${c.itemTitle(item)}</strong>
        `,
        "catalog-table__primary",
      );
    if (key === "character")
      return wrap(
        html`
          ${
            character?.faceImage
              ? html`
                  <img src=${String(character.faceImage)} alt="" loading="lazy" decoding="async" />
                `
              : nothing
          }
          <span>${c.characterName(characterId)}</span>
        `,
        "catalog-table__entity",
      );
    if (key === "characters") {
      const ids: number[] = c.itemCharacterIds(item);
      return wrap(
        html`
          ${c.characterAvatars(ids)}
          <span>${ids.map((id) => c.characterName(id)).join("、") || "—"}</span>
        `,
        "catalog-table__entity",
      );
    }
    if (key === "band")
      return wrap(
        html`
          ${
            band?.logo || band?.icon
              ? html`
                  <img src=${String(band.logo || band.icon)} alt="" loading="lazy" decoding="async" />
                `
              : nothing
          }
          <span>${c.bandName(bandId)}</span>
        `,
        "catalog-table__entity",
      );
    if (key === "attribute") {
      const song = c.profile.presentation === "song";
      const source = c.attributeMark(song ? item.musicType : item.cardType, song);
      return wrap(
        source
          ? html`
              <img src=${source} alt=${c.fieldValue(item, song ? "musicType" : "cardType")} />
            `
          : "—",
        "catalog-table__mark",
      );
    }
    if (key === "rarity") {
      const source = c.rarityMark(item.rarity);
      return wrap(
        source
          ? html`
              <img src=${source} alt=${c.fieldValue(item, "rarity")} />
            `
          : "—",
        "catalog-table__mark",
      );
    }
    if (["performance", "technique", "visual"].includes(key)) {
      const value = c.stat(item, key);
      return wrap(
        c.profile.presentation === "support" ? `${(value / 100).toLocaleString()}%` : value.toLocaleString(),
        "catalog-table__number",
      );
    }
    if (key === "total") return wrap(c.total(item).toLocaleString(), "catalog-table__number");
    if (key === "skills") {
      const skills =
        item.resolvedSkills && typeof item.resolvedSkills === "object"
          ? Object.entries(item.resolvedSkills as Item).filter(([, value]) => value)
          : [];
      return wrap(
        skills.length
          ? html`
              ${skills.slice(0, 3).map(([name, value]) => {
                const skill = value as Item;
                const icon = String(skill.icon || skill.image || "");
                const labels: Record<string, string> = {
                  leader: "Leader",
                  live: "Live",
                  gekisou: "Gekisou",
                  support: "Support",
                  gekisouSupport: "Gekisou support",
                };
                return html`
                  <span>
                    ${
                      icon
                        ? html`
                            <img src=${icon} alt="" />
                          `
                        : nothing
                    }${c.label(`${name}Skill`, labels[name] || name)}
                  </span>
                `;
              })}
            `
          : "—",
        "catalog-table__skills",
      );
    }
    if (key === "play")
      return wrap(
        item.musicUrl
          ? html`
              <button
                class="icon-button"
                @click=${(event: Event) => {
                  event.stopPropagation();
                  void c.toggleSong(c.itemId(item), String(item.musicUrl));
                }}
                aria-label=${c.label("play", "Play")}
              >
                <svg class="material-icon" width="20" height="20"><use href="/icons.svg#play_arrow"></use></svg>
              </button>
            `
          : "—",
      );
    if (key === "chart") {
      const rows = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
      return wrap(
        rows.some((row) => row.file)
          ? html`
              <button
                class="icon-button"
                @click=${(event: Event) => {
                  event.stopPropagation();
                  c.open(item);
                  void c.openChart();
                }}
                aria-label=${c.label("chart", "Chart")}
              >
                <svg class="material-icon" width="20" height="20"><use href="/icons.svg#bar_chart"></use></svg>
              </button>
            `
          : "—",
      );
    }
    if (key === "difficulty") {
      const levels = (Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : []).map((row) =>
        Number(row.displayLevel || 0),
      );
      return wrap(html`
        <span class="song-levels">
          ${levels.map(
            (level, index) => html`
              <i class=${`difficulty-${index}`}>${level || "—"}</i>
            `,
          )}
        </span>
      `);
    }
    if (key === "category") {
      const value =
        c.profile.presentation === "song"
          ? c.fieldValue(item, "musicCategories")
          : c.displayValue(item.type || item.category);
      return wrap(value ? c.label(value, value) : "—");
    }
    if (["time", "score", "eff", "bpm", "n", "nps", "sr"].includes(key))
      return wrap(c.songListMeta(item, key), "catalog-table__number");
    if (key === "release") return wrap(c.release(item.releasedAt || item.publishedAt || item.publicStartAt) || "—");
    if (key === "subtitle") return wrap(c.localized(item.subTitle) || "—");
    if (key === "part") return wrap(c.localized(item.bandPart) || "—");
    if (key === "school") return wrap(c.localized(item.school) || "—");
    if (key === "composer" || key === "lyricist" || key === "arranger") return wrap(c.localized(item[key]) || "—");
    if (key === "order") return wrap(c.displayValue(item.displayOrder) || "—", "catalog-table__number");
    if (key === "levels") return wrap(Array.isArray(item.levels) ? item.levels.length : 0, "catalog-table__number");
    if (key === "type") return wrap(c.localized(item.itemTypeName) || "—");
    if (key === "maximum") return wrap(c.displayValue(item.max) || "—", "catalog-table__number");
    if (key === "value") return wrap(c.displayValue(item.value) || "—", "catalog-table__number");
    return wrap(c.fieldValue(item, key) || "—");
  }
}

customElements.define("catalog-table-view", CatalogTable);
