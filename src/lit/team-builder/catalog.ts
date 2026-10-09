/** Names, tiles and growth helpers shared by the team builder views. */
import { html, nothing } from "lit";
import { clientText } from "../../i18n/client";
import { resolveLocalizedText } from "../../lib/localized-text";
import { songTitle } from "../../lib/song-display";
import type { TeamBuilderData, MemberCatalog, SnapshotCatalog } from "../../lib/team-builder/data";
import { dataRows } from "../../lib/team-builder/data";
import type { EngineMaster } from "../../lib/team-builder/engine/master";
import { maxMemberGrowth, maxSnapGrowth } from "../../lib/team-builder/engine/box";
import { memberLevelCap, snapLevelCap } from "../../lib/team-builder/engine/power";
import type { fetchCatalogVisuals } from "../../lib/catalog-visuals";
import type { OwnedMember, OwnedSnap } from "../../lib/team-builder/sync/box-view";
import { cardRarityName } from "../shared/rarity-icon";
import { cardTile } from "../shared/card-tile";
import { liveMusicTypeMark, songTile } from "../shared/song-tile";
import { difficultyKey } from "../ui/difficulty-picker";
import type { TileOptions } from "../ui/tile";
import { icon } from "../ui/icon";
import type { TeamBuilder } from "../team-builder";
import { catalogServerMark, exclusiveServer, type FormalCatalogServer } from "../shared/server-availability";

type Visuals = Awaited<ReturnType<typeof fetchCatalogVisuals>>;
const COLORS = ["", "Red", "Blue", "Green", "Yellow", "Purple"];

export class Catalog {
  visuals: Visuals | null = null;
  constructor(
    private readonly host: TeamBuilder,
    readonly data: TeamBuilderData,
    readonly master: EngineMaster,
  ) {}
  setVisuals(visuals: Visuals) {
    this.visuals = visuals;
  }
  serverMark(collection: string, id: number) {
    const cross = this.data.crossServer;
    if (!cross?.identities.jp || !cross.identities.intl) return undefined;
    const available = (cross.availability[collection]?.[String(id)] ?? [])
      .filter((server): server is FormalCatalogServer => server === "jp" || server === "intl" || server === "intl-test");
    return catalogServerMark({ exclusive: exclusiveServer(available) ?? null }, this.host.locale);
  }
  text(value: unknown) {
    return resolveLocalizedText(value, this.host.locale).text;
  }
  member(id: number): MemberCatalog | undefined {
    return this.data.members[String(id)];
  }
  snap(id: number): SnapshotCatalog | undefined {
    return this.data.snapshots[String(id)];
  }
  characterName(id: number) {
    return this.text(this.data.characters[String(id)]?.characterName);
  }
  characterFace(id: number) {
    const row = this.visuals?.characters[String(id)] ?? this.data.characters[String(id)];
    return String(row?.faceImage ?? row?.thumbnailImage ?? "");
  }
  characterColor(id: number) {
    const code = String(this.data.characters[String(id)]?.colorCode ?? "").replace(/^#?/u, "");
    return /^[0-9a-f]{6}$/iu.test(code) ? `#${code}` : "var(--md-sys-color-primary)";
  }
  bandName(id: number) {
    const row = this.data.bands[String(id)];
    return this.text(row?.bandName ?? row?.name);
  }
  bandIcon(id: number) {
    const row = this.data.bands[String(id)];
    return String(row?.icon ?? row?.logo ?? "");
  }
  attributeName(attribute: number) {
    const key = ["", "red", "blue", "green", "yellow", "purple"][attribute];
    return key ? clientText(this.host.locale, `catalog.songs.liveTypes.${key}`, key) : "";
  }
  attributeIcon(attribute: number) {
    const color = COLORS[attribute];
    return color ? (this.visuals?.marks.get(`CardType-${color}.png`) ?? "") : "";
  }
  rarityIcon(rarity: number) {
    return this.visuals?.marks.get(`RarityIconCenter_${cardRarityName(rarity)}.png`) ?? "";
  }
  cardName(kind: "members" | "snaps", id: number) {
    const card = kind === "members" ? this.member(id) : this.snap(id);
    return card ? this.text(card.name) : `#${id}`;
  }
  characterIds(kind: "members" | "snaps", id: number) {
    if (kind === "members") {
      const card = this.member(id);
      return card ? [card.characterId] : [];
    }
    return this.snap(id)?.characterIds ?? [];
  }
  bandIds(kind: "members" | "snaps", id: number) {
    if (kind === "members") {
      const card = this.member(id);
      return card ? [card.bandId] : [];
    }
    return [...new Set(this.characterIds("snaps", id).map((character) => Number(this.data.characters[String(character)]?.bandId ?? 0)).filter(Boolean))];
  }
  /** The same summary fields/facets as card catalogue screens. */
  cardFilterItem(kind: "members" | "snaps", id: number): Record<string, unknown> {
    const card = kind === "members" ? this.member(id) : this.snap(id);
    if (!card) return {};
    const keys: Record<string, number[]> = kind === "members"
      ? { leader: [(card as MemberCatalog).leaderSkillId], live: [(card as MemberCatalog).liveSkillId], gekisou: [(card as MemberCatalog).gekisoSkillId] }
      : { support: (card as SnapshotCatalog).supportSkillIds, gekisouSupport: (card as SnapshotCatalog).gekisoSupportSkillIds };
    const metadata = (this.visuals ? (kind === "members" ? this.visuals.cards : this.visuals.supportCards)[String(id)] ?? card.catalogMetadata : card.catalogMetadata) as Record<string, unknown> | undefined;
    const resolvedSkills = { ...metadata?.resolvedSkills as Record<string, unknown> };
    for (const [role, ids] of Object.entries(keys)) {
      const group = role.replace("gekisou", "gekiso");
      const rows = ids!.flatMap((skillId) => this.data.skills[group]?.[String(skillId)] ? [this.data.skills[group]![String(skillId)]!] : []);
      if (rows.length && !resolvedSkills[role]) resolvedSkills[role] = rows;
    }
    return { id, cardType: card.attribute, rarity: card.rarity, stat: card.statMax, images: {thumbnail: card.image}, ...metadata, resolvedSkills };
  }
  /** Catalogue tile of a card, with its native frame ratio. */
  cardOptions(kind: "members" | "snaps", id: number): TileOptions | null {
    const card = kind === "members" ? this.member(id) : this.snap(id);
    if (!card) return null;
    const rarity = cardRarityName(card.rarity);
    const attribute = this.attributeName(card.attribute);
    const title = resolveLocalizedText(card.name, this.host.locale);
    const characters = this.characterIds(kind, id);
    const names = characters.map((character) => this.characterName(character)).filter(Boolean).join(" · ");
    return {
      ...cardTile({
        kind: kind === "members" ? "member" : "support",
        title: title.text,
        titleLanguage: title.locale,
        subtitle: names,
        label: [title.text, names, rarity, attribute].filter(Boolean).join(" · "),
        image: card.image,
        avatars: [...new Set(characters)].map((character) => ({ image: this.characterFace(character), name: this.characterName(character) })),
        attributeIcon: this.attributeIcon(card.attribute),
        attributeLabel: attribute,
        rarityIcon: this.rarityIcon(card.rarity),
        rarityLabel: rarity,
      }),
      serverMark: this.serverMark(kind === "members" ? "members" : "snapshots", id),
      aspectRatio: kind === "members" ? "3 / 4" : "16 / 9",
    };
  }
  /** Short growth caption: Lv · training · awakening · skill. */
  growthCaption(kind: "members" | "snaps", owned: OwnedMember | OwnedSnap | undefined, policy: "max" | "min") {
    if (!owned) return "";
    const t = this.host.t.bind(this.host);
    const unknown = (value: number | null) => (value === null ? (policy === "max" ? "★" : "?") : String(value));
    if (kind === "members") {
      const row = owned as OwnedMember;
      return [`Lv${unknown(row.level)}`, `${t("trainingShort", "T")}${unknown(row.awake)}`, `${t("rankShort", "A")}${unknown(row.rank)}`, `${t("skillShort", "SL")}${unknown(row.skill)}`].join(" ");
    }
    const row = owned as OwnedSnap;
    return [`Lv${unknown(row.level)}`, `${t("rankShort", "A")}${unknown(row.rank)}`].join(" ");
  }
  memberLimits(id: number, awake: number | null) {
    const card = this.master.members.get(id);
    if (!card) return null;
    const max = maxMemberGrowth(this.master, card);
    return { ...max, levelCap: memberLevelCap(this.master, card, awake ?? max.awake) };
  }
  snapLimits(id: number, rank: number | null) {
    const card = this.master.snaps.get(id);
    if (!card) return null;
    const max = maxSnapGrowth(this.master, card);
    return { ...max, levelCap: snapLevelCap(this.master, card, rank ?? max.rank) };
  }
  song(id: number) {
    return { ...this.data.songs[String(id)], ...this.visuals?.songs[String(id)] } as Record<string, unknown>;
  }
  songTitle(id: number) {
    return songTitle(this.song(id), this.host.locale).text;
  }
  songBands(id: number): number[] {
    const song = this.data.songs[String(id)];
    const ids = Array.isArray(song?.bandIds) ? song.bandIds : song?.bandId ? [song.bandId] : [];
    return ids.map(Number).filter(Boolean);
  }
  difficultyRows(id: number) {
    return dataRows(this.data.songs[String(id)]?.difficulty);
  }
  difficultyLabel(songId: number, difficulty: number) {
    const row = this.difficultyRows(songId).find((item) => Number(item.difficulty) === difficulty);
    return row ? `${difficultyKey(row).toUpperCase()} ${row.displayLevel ?? row.playLevel ?? ""}` : "";
  }
  songOptions(id: number, difficulty?: number): TileOptions {
    const song = this.song(id);
    const rows = this.difficultyRows(id);
    const row =
      difficulty !== undefined ? rows.find((item) => Number(item.difficulty) === difficulty) : [...rows].sort((a, b) => Number(b.playLevel) - Number(a.playLevel))[0];
    const bands = this.songBands(id).map((band) => this.bandName(band)).filter(Boolean).join(" · ");
    const options = songTile(
      song,
      {
        locale: this.host.locale,
        title: (item) => songTitle(item, this.host.locale),
        image: (item) => String(item.jacketThumbUrl ?? item.jacketUrl ?? ""),
        artist: () => bands,
        bandIcon: () => this.bandIcon(this.songBands(id)[0] ?? 0),
        imageForLocale: (source) => source,
        attributeMark: (item) => liveMusicTypeMark(this.visuals?.marks ?? new Map(), item.musicType),
        attributeLabel: (item) => this.attributeName(Number(item.musicType)),
      },
      "",
      [],
      row,
    );
    return { ...options, aspectRatio: 1, serverMark: this.serverMark("songs", id) };
  }
  /** Events with a live point table (searchable event goals). */
  events() {
    return [...this.master.events.values()]
      .filter((event) => event.livePoints.size || event.challengePoints.size || event.effects.length)
      .sort((a, b) => (b.startAt ?? 0) - (a.startAt ?? 0))
      .map((event) => ({ id: event.id, name: this.text(this.data.events[String(event.id)]?.name ?? this.data.events[String(event.id)]?.title) || `#${event.id}`, event, serverMark: this.serverMark("events", event.id) }));
  }
  challengeSongs(eventId: number | null) {
    return this.master.challengeMusics.filter((row) => eventId === null || row.eventId === eventId);
  }
}

export const avatar = (image: string, label: string) =>
  image ? html`<img class="tb-avatar" src=${image} alt=${label} title=${label} loading="lazy" decoding="async" />` : nothing;

/** Section title in the detail-section style, with any sprite icon. */
export function sectionHeading(options: { icon: string; label: unknown; level?: 2 | 3; count?: number | string }) {
  const content = html`<span class="detail-section-title__icon" aria-hidden="true">${icon(options.icon, 18)}</span>
    <span class="detail-section-title__label">${options.label}</span>
    ${options.count === undefined ? nothing : html`<small class="detail-section-title__count">${options.count}</small>`}`;
  return options.level === 3
    ? html`<h3 class="detail-section-title detail-section-title--h3">${content}</h3>`
    : html`<h2 class="detail-section-title detail-section-title--h2">${content}</h2>`;
}
