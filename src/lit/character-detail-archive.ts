import "./character-voices";
import { modelTile } from "./ui/model-tile";
import { resolveLocalizedText } from "../lib/localized-text";
import { songTitle } from "../lib/song-display";
import { LitElement, html, nothing } from "lit";
import { characterProfile } from "./shared/character-profile";
import { characterPair } from "./ui/character-pair";
import { renderDetailSectionHeading, type DetailSectionKind } from "./shared/detail-section-heading";
import type { GridIdentityAdornment } from "./shared/grid-identity";
import { tile } from "./ui/tile";
import { storyCastMedia } from "./ui/story-media";
import { LazyImages, nextImageCandidate } from "./ui/lazy-images";
import { rovingKeydown } from "./ui/controls";
import "../styles/character-detail.css";

type Item = Record<string, unknown>;
type Field = { key: string; value: string };
interface Controller {
  detailAux: Item;
  renderDetailMedia(item: Item): unknown;
  label(key: string, fallback: string): string;
  itemCharacterIds(item: Item): number[];
  localized(value: unknown): string;
  itemTitle(item: Item): string;
  detailLabel(key: string): string;
  characterName(id: number): string;
  bandName(id: number): string;
  character(id: number): Item | undefined;
  band(id: number): Item | undefined;
  imageForLocale(source: string): string;
  imageForRelated(item: Item, route: string): string;
  relatedImageCandidates(item: Item, route: string): string[];
  relatedTitle(item: Item, route: string): string;
  relatedId(item: Item, route: string): string;
  relatedParam(route: string): string;
  characterAvatars(ids: number[]): GridIdentityAdornment;
  formatList(values: unknown[], type?: Intl.ListFormatOptions["type"]): string;
  attributeMark(value: unknown, live?: boolean): string;
  rarityMark(value: unknown): string;
}

const values = (value: unknown, key?: string): Item[] => {
  const source = key && value && typeof value === "object" ? (value as Item)[key] : value;
  if (!source || typeof source !== "object") return [];
  return Object.values(source as Item).filter((entry): entry is Item => !!entry && typeof entry === "object");
};

export class CharacterDetailArchive extends LitElement {
  static properties = {
    controller: { attribute: false },
    item: { attribute: false },
    fields: { attribute: false },
    section: { type: String },
    selectedPartner: { state: true },
    selectedMissionType: { state: true },
  };
  declare controller: Controller;
  declare item: Item;
  declare fields: Field[];
  declare section: string;
  declare selectedPartner: number;
  declare selectedMissionType: number;
  constructor() {
    super();
    this.controller = {} as Controller;
    this.item = {};
    this.fields = [];
    this.section = "profile";
    this.selectedPartner = 0;
    this.selectedMissionType = 0;
  }
  createRenderRoot() {
    return this;
  }
  private lazyImages = new LazyImages();
  protected updated() {
    this.lazyImages.observe(this);
    const tabs = this.querySelector<HTMLElement>(".character-detail-tabs");
    const selected = tabs?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (tabs && selected) {
      const offset = selected.getBoundingClientRect().left - tabs.getBoundingClientRect().left;
      if (offset < 0 || offset + selected.offsetWidth > tabs.clientWidth) tabs.scrollLeft += offset;
    }
  }
  private collections() {
    const c = this.controller;
    const id = Number(this.item.characterId || 0);
    const numeric = (key: string) => (left: Item, right: Item) =>
      Number(left[key] || 0) - Number(right[key] || 0) ||
      String(left[key] || "").localeCompare(String(right[key] || ""), "en", { numeric: true });
    return {
      cards: values(c.detailAux.cards)
        .filter((entry) => Number(entry.characterId) === id)
        .sort(numeric("cardId")),
      supports: values(c.detailAux["support-cards"])
        .filter((entry) => c.itemCharacterIds(entry).includes(id))
        .sort(numeric("supportCardId")),
      stamps: values(c.detailAux.stamps)
        .filter((entry) => c.itemCharacterIds(entry).includes(id))
        .sort(numeric("stampId")),
      stories: values(c.detailAux.stories, "episodes")
        .filter((entry) => c.itemCharacterIds(entry).includes(id))
        .sort(
          (left, right) =>
            this.storyCategoryOrder(left) - this.storyCategoryOrder(right) ||
            Number(left.chapterId || 0) - Number(right.chapterId || 0) ||
            Number(left.storySort || 0) - Number(right.storySort || 0) ||
            String(left.storyId || "").localeCompare(String(right.storyId || ""), "en", { numeric: true }),
        ),
      live2d: (values(c.detailAux.live2d, "models").length
        ? values(c.detailAux.live2d, "models")
        : values(c.detailAux.live2d)
      )
        .filter((entry) => Number(entry.characterId) === id)
        .sort((left, right) =>
          String(left.live2dKey || "").localeCompare(String(right.live2dKey || ""), "en", { numeric: true }),
        ),
      songs: values(c.detailAux.songs)
        .filter((entry) => {
          const bandId = Number(this.item.bandId || 0);
          const bandIds = Array.isArray(entry.bandIds) ? entry.bandIds.map(Number) : [Number(entry.bandId || 0)];
          return bandIds.includes(bandId);
        })
        .sort(numeric("musicId")),
      voices: values(c.detailAux.voices, "entries")
        .filter((entry) => c.itemCharacterIds(entry).includes(id))
        .sort((left, right) =>
          String(left.voiceKey || "").localeCompare(String(right.voiceKey || ""), "en", { numeric: true }),
        ),
      friendships: values(c.detailAux.friendships, "friendships")
        .filter((entry) => c.itemCharacterIds(entry).includes(id))
        .sort(numeric("friendshipId")),
      missions: values(c.detailAux["character-missions"], "missions").sort(
        (left, right) =>
          Number(left.missionType || 0) - Number(right.missionType || 0) ||
          Number(left.priority || 0) - Number(right.priority || 0) ||
          Number(left.missionId || 0) - Number(right.missionId || 0),
      ),
    };
  }
  private choose(section: string) {
    this.dispatchEvent(new CustomEvent("section-change", { detail: section, bubbles: true, composed: true }));
  }
  disconnectedCallback() {
    this.lazyImages.disconnect();
    super.disconnectedCallback();
  }
  private storyCategory(entry: Item): "band" | "link" | "home" | "afterlive" | "tutorial" {
    const key = String(entry.chapterKey || "").toLocaleLowerCase();
    if (key.includes("linkstory")) return "link";
    if (key.includes("asset_home")) return "home";
    if (key.includes("afterlive")) return "afterlive";
    if (key.includes("tutorial")) return "tutorial";
    return "band";
  }
  private storyCategoryOrder(entry: Item) {
    return ["band", "link", "home", "afterlive", "tutorial"].indexOf(this.storyCategory(entry));
  }
  private storyChapter(entry: Item) {
    const chapters = values(this.controller.detailAux.stories, "chapters");
    return (
      chapters.find((chapter) => Number(chapter.chapterId) === Number(entry.chapterId)) ||
      chapters.find((chapter) =>
        (Array.isArray(chapter.episodes) ? chapter.episodes : []).map(String).includes(String(entry.storyId)),
      )
    );
  }
  private storyHomeSpot(entry: Item) {
    return values(this.controller.detailAux.stories, "homeSpots").find((spot) =>
      (Array.isArray(spot.talks) ? (spot.talks as Item[]) : []).some(
        (talk) => String(talk.storyKey || "") === String(entry.storyId || entry.storyKey || ""),
      ),
    );
  }
  private storyVisual(entry: Item) {
    const category = this.storyCategory(entry);
    const chapter = this.storyChapter(entry);
    const spot = category === "home" ? this.storyHomeSpot(entry) : undefined;
    const image =
      category === "home"
        ? String((spot?.spine as Item | undefined)?.backgroundPreview || "")
        : category === "afterlive"
          ? ""
          : String(entry.banner || entry.image || chapter?.banner || chapter?.image || "");
    const bandId = Number(spot?.bandId || entry.bandId || chapter?.bandId || 0);
    const band = this.controller.band(bandId);
    return { category, image, logo: String(band?.logo || band?.icon || "") };
  }
  private storyLabel(category: "band" | "link" | "home" | "afterlive" | "tutorial") {
    const labels = {
      band: this.controller.label("bandStories", "Band Stories"),
      link: this.controller.label("linkStories", "Bond Stories"),
      home: this.controller.label("homeStories", "Home Stories"),
      afterlive: this.controller.label("afterliveStories", "Afterlive Stories"),
      tutorial: this.controller.label("tutorialStories", "Tutorial Stories"),
    };
    return labels[category];
  }
  private storyGroups(entries: Item[]) {
    return (["band", "link", "home", "afterlive", "tutorial"] as const).flatMap((category) => {
      const items = entries.filter((entry) => this.storyCategory(entry) === category);
      return items.length ? [{ category, label: this.storyLabel(category), items }] : [];
    });
  }
  private songCategory(entry: Item) {
    const names = ["", "original", "virtual", "jpop", "anime", "game"];
    return this.controller.formatList(
      (Array.isArray(entry.musicCategories) ? entry.musicCategories : [])
        .map(Number)
        .map((id) => this.controller.label(names[id] || "", names[id] || ""))
        .filter(Boolean),
      "unit",
    );
  }
  private relatedTile(entry: Item, route: string, characterId: number) {
    const c = this.controller;
    if (route === "live2d")
      return modelTile({
        model: entry,
        character: c.character(characterId),
        locale: document.documentElement.dataset.locale || "ja",
        href: `/catalog/live2d/?model=${encodeURIComponent(c.relatedId(entry, route))}`,
      });
    const kind =
      route === "member-cards"
        ? "member"
        : route === "support-cards"
          ? "support"
          : route === "songs"
            ? "song"
            : route === "stamps"
              ? "stamp"
              : route === "live2d"
                ? "live2d"
                : "story";
    const storyVisual = route === "stories" ? this.storyVisual(entry) : undefined;
    const imageCandidates = storyVisual?.image ? [storyVisual.image] : c.relatedImageCandidates(entry, route);
    const source = imageCandidates[0] || "";
    const ids = c.itemCharacterIds(entry);
    const description =
      route === "member-cards" || route === "support-cards"
        ? c.formatList(ids.map((id) => c.characterName(id)))
        : route === "songs"
          ? c.bandName(Number(entry.bandId || 0))
          : route === "live2d"
            ? c.characterName(characterId)
            : route === "stories"
              ? ["band", "tutorial"].includes(storyVisual?.category || "")
                ? c.localized(entry.chapterName) || c.localized(this.storyChapter(entry)?.chapterName)
                : storyVisual?.category === "afterlive"
                  ? `${c.label("friendship", "Friendship")} ${entry.unlockCharacterFriendshipLevel == null ? "—" : `Lv.${entry.unlockCharacterFriendshipLevel}`}`
                  : ""
              : c.formatList(ids.map((id) => c.characterName(id))) || c.localized(entry.chapterName);
    const adornment =
      route === "stamps" && ids.length
        ? c.characterAvatars(ids)
        : (route === "member-cards" || route === "support-cards") && ids.length
          ? c.characterAvatars(ids)
          : route === "songs" && c.band(Number(entry.bandId || 0))?.icon
            ? html`
                <img src=${c.imageForLocale(String(c.band(Number(entry.bandId || 0))?.icon))} alt="" />
              `
            : route === "live2d" && c.character(characterId)?.faceImage
              ? html`
                  <img src=${c.imageForLocale(String(c.character(characterId)?.faceImage))} alt="" />
                `
              : nothing;
    const attribute = route === "songs" ? c.attributeMark(entry.musicType, true) : c.attributeMark(entry.cardType);
    const rarity = c.rarityMark(entry.rarity);
    const hrefRoute = route === "stories" ? `stories/${storyVisual?.category || "band"}` : route;
    return tile({
      kind,
      title: c.relatedTitle(entry, route),
      titleLanguage:
        route === "songs"
          ? songTitle(entry, document.documentElement.dataset.locale || "ja").locale
          : resolveLocalizedText(
              entry.prefix || entry.name || entry.title,
              document.documentElement.dataset.locale || "ja",
            ).locale,
      subtitle: description,
      adornment,
      label: c.relatedTitle(entry, route),
      image: source,
      imageCandidates,
      href: `/catalog/${hrefRoute}?${c.relatedParam(route)}=${encodeURIComponent(c.relatedId(entry, route))}`,
      fit: "contain",
      natural:
        route !== "live2d" &&
        (route !== "stories" || (Boolean(source) && !["home", "afterlive"].includes(storyVisual?.category || ""))),
      onImageError: nextImageCandidate,
      media:
        route === "stories" && ["afterlive", "home"].includes(storyVisual?.category || "")
          ? storyCastMedia(
              ids.map((id) => ({ name: c.characterName(id), image: String(c.character(id)?.faceImage || "") })),
              storyVisual?.category === "home" ? source : "",
            )
          : undefined,
      marks: [
        attribute && ["member", "support", "song"].includes(kind) ? { at: "start", image: attribute } : null,
        rarity && ["member", "support"].includes(kind) ? { at: "end", image: rarity } : null,
        route === "songs" ? { at: "bottom-start", text: this.songCategory(entry) } : null,
      ],
    });
  }

  private grid(title: string, kind: DetailSectionKind, route: string, entries: Item[], characterId: number) {
    const c = this.controller;
    return html`
      <section class="detail-section character-detail-panel-group">
        ${renderDetailSectionHeading(title, kind, { count: entries.length })}
        ${
          entries.length
            ? html`
                <div
                  class=${`collection collection--${route === "member-cards" ? "member" : route === "support-cards" ? "support" : route === "songs" ? "song" : route === "stamps" ? "stamp" : route === "live2d" ? "model" : "story"}`}
                >
                  ${entries.map((entry) => this.relatedTile(entry, route, characterId))}
                </div>
              `
            : html`
                <div class="state state--inline"><span>${c.label("empty", "No results")}</span></div>
              `
        }
      </section>
    `;
  }
  private sectionHeading(title: string, kind: DetailSectionKind, count?: number) {
    return renderDetailSectionHeading(title, kind, { count });
  }
  render() {
    const c = this.controller;
    const item = this.item;
    const id = Number(item.characterId || 0);
    const data = this.collections();
    const tabs = [
      ["profile", "contact_page", c.label("profile", "Profile"), 0],
      ["cards", "photo_library", c.label("cards", "Cards"), data.cards.length + data.supports.length],
      ["stamps", "sticky_note_2", c.label("stamps", "Stamps"), data.stamps.length],
      ["voices", "mic", c.label("voices", "Voices"), data.voices.length],
      ["story", "chat", c.label("story", "Story"), data.stories.length],
      ["friendships", "handshake", c.label("characterBonds", "Character Bonds"), data.friendships.length],
      ["missions", "checklist", c.label("missions", "Missions"), data.missions.length],
      ["live2d", "accessibility_new", "Live2D", data.live2d.length],
      ["songs", "music_note", c.label("songs", "Songs"), data.songs.length],
    ] as const;
    const active = tabs.some(([section]) => section === this.section) ? this.section : "profile";
    const panel = (() => {
      if (active === "profile")
        return characterProfile({
          item,
          locale: document.documentElement.dataset.locale || "ja",
          name: c.itemTitle(item),
          part: String(item.bandPart || ""),
          description: c.localized(item.description),
          catchCopy: c.localized(item.catchCopy),
          voiceActor: c.localized(item.voiceActor),
          alternateName: c.localized(item.englishName),
          bandLogo: String(c.band(Number(item.bandId || 0))?.logo || ""),
          gallery: c.renderDetailMedia(item),
          fields: this.fields
            .filter((field) => !["voiceActor", "bandPart", "englishName"].includes(field.key))
            .map((field) => ({
              label: c.detailLabel(field.key),
              value: field.value,
              language: resolveLocalizedText(item[field.key], document.documentElement.dataset.locale || "ja").locale,
            })),
        });
      if (active === "cards")
        return html`
          <section class="detail-section character-detail-deferred-section">
            ${this.sectionHeading(c.label("cards", "Cards"), "cards", data.cards.length + data.supports.length)}
            <div class="character-detail-groups">
              ${this.grid(c.label("memberCards", "Member cards"), "memberCards", "member-cards", data.cards, id)}${this.grid(c.label("supportCards", "Support cards"), "supportCards", "support-cards", data.supports, id)}
            </div>
          </section>
        `;
      if (active === "stamps") return this.grid(c.label("stamps", "Stamps"), "stamps", "stamps", data.stamps, id);
      if (active === "story")
        return html`
          <section class="detail-section character-detail-deferred-section">
            ${this.sectionHeading(c.label("story", "Story"), "stories", data.stories.length)}
            <div class="character-detail-groups">
              ${this.storyGroups(data.stories).map((group) => this.grid(group.label, "stories", "stories", group.items, id))}
            </div>
          </section>
        `;
      if (active === "live2d") return this.grid("Live2D", "live2d", "live2d", data.live2d, id);
      if (active === "songs") return this.grid(c.label("songs", "Songs"), "songs", "songs", data.songs, id);
      if (active === "voices")
        return html`
          <character-voices
            .entries=${data.voices}
            .characters=${values(c.detailAux.characters)}
            .characterId=${id}
            locale=${document.documentElement.dataset.locale || "ja"}
          ></character-voices>
        `;
      if (active === "friendships") {
        const partners = values(c.detailAux.characters).filter((entry) => Number(entry.characterId) !== id);
        const partnerId =
          this.selectedPartner === -1 ? 0 : this.selectedPartner || Number(partners[0]?.characterId || 0);
        const friendship = data.friendships.find((entry) => c.itemCharacterIds(entry).includes(partnerId));
        const stories = data.stories.filter(
          (entry) =>
            this.storyCategory(entry) === "link" && (!partnerId || c.itemCharacterIds(entry).includes(partnerId)),
        );
        const rewards = friendship && Array.isArray(friendship.rewards) ? (friendship.rewards as Item[]) : [];
        return html`
          <section class="detail-section character-detail-deferred-section">
            ${this.sectionHeading(c.label("characterBonds", "Character Bonds"), "friendships", data.friendships.length)}
            <div class="character-friendship-workspace">
              ${characterPair({
                locale: document.documentElement.dataset.locale || "ja",
                characters: values(c.detailAux.characters).map((character) => ({
                  value: String(character.characterId),
                  label: c.characterName(Number(character.characterId)),
                  image: String(character.faceImage || ""),
                  bandId: Number(character.bandId),
                })),
                bands: [...new Set(values(c.detailAux.characters).map((character) => Number(character.bandId)))]
                  .filter(Boolean)
                  .map((bandId) => ({
                    id: bandId,
                    label: c.bandName(bandId),
                    image: String(c.band(bandId)?.logo || c.band(bandId)?.icon || ""),
                  })),
                first: String(id),
                second: partnerId ? String(partnerId) : "",
                onSecond: (value) => {
                  this.selectedPartner = value ? Number(value) : -1;
                },
              })}
              ${
                friendship
                  ? html`
                      <a
                        class="character-friendship-banner"
                        href=${`/catalog/stories/link?first=${id}&second=${partnerId}`}
                      >
                        ${
                          friendship.storyBanner
                            ? html`
                                <img src=${c.imageForLocale(String(friendship.storyBanner))} alt="" />
                              `
                            : nothing
                        }
                        <span>
                          <strong>${c.characterName(id)} × ${c.characterName(partnerId)}</strong>
                          <small>${c.label("characterBonds", "Character Bonds")}</small>
                        </span>
                      </a>
                    `
                  : nothing
              }${stories.length ? this.grid(c.label("story", "Story"), "stories", "stories", stories, id) : nothing}${
                rewards.length
                  ? html`
                      <section class="detail-section">
                        ${renderDetailSectionHeading(c.label("rewards", "Rewards"), "rewards", {
                          count: rewards.length,
                        })}
                        <div class="reference-list">
                          ${rewards.map((row) => {
                            const reward = (row.reward as Item | undefined) || row;
                            const resolved = (reward.resolved as Item | undefined) || {};
                            return html`
                              <div>
                                ${
                                  resolved.image
                                    ? html`
                                        <img src=${c.imageForLocale(String(resolved.image))} alt="" />
                                      `
                                    : html`
                                        <svg class="material-icon" width="22" height="22">
                                          <use href="/icons.svg#redeem"></use>
                                        </svg>
                                      `
                                }
                                <span>
                                  <strong>${c.localized(resolved.name) || c.localized(reward.resourceTypeName)}</strong>
                                  <small>${c.label("friendship", "Friendship")} ${String(row.rank || "")}</small>
                                </span>
                                <b>×${Number(reward.resourceCount || 0).toLocaleString()}</b>
                              </div>
                            `;
                          })}
                        </div>
                      </section>
                    `
                  : nothing
              }${
                !friendship && !stories.length && !rewards.length
                  ? html`
                      <div class="state state--inline"><span>${c.label("empty", "No results")}</span></div>
                    `
                  : nothing
              }
            </div>
          </section>
        `;
      }
      const missionGroups = [
        ...data.missions.reduce((groups, mission) => {
          const type = Number(mission.missionType || 0);
          const entries = groups.get(type) || [];
          entries.push(mission);
          groups.set(type, entries);
          return groups;
        }, new Map<number, Item[]>()),
      ].sort(([left], [right]) => left - right);
      const missionType = missionGroups.some(([type]) => type === this.selectedMissionType)
        ? this.selectedMissionType
        : missionGroups[0]?.[0] || 0;
      const missions = missionGroups.find(([type]) => type === missionType)?.[1] || [];
      return html`
        <section class="detail-section character-detail-deferred-section">
          ${this.sectionHeading(c.label("missions", "Missions"), "missions", data.missions.length)}
          <div class="character-mission-workspace">
            <header>
              <md-outlined-select
                label=${c.label("type", "Type")}
                value=${String(missionType)}
                @change=${(event: Event) => {
                  this.selectedMissionType = Number((event.target as HTMLElement & { value?: string }).value || 0);
                }}
              >
                ${missionGroups.map(
                  ([type, entries]) => html`
                    <md-select-option value=${String(type)} ?selected=${type === missionType}>
                      <div slot="headline">
                        ${c.localized(entries[0]?.title) || String(entries[0]?.missionTypeName || type)}
                        (${entries.length})
                      </div>
                    </md-select-option>
                  `,
                )}
              </md-outlined-select>
            </header>
            <div class="character-mission-list">
              ${missions.map((entry) => {
                const rewards = Array.isArray(entry.rewards) ? (entry.rewards as Item[]) : [];
                return html`
                  <article>
                    <span>
                      <strong>${c.localized(entry.title) || String(entry.missionTypeName || "")}</strong>
                      <small>
                        ${c
                          .localized(entry.description)
                          .replaceAll("{0}", c.itemTitle(item))
                          .replaceAll("{1}", String(entry.achievementCount || ""))
                          .replaceAll("{2}", String(entry.value || ""))}
                      </small>
                    </span>
                    <div class="character-mission-rewards">
                      ${rewards.map((reward) => {
                        const resolved = (reward.resolved as Item | undefined) || {};
                        return html`
                          <span title=${c.localized(resolved.name) || String(reward.resourceTypeName || "")}>
                            ${
                              resolved.image
                                ? html`
                                    <img src=${c.imageForLocale(String(resolved.image))} alt="" loading="lazy" />
                                  `
                                : html`
                                    <svg class="material-icon" width="22" height="22">
                                      <use href="/icons.svg#redeem"></use>
                                    </svg>
                                  `
                            }
                            <b>×${Number(reward.resourceCount || 0).toLocaleString()}</b>
                          </span>
                        `;
                      })}
                    </div>
                  </article>
                `;
              })}
            </div>
          </div>
        </section>
      `;
    })();
    return html`
      <nav
        class="tabs tabs--pills tabs--sticky character-detail-tabs"
        role="tablist"
        aria-label=${c.label("details", "Details")}
        @keydown=${rovingKeydown(
          tabs.map(([section]) => String(section)),
          active,
          (section) => this.choose(section),
        )}
      >
        ${tabs.map(
          ([section, icon, label, count]) => html`
            <button
              class="tab"
              type="button"
              role="tab"
              aria-selected=${String(active === section)}
              tabindex=${active === section ? "0" : "-1"}
              @click=${() => this.choose(section)}
            >
              <svg class="material-icon" width="18" height="18" aria-hidden="true">
                <use href=${`/icons.svg#${icon}${active === section ? "-filled" : ""}`}></use>
              </svg>
              <span>${label}</span>
              ${
                count
                  ? html`
                      <small class="tab__count">${count}</small>
                    `
                  : nothing
              }
            </button>
          `,
        )}
      </nav>
      <section class="character-detail-panel" role="tabpanel">${panel}</section>
    `;
  }
}

customElements.define("character-detail-archive", CharacterDetailArchive);
