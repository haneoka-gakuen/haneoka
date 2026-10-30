// L3 — GEB
// Input: Region, Arena season, league band, rank thresholds and card catalogues.
// Output: The league ranking in song-ranking rows plus rank tiers, with rank jumps and windows of 100.
// Pos: [Map](L2-2.md); Arena page leaderboard sharing the song-ranking row parts.
// Effects/Dependencies: Reads /api/v1/game/records/{region}/arena/…/ranking; reports loaded rows to the page.
import { html, nothing, type PropertyValues } from "lit";
import { GameRecordsCardsElement } from "./shared/game-records-cards";
import { fetchJson, JsonResponseError } from "./shared/catalog";
import { clientText } from "../i18n/client";
import { playerProfileHref } from "../lib/player-profile-route";
import { navigationDocumentUrl } from "../lib/document-url";
import { RequestScope } from "../lib/request-scope";
import type { ArenaRank } from "../lib/arena";
import type {
  ArenaRankingDto,
  ArenaRankingRowDto,
  ArenaSearchDto,
  GameRecordsErrorDto,
  GameRecordsRegion,
} from "../lib/game-records";
import { snackbar } from "../lib/snackbar";
import { iconButton } from "./ui/controls";
import { icon } from "./ui/icon";
import { emptyState, errorState } from "./ui/state";
import "@material/web/progress/linear-progress.js";
import "../styles/song-ranking.css";
import { formatDate } from "../lib/date-format";

const WINDOW = 100;

/** The highest open rank whose threshold the points reach. */
export function arenaTier(ranks: readonly ArenaRank[], point: number, at = Date.now()): ArenaRank | undefined {
  let best: ArenaRank | undefined;
  for (const rank of ranks)
    if ((!rank.startAt || rank.startAt <= at) && rank.points <= point && (!best || rank.points >= best.points))
      best = rank;
  return best;
}

export class ArenaRanking extends GameRecordsCardsElement {
  static properties = {
    locale: { type: String },
    region: { type: String },
    seasonId: { type: Number },
    bandId: { type: Number },
    ranks: { attribute: false },
    rankIcons: { attribute: false },
    rankName: { attribute: false },
    limit: { type: Number },
    start: { state: true },
    phase: { state: true },
    data: { state: true },
    failure: { state: true },
    target: { state: true },
    searching: { state: true },
  };
  declare seasonId: number;
  declare bandId: number;
  declare ranks: readonly ArenaRank[];
  declare rankIcons: Record<number, string>;
  declare rankName: (rank: ArenaRank) => string;
  /** Rows shown; 0 shows the whole window with its controls. */
  declare limit: number;
  declare private start: number;
  declare private phase: "loading" | "ready" | "error";
  declare private data: ArenaRankingDto | null;
  declare private failure: GameRecordsErrorDto["error"] | null;
  /** The rank to scroll to and mark once its window has loaded. */
  declare private target: number;
  declare private searching: boolean;
  private requests = new RequestScope();

  constructor() {
    super();
    this.locale = "en";
    this.region = "tw";
    this.seasonId = 0;
    this.bandId = 0;
    this.ranks = [];
    this.rankIcons = {};
    this.rankName = (rank) => String(rank.id);
    this.limit = 0;
    this.start = 1;
    this.phase = "loading";
    this.data = null;
    this.failure = null;
    this.target = 0;
    this.searching = false;
  }

  set catalogs(value: GameRecordsCardsElement["cardCatalogs"]) {
    this.cardCatalogs = value;
    this.requestUpdate();
  }

  disconnectedCallback() {
    this.requests.cancel();
    super.disconnectedCallback();
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has("region") || changed.has("seasonId") || changed.has("bandId")) this.start = 1;
  }

  protected updated(changed: PropertyValues) {
    if (["region", "seasonId", "bandId", "start"].some((key) => changed.has(key)) && this.seasonId && this.bandId)
      void this.load();
  }

  private t(key: string, fallback: string, values: Record<string, string | number> = {}) {
    return Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      clientText(this.locale, `catalog.arena.ranking.${key}`, fallback),
    );
  }

  private endpoint() {
    return `/api/v1/game/records/${this.region}/arena/seasons/${this.seasonId}/leagues/${this.bandId}/ranking?start=${this.start}`;
  }

  private async load() {
    const signal = this.requests.begin();
    this.phase = "loading";
    this.failure = null;
    try {
      const data = await fetchJson<ArenaRankingDto>(this.endpoint(), {
        signal,
        headers: { accept: "application/json" },
      });
      if (!this.requests.current(signal)) return;
      this.data = data;
      this.phase = "ready";
    } catch (error) {
      if (!this.requests.current(signal)) return;
      this.failure =
        error instanceof JsonResponseError ? ((error.body as GameRecordsErrorDto | null)?.error ?? null) : null;
      this.data = null;
      this.phase = "error";
    }
    this.dispatchEvent(new CustomEvent("arena-ranking-rows", { detail: this.data, bubbles: true }));
    if (this.target) {
      const rank = this.target;
      void this.updateComplete.then(() =>
        this.querySelector<HTMLElement>(`[data-rank="${rank}"]`)?.scrollIntoView({ block: "center" }),
      );
    }
  }

  refresh() {
    void this.load();
  }

  private jump(rank: number) {
    const maximum = this.data?.maxRank ?? Number.MAX_SAFE_INTEGER;
    const target = Math.max(1, Math.min(rank, maximum));
    const start = Math.floor((target - 1) / WINDOW) * WINDOW + 1;
    this.target = target;
    if (start !== this.start) this.start = start;
    else
      void this.updateComplete.then(() =>
        this.querySelector<HTMLElement>(`[data-rank="${target}"]`)?.scrollIntoView({ block: "center" }),
      );
  }

  /** Finds a player by profile ID among the board's top ranks and opens their window. */
  private async search(profileId: string) {
    this.searching = true;
    try {
      const result = await fetchJson<ArenaSearchDto>(
        `/api/v1/game/records/${this.region}/arena/seasons/${this.seasonId}/leagues/${this.bandId}/search?profileId=${profileId}`,
      );
      if (result.row) this.jump(result.row.rank);
      else
        snackbar(
          this.t("notFound", "Not in the top {count}", { count: result.searchedTo.toLocaleString(this.locale) }),
        );
    } catch {
      snackbar(this.label("error", "Ranking unavailable"));
    } finally {
      this.searching = false;
    }
  }

  private renderRow(row: ArenaRankingRowDto, observedAt: number) {
    const tier = arenaTier(this.ranks, row.point, observedAt);
    return this.renderRankingRow({
      ...row,
      level: this.levelFromExp(this.sourceCatalog()?.playerLevels, row.rankExp),
      href: row.profileId ? playerProfileHref(this.locale, this.region as GameRecordsRegion, row.profileId, this.endpoint(), navigationDocumentUrl()) : "",
      score: row.point.toLocaleString(this.locale),
      scoreLabel: this.t("points", "Points"),
      target: row.rank === this.target,
      bare: this.limit > 0,
      ...(this.limit ? { cards: undefined } : {}),
      detail: html`
        <small class="arena-ranking__tier">
          ${tier && this.rankIcons[tier.rank] ? html`<img src=${this.rankIcons[tier.rank]} alt="" width="20" height="20" loading="lazy" />` : nothing}
          ${tier ? this.rankName(tier) : "—"}
        </small>
      `,
    });
  }

  private renderControls() {
    const data = this.data;
    const maximum = data?.maxRank ?? null;
    return html`
      <div class="arena-ranking__controls">
        <div class="arena-ranking__search">
          <form
            class="arena-ranking__jump"
            @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            const value = Number(new FormData(event.currentTarget as HTMLFormElement).get("rank"));
            if (Number.isSafeInteger(value) && value > 0) this.jump(value);
          }}
          >
            <label class="field">
              <input
                name="rank"
                type="number"
                inputmode="numeric"
                min="1"
                max=${maximum ?? nothing}
                step="1"
                required
                placeholder=${this.t("jump", "Go to rank")}
                aria-label=${this.t("jump", "Go to rank")}
              />
            </label>
            <button class="button button--tonal" type="submit">${icon("arrow_forward")}${this.t("go", "Go")}</button>
          </form>
          <form
            class="arena-ranking__jump"
            @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget as HTMLFormElement).get("profileId") ?? "").trim();
            if (/^[1-9][0-9]{0,18}$/u.test(value)) void this.search(value);
          }}
          >
            <label class="field">
              <input
                name="profileId"
                type="text"
                inputmode="numeric"
                pattern="[1-9][0-9]{0,18}"
                required
                placeholder=${this.t("playerId", "Player ID")}
                aria-label=${this.t("playerId", "Player ID")}
              />
            </label>
            <button class="button button--tonal" type="submit" ?disabled=${this.searching}>
              ${icon("search")}${this.t("find", "Find")}
            </button>
          </form>
        </div>
        <span class="arena-ranking__window md-body-medium">
          ${this.t("window", "{start}–{end}", { start: this.start.toLocaleString(this.locale), end: Math.min(this.start + WINDOW - 1, maximum ?? Infinity).toLocaleString(this.locale) })}
          ${
            maximum != null
              ? html`
                  / ${maximum.toLocaleString(this.locale)}
                `
              : nothing
          }
        </span>
        <span class="cluster">
          ${iconButton({ icon: "first_page", label: this.t("top", "Top"), disabled: this.start === 1, onClick: () => (this.start = 1) })}
          ${iconButton({ icon: "chevron_left", label: this.t("previous", "Previous 100"), disabled: this.start === 1, onClick: () => (this.start = Math.max(1, this.start - WINDOW)) })}
          ${iconButton({ icon: "chevron_right", label: this.t("next", "Next 100"), disabled: maximum != null && this.start + WINDOW > maximum, onClick: () => (this.start += WINDOW) })}
          ${iconButton({ icon: "refresh", label: this.label("refresh", "Refresh ranking"), disabled: this.phase === "loading", onClick: () => this.refresh() })}
        </span>
      </div>
    `;
  }

  render() {
    const data = this.data;
    const rows = this.limit ? (data?.rows ?? []).slice(0, this.limit) : (data?.rows ?? []);
    const observedAt = data?.observedAtMs ?? Date.now();
    return html`
      <section class="song-ranking-page arena-ranking" aria-busy=${String(this.phase === "loading")}>
        ${this.limit ? nothing : this.renderControls()}
        <div class="song-ranking__progress">
          ${
            this.phase === "loading"
              ? html`
                  <md-linear-progress indeterminate></md-linear-progress>
                `
              : nothing
          }
        </div>
        ${
          this.phase === "error"
            ? this.failure?.kind === "not_found"
              ? emptyState({ title: this.label("empty", "No scores yet"), icon: "leaderboard" })
              : errorState(this.label("error", "Ranking unavailable"), this.label("retry", "Retry"), () =>
                  this.refresh(),
                )
            : !rows.length && this.phase === "ready"
              ? emptyState({ title: this.label("empty", "No scores yet"), icon: "leaderboard" })
              : html`
                  <ol class=${`song-ranking__list${this.limit ? " arena-ranking__list--compact" : ""}`}>
                    ${rows.map((row) => this.renderRow(row, observedAt))}
                  </ol>
                `
        }
        ${
          data
            ? html`
                <p class="song-ranking__fetched">
                  ${data.provider === "official" ? this.label("officialSource", "Official game rankings") : this.label("updated", "Updated")}
                  ${formatDate(this.locale, observedAt, { time: true })}
                </p>
              `
            : nothing
        }
      </section>
    `;
  }
}
if (!customElements.get("arena-ranking")) customElements.define("arena-ranking", ArenaRanking);
