// L3 — GEB
// Input: Region, Arena season, league band or event point board and card catalogues.
// Output: Point-board adapter using shared SongRanking search, controls, rows and activity analysis.
// Pos: [Map](L2-2.md); Arena tiers and event point endpoints for the common leaderboard.
// Effects/Dependencies: Reads saved ranking windows and reports loaded rows to the owning page.
import { clientText } from "../i18n/client";
import { html, nothing } from "lit";
import { SongRanking } from "./song-ranking";
import type { ArenaRank } from "../lib/arena";
import type { ArenaRankingDto, GameRankingDto, SongRankingRowDto, ArenaRankingRowDto } from "../lib/game-records";
// import { playerProfileHref } from "../lib/player-profile-route";
// import { navigationDocumentUrl } from "../lib/document-url";

export function arenaTier(ranks: readonly ArenaRank[], point: number, at = Date.now()): ArenaRank | undefined {
  let best: ArenaRank | undefined;
  for (const rank of ranks)
    if ((!rank.startAt || rank.startAt <= at) && rank.points <= point && (!best || rank.points >= best.points))
      best = rank;
  return best;
}

export class ArenaRanking extends SongRanking {
  static properties = {
    ...SongRanking.properties,
    seasonId: { type: Number },
    bandId: { type: Number },
    eventId: { type: Number },
    ranks: { attribute: false },
    rankIcons: { attribute: false },
    rankName: { attribute: false },
  };
  declare seasonId: number;
  declare bandId: number;
  declare eventId: number;
  declare ranks: readonly ArenaRank[];
  declare rankIcons: Record<number, string>;
  declare rankName: (rank: ArenaRank) => string;
  private observedAt = Date.now();

  constructor() {
    super();
    this.embedded = true;
    this.windowed = true;
    this.points = true;
    this.seasonId = 0;
    this.bandId = 0;
    this.eventId = 0;
    this.ranks = [];
    this.rankIcons = {};
    this.rankName = (rank) => String(rank.id);
  }

  set catalogs(value: SongRanking["cardCatalogData"]) {
    this.cardCatalogData = value;
  }

  protected get identityProperties() {
    return [...super.identityProperties, "seasonId", "bandId", "eventId"];
  }

  protected get boardTitle() {
    return this.eventId
      ? clientText(this.locale, "tools.eventTracker.pointRanking", "Event point ranking")
      : clientText(this.locale, "catalog.arena.tabs.ranking", "Rankings");
  }

  protected rankingUrl() {
    const board = this.eventId
      ? `/api/v1/game/records/${this.region}/events/${this.eventId}/points`
      : `/api/v1/game/records/${this.region}/arena/seasons/${this.seasonId}/leagues/${this.bandId}`;
    return `${board}/ranking?start=${this.start}`;
  }

  protected rankingLoaded(value: GameRankingDto | null) {
    this.observedAt = value?.observedAtMs ?? Date.now();
    this.dispatchEvent(
      new CustomEvent("arena-ranking-rows", { detail: value as ArenaRankingDto | null, bubbles: true }),
    );
  }

  refresh() {
    super.refresh();
  }

  protected get skeletonDecks() {
    return !this.eventId && !this.limit;
  }

  protected renderRow(entry: SongRankingRowDto) {
    const row = entry as ArenaRankingRowDto;
    const tier = arenaTier(this.ranks, row.point, this.observedAt);
    return this.renderRankingRow({
      ...row,
      level: this.levelFromExp(this.sourceCatalog()?.playerLevels, row.rankExp),
      href: "",
      /*
      href: row.profileId
        ? playerProfileHref(this.locale, this.region, row.profileId, this.rankingUrl(), navigationDocumentUrl())
        : "",
      */
      score: row.point.toLocaleString(this.locale),
      ...(this.eventId && this.analysisEvent && row.profileId ? { scoreAction: {
        label: clientText(this.locale, "catalog.rankings.analysis.title", "Team analysis"),
        onClick: () => void this.analyzeTeam(row),
      } } : {}),
      scoreLabel: this.eventId
        ? this.label("points", "Points")
        : clientText(this.locale, "catalog.arena.ranking.points", "Points"),
      target: row.rank === this.target,
      bare: this.limit > 0,
      ...(this.limit || !row.cards.length ? { cards: undefined } : {}),
      detail: this.eventId
        ? nothing
        : html`
            <small class="arena-ranking__tier">
              ${
                tier && this.rankIcons[tier.rank]
                  ? html`
                      <img src=${this.rankIcons[tier.rank]} alt="" width="20" height="20" loading="lazy" />
                    `
                  : nothing
              }
              ${tier ? this.rankName(tier) : "—"}
            </small>
          `,
    });
  }
}
if (!customElements.get("arena-ranking")) customElements.define("arena-ranking", ArenaRanking);
