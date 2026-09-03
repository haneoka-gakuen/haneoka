import { LitElement, html, nothing } from "lit";
import { renderGridIdentity, type GridIdentityAdornment } from "./shared/grid-identity";
import "../styles/character-detail.css";

type Item = Record<string, unknown>;
type Field = { key: string; value: string };
interface Controller {
  detailAux: Item;
  label(key: string, fallback: string): string;
  itemCharacterIds(item: Item): number[];
  localized(value: unknown): string;
  itemTitle(item: Item): string;
  detailLabel(key: string): string;
  characterName(id: number): string;
  bandName(id: number): string;
  character(id: number): Item | undefined;
  band(id: number): Item | undefined;
  imageForRelated(item: Item, route: string): string;
  relatedImageCandidates(item: Item, route: string): string[];
  relatedTitle(item: Item, route: string): string;
  relatedId(item: Item, route: string): string;
  relatedParam(route: string): string;
  characterAvatars(ids: number[]): GridIdentityAdornment;
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
    activeVoiceKey: { state: true },
    voicePlaying: { state: true },
    selectedPartner: { state: true },
    selectedMissionType: { state: true },
  };
  declare controller: Controller;
  declare item: Item;
  declare fields: Field[];
  declare section: string;
  declare activeVoiceKey: string;
  declare voicePlaying: boolean;
  declare selectedPartner: number;
  declare selectedMissionType: number;
  private voiceAudio = new Audio();
  private voiceSequence: string[] = [];
  private voiceSequenceIndex = -1;
  constructor() {
    super();
    this.controller = {} as Controller;
    this.item = {};
    this.fields = [];
    this.section = "profile";
    this.activeVoiceKey = "";
    this.voicePlaying = false;
    this.selectedPartner = 0;
    this.selectedMissionType = 0;
    this.voiceAudio.preload = "metadata";
    this.voiceAudio.addEventListener("play", () => (this.voicePlaying = true));
    this.voiceAudio.addEventListener("pause", () => (this.voicePlaying = false));
    this.voiceAudio.addEventListener("ended", () => void this.advanceVoice());
  }
  createRenderRoot() {
    return this;
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
    if (section !== "voices") this.stopVoice();
    this.dispatchEvent(new CustomEvent("section-change", { detail: section, bubbles: true, composed: true }));
  }
  disconnectedCallback() {
    this.stopVoice();
    super.disconnectedCallback();
  }
  private voiceLines(entry: Item) {
    const source = Array.isArray(entry.lines) ? (entry.lines as Item[]) : [entry];
    return source.flatMap((line) => {
      const sound = line.sound && typeof line.sound === "object" ? (line.sound as Item) : {};
      const url = String(sound.playableUrl || line.playableUrl || "");
      return url
        ? [{ url, text: this.controller.localized(line.text), cue: String(sound.cueName || line.cueName || "") }]
        : [];
    });
  }
  private async toggleVoice(entry: Item) {
    const key = String(entry.voiceKey || "");
    if (this.activeVoiceKey === key && this.voicePlaying) {
      this.voiceAudio.pause();
      return;
    }
    const lines = this.voiceLines(entry);
    if (!lines.length) return;
    this.activeVoiceKey = key;
    this.voiceSequence = lines.map((line) => line.url);
    this.voiceSequenceIndex = 0;
    this.voiceAudio.src = this.voiceSequence[0] || "";
    await this.voiceAudio.play().catch(() => {
      this.voicePlaying = false;
    });
  }
  private async advanceVoice() {
    this.voiceSequenceIndex += 1;
    const url = this.voiceSequence[this.voiceSequenceIndex];
    if (!url) {
      this.stopVoice();
      return;
    }
    this.voiceAudio.src = url;
    await this.voiceAudio.play().catch(() => this.stopVoice());
  }
  private stopVoice() {
    this.voiceAudio.pause();
    this.voiceAudio.removeAttribute("src");
    this.voiceAudio.load();
    this.voiceSequence = [];
    this.voiceSequenceIndex = -1;
    this.activeVoiceKey = "";
    this.voicePlaying = false;
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
    return (Array.isArray(entry.musicCategories) ? entry.musicCategories : [])
      .map(Number)
      .map((id) => this.controller.label(names[id] || "", names[id] || ""))
      .filter(Boolean)
      .join("、");
  }
  private relatedTile(entry: Item, route: string, characterId: number) {
    const c = this.controller;
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
    const description =
      route === "member-cards" || route === "support-cards"
        ? c.characterName(characterId)
        : route === "songs"
          ? c.bandName(Number(entry.bandId || 0))
          : route === "live2d"
            ? c.characterName(characterId)
            : route === "stories"
              ? ["band", "tutorial"].includes(storyVisual?.category || "")
                ? c.localized(entry.chapterName) || c.localized(this.storyChapter(entry)?.chapterName)
                : storyVisual?.category === "afterlive" && entry.unlockCharacterFriendshipLevel
                  ? `${c.label("friendship", "Friendship")} ${entry.unlockCharacterFriendshipLevel}`
                  : ""
              : c
                  .itemCharacterIds(entry)
                  .map((id) => c.characterName(id))
                  .join("、") || c.localized(entry.chapterName);
    const ids = c.itemCharacterIds(entry);
    const adornment =
      route === "stamps" && ids.length
        ? c.characterAvatars(ids)
        : (route === "member-cards" || route === "support-cards") && c.character(characterId)?.faceImage
          ? html`
              <img src=${String(c.character(characterId)?.faceImage)} alt="" />
            `
          : route === "songs" && c.band(Number(entry.bandId || 0))?.logo
            ? html`
                <img src=${String(c.band(Number(entry.bandId || 0))?.logo)} alt="" />
              `
            : route === "live2d" && c.character(characterId)?.faceImage
              ? html`
                  <img src=${String(c.character(characterId)?.faceImage)} alt="" />
                `
              : nothing;
    const attribute = route === "songs" ? c.attributeMark(entry.musicType, true) : c.attributeMark(entry.cardType);
    const rarity = c.rarityMark(entry.rarity);
    const hrefRoute = route === "stories" ? `stories/${storyVisual?.category || "band"}` : route;
    return html`
      <a
        class=${`catalog-card content-grid-tile catalog-card--${kind} character-related-tile`}
        href=${`/catalog/${hrefRoute}?${c.relatedParam(route)}=${encodeURIComponent(c.relatedId(entry, route))}`}
      >
        <span class=${`catalog-card__media ${source ? "media-loading" : ""}`}>
          ${
            source
              ? html`
                  <img
                    src=${source}
                    data-candidates=${JSON.stringify(imageCandidates)}
                    data-candidate-index="0"
                    alt=""
                    loading="lazy"
                    @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                    @error=${(event: Event) => {
                      const image = event.currentTarget as HTMLImageElement;
                      const candidates = JSON.parse(image.dataset.candidates || "[]") as string[];
                      const next = Number(image.dataset.candidateIndex || 0) + 1;
                      if (candidates[next]) {
                        image.dataset.candidateIndex = String(next);
                        image.src = candidates[next];
                      } else image.classList.add("is-error");
                    }}
                  />
                `
              : html`
                  ${
                    route === "stories" && storyVisual?.category === "afterlive"
                      ? html`
                          <span class="character-story-avatar-media">${c.characterAvatars(ids)}</span>
                        `
                      : html`
                          <svg class="material-icon" width="32" height="32"><use href="/icons.svg#image"></use></svg>
                        `
                  }
                `
          }
          ${
            route === "member-cards" || route === "support-cards"
              ? html`
                  ${
                    attribute
                      ? html`
                          <span class="card-attribute"><img src=${attribute} alt="" /></span>
                        `
                      : nothing
                  }${
                    rarity
                      ? html`
                          <span class="card-rarity"><img src=${rarity} alt="" /></span>
                        `
                      : nothing
                  }
                `
              : route === "songs" && attribute
                ? html`
                    <span class="song-type"><img src=${attribute} alt="" /></span>
                    <span class="song-category">${this.songCategory(entry)}</span>
                  `
                : nothing
          }
          ${
            storyVisual?.logo
              ? html`
                  <img class="character-related-story-logo is-loaded" src=${storyVisual.logo} alt="" />
                `
              : nothing
          }
          ${
            route === "stories" && source && ["link", "home"].includes(storyVisual?.category || "")
              ? html`
                  <span class="character-related-story-avatars">${c.characterAvatars(ids)}</span>
                `
              : nothing
          }
        </span>
        <span class="catalog-card__body">
          ${renderGridIdentity(c.relatedTitle(entry, route), description, adornment)}
        </span>
      </a>
    `;
  }
  private grid(title: string, icon: string | null, route: string, entries: Item[], characterId: number) {
    const c = this.controller;
    return html`
      <section class="detail-section character-detail-panel-group">
        <h3 class="detail-section-title">
          ${
            icon
              ? html`
                  <span>
                    <svg class="material-icon" width="18" height="18"><use href=${`/icons.svg#${icon}`}></use></svg>
                  </span>
                `
              : nothing
          }
          ${title} ${entries.length}
        </h3>
        ${
          entries.length
            ? html`
                <div class=${`catalog-grid character-related-grid character-related-grid--${route}`}>
                  ${entries.map((entry) => this.relatedTile(entry, route, characterId))}
                </div>
              `
            : html`
                <div class="catalog-state"><span>${c.label("empty", "No results")}</span></div>
              `
        }
      </section>
    `;
  }
  private sectionHeading(title: string, iconName: string, count?: number) {
    return html`
      <h3 class="detail-section-title">
        <span>
          <svg class="material-icon" width="18" height="18"><use href=${`/icons.svg#${iconName}`}></use></svg>
        </span>
        ${title}${
          count === undefined
            ? nothing
            : html`
                <small>${count}</small>
              `
        }
      </h3>
    `;
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
        return html`
          <section class="character-detail-intro">
            <small>${[String(item.bandPart || ""), c.localized(item.englishName)].filter(Boolean).join("、")}</small>
            <h2>${c.itemTitle(item)}</h2>
            ${
              item.voiceActor
                ? html`
                    <strong>${c.localized(item.voiceActor)}</strong>
                  `
                : nothing
            }
            ${
              item.catchCopy
                ? html`
                    <p class="character-detail-catch">${c.localized(item.catchCopy)}</p>
                  `
                : nothing
            }
            ${
              item.description
                ? html`
                    <p>${c.localized(item.description)}</p>
                  `
                : nothing
            }
          </section>
          <dl class="detail-list character-detail-facts">
            ${this.fields.map(
              ({ key, value }) => html`
                <div>
                  <dt>${c.detailLabel(key)}</dt>
                  <dd>
                    ${
                      key === "bandId" && c.band(Number(item.bandId || 0))?.logo
                        ? html`
                            <img
                              class="character-detail-fact-image"
                              src=${String(c.band(Number(item.bandId || 0))?.logo)}
                              alt=""
                            />
                          `
                        : nothing
                    }${value}
                  </dd>
                </div>
              `,
            )}
          </dl>
        `;
      if (active === "cards")
        return html`
          <section class="detail-section character-detail-deferred-section">
            ${this.sectionHeading(c.label("cards", "Cards"), "photo_library", data.cards.length + data.supports.length)}
            <div class="character-detail-groups">
              ${this.grid(c.label("memberCards", "Member cards"), null, "member-cards", data.cards, id)}${this.grid(c.label("supportCards", "Support cards"), null, "support-cards", data.supports, id)}
            </div>
          </section>
        `;
      if (active === "stamps")
        return this.grid(c.label("stamps", "Stamps"), "sticky_note_2", "stamps", data.stamps, id);
      if (active === "story")
        return html`
          <section class="detail-section character-detail-deferred-section">
            ${this.sectionHeading(c.label("story", "Story"), "chat", data.stories.length)}
            <div class="character-detail-groups">
              ${this.storyGroups(data.stories).map((group) => this.grid(group.label, null, "stories", group.items, id))}
            </div>
          </section>
        `;
      if (active === "live2d") return this.grid("Live2D", "accessibility_new", "live2d", data.live2d, id);
      if (active === "songs") return this.grid(c.label("songs", "Songs"), "music_note", "songs", data.songs, id);
      if (active === "voices")
        return html`
          <section class="detail-section character-detail-deferred-section">
            ${this.sectionHeading(c.label("voices", "Voices"), "mic", data.voices.length)}
            <div class="character-voice-list">
              ${data.voices.map((entry) => {
                const playable = this.voiceLines(entry).length > 0;
                const active = this.activeVoiceKey === String(entry.voiceKey || "");
                return html`
                  <article>
                    <span>
                      <small>${String(entry.characterVoiceTypeName || "")}</small>
                      <p>${c.localized(entry.text)}</p>
                    </span>
                    ${
                      playable
                        ? html`
                            <button
                              class=${`icon-button${active ? " selected" : ""}`}
                              aria-label=${active && this.voicePlaying ? c.label("pause", "Pause") : c.label("play", "Play")}
                              @click=${() => this.toggleVoice(entry)}
                            >
                              <svg class="material-icon" width="22" height="22">
                                <use
                                  href=${active && this.voicePlaying ? "/icons.svg#pause-filled" : "/icons.svg#play_arrow"}
                                ></use>
                              </svg>
                            </button>
                          `
                        : nothing
                    }
                  </article>
                `;
              })}
            </div>
          </section>
        `;
      if (active === "friendships") {
        const partners = values(c.detailAux.characters).filter((entry) => Number(entry.characterId) !== id);
        const partnerId = this.selectedPartner || Number(partners[0]?.characterId || 0);
        const friendship = data.friendships.find((entry) => c.itemCharacterIds(entry).includes(partnerId));
        const stories = data.stories.filter(
          (entry) => this.storyCategory(entry) === "link" && c.itemCharacterIds(entry).includes(partnerId),
        );
        const rewards = friendship && Array.isArray(friendship.rewards) ? (friendship.rewards as Item[]) : [];
        return html`
          <section class="detail-section character-detail-deferred-section">
            ${this.sectionHeading(c.label("characterBonds", "Character Bonds"), "handshake", data.friendships.length)}
            <div class="character-friendship-workspace">
              <div class="character-friendship-selector">
                <div class="character-friendship-anchor">
                  ${
                    c.character(id)?.faceImage
                      ? html`
                          <img src=${String(c.character(id)?.faceImage)} alt="" />
                        `
                      : nothing
                  }
                  <strong>${c.characterName(id)}</strong>
                </div>
                <span>
                  ${html`
                    <svg class="material-icon" width="22" height="22"><use href="/icons.svg#swap_horiz"></use></svg>
                  `}
                </span>
                <div class="character-friendship-partners">
                  ${partners.map((partner) => {
                    const candidate = Number(partner.characterId || 0);
                    return html`
                      <button
                        class=${candidate === partnerId ? "selected" : ""}
                        @click=${() => (this.selectedPartner = candidate)}
                      >
                        ${
                          partner.faceImage
                            ? html`
                                <img src=${String(partner.faceImage)} alt="" />
                              `
                            : nothing
                        }
                        <span>${c.characterName(candidate)}</span>
                      </button>
                    `;
                  })}
                </div>
              </div>
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
                                <img src=${String(friendship.storyBanner)} alt="" />
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
              }${stories.length ? this.grid(c.label("story", "Story"), null, "stories", stories, id) : nothing}${
                rewards.length
                  ? html`
                      <section class="detail-section">
                        <h3 class="detail-section-title">${c.label("rewards", "Rewards")}</h3>
                        <div class="reference-list">
                          ${rewards.map((row) => {
                            const reward = (row.reward as Item | undefined) || row;
                            const resolved = (reward.resolved as Item | undefined) || {};
                            return html`
                              <div>
                                ${
                                  resolved.image
                                    ? html`
                                        <img src=${String(resolved.image)} alt="" />
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
                      <div class="catalog-state"><span>${c.label("empty", "No results")}</span></div>
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
          ${this.sectionHeading(c.label("missions", "Missions"), "checklist", data.missions.length)}
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
                                    <img src=${String(resolved.image)} alt="" loading="lazy" />
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
      <nav class="character-detail-tabs" role="tablist" aria-label=${c.label("details", "Details")}>
        ${tabs.map(
          ([section, icon, label, count]) => html`
            <button
              role="tab"
              aria-selected=${active === section}
              class=${active === section ? "selected" : ""}
              @click=${() => this.choose(section)}
            >
              <svg class="material-icon" width="16" height="16">
                <use href=${`/icons.svg#${icon}${active === section ? "-filled" : ""}`}></use>
              </svg>
              <span>${label}</span>
              ${
                count
                  ? html`
                      <small>${count}</small>
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
