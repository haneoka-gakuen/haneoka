// L3 — GEB
// Input: 公开个人主页的 gameAccounts（region、playerUid、displayName、verificationStatus、lastSyncedAt、latestSnapshot.summary 白名单）。
// Output: 整宽游戏账号卡：主推成员卡图、区服与玩家 ID、等级／高分评级／成员与留影数量、开始日期与天数、以对应 jp／intl 已开放歌曲总数为满格的按难度 CLEAR／FC／AP 表及同步时间。
// Pos: [Map](../L2-2.md)；community-workspace 个人主页「游戏账号」页签的呈现。
// Effects/Dependencies: 公开跨服缓存按 jp／intl 各读一次 identity，共享给主推卡批量读取、完整歌曲目录与按需活动开放时间；渲染本身无副作用。
import { html, nothing, type TemplateResult } from "lit";
import type { MessageParams } from "@haneoka/i18n";
import { icon } from "../ui/icon";
import { resolveLocalizedText } from "../../lib/localized-text";
import { GAME_RECORDS_REGIONS, gameAccountRegion } from "../shared/game-records";
// import { playerProfileHref } from "../../lib/player-profile-route";
import { resourcePath } from "../../lib/resource-route";
import { formatDate } from "../../lib/date-format";
import type { Locale } from "../../i18n/locales";

type Value = Record<string, unknown>;
type CardSource = "jp" | "intl";

export interface FavoriteMemberCard {
  name: string;
  language: string;
  image: string;
  href: string;
}
export interface GameAccountShowcase {
  cards: ReadonlyMap<string, FavoriteMemberCard>;
  /** Released songs in the full catalogue of each release source. */
  songCounts: ReadonlyMap<CardSource, number>;
}

export interface GameAccountsView {
  locale: string;
  showcase: GameAccountShowcase;
  label(path: string, fallback: string, params?: MessageParams): string;
  time(value: unknown): unknown;
}

const DIFFICULTIES = ["easy", "normal", "hard", "expert"] as const;
const DAY_MS = 86_400_000;

const summaryOf = (account: Value): Value | null =>
  ((account.latestSnapshot as Value | null | undefined)?.summary as Value | null | undefined) ?? null;
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const cardSource = (account: Value, locale: string): CardSource =>
  gameAccountRegion(String(account.region), locale, String(account.playerUid)) === "jp" ? "jp" : "intl";
const cardKey = (source: CardSource, id: number) => `${source}:${id}`;

export const emptyGameAccountShowcase = (): GameAccountShowcase => ({ cards: new Map(), songCounts: new Map() });

/** Per release source: one identity, one batched card read and one songs collection, shared by every account. */
export async function loadGameAccountShowcase(
  accounts: readonly Value[],
  locale: string,
  signal: AbortSignal,
): Promise<GameAccountShowcase> {
  const wanted = new Map<CardSource, Set<string>>();
  for (const account of accounts) {
    const source = cardSource(account, locale);
    const ids = wanted.get(source) ?? new Set<string>();
    wanted.set(source, ids);
    const id = count(summaryOf(account)?.favoriteMemberCardId);
    if (id != null) ids.add(String(id));
  }
  const cards = new Map<string, FavoriteMemberCard>();
  const songCounts = new Map<CardSource, number>();
  if (!wanted.size) return { cards, songCounts };
  const [{ crossServerPublicCache }, { crossCatalogRows }, { contentPublished }, { needsEventSongRelease, withEventSongReleases }] = await Promise.all([
    import("../../lib/cross-server/cache"),
    import("../../lib/cross-server/definitions"),
    import("../../lib/content-publication"),
    import("../../lib/event-song-release"),
  ]);
  const cache = crossServerPublicCache();
  await Promise.all(
    [...wanted].map(async ([source, ids]) => {
      const identity = await cache.readIdentity(source, signal).catch(() => null);
      if (!identity) return;
      await Promise.all([
        ids.size
          ? cache
              .readEntities("cards", identity, [...ids].sort(), signal)
              .then((document) => {
                const { items = {} } = document as { items?: Record<string, Value> };
                for (const id of ids) {
                  const card = items[id];
                  if (!card) continue;
                  const name = resolveLocalizedText(card.prefix ?? card.cardName, locale);
                  cards.set(cardKey(source, Number(id)), {
                    name: name.text,
                    language: name.locale,
                    image: String((card.images as Value | undefined)?.thumbnail || ""),
                    href: resourcePath({ server: source, locale: locale as Locale, kind: "member-cards", id }),
                  });
                }
              })
              .catch(() => undefined)
          : undefined,
        cache
          .readCollection("songs", identity, signal)
          .then(async (document) => {
            let songs = crossCatalogRows("songs", document);
            if (Object.values(songs).some(needsEventSongRelease))
              songs = withEventSongReleases(songs, await cache.readEventSongReleases(identity, signal));
            songCounts.set(source, Object.values(songs).filter((song) => contentPublished(song)).length);
          })
          .catch(() => undefined),
      ]);
    }),
  );
  signal.throwIfAborted();
  return { cards, songCounts };
}

function renderStat(glyph: TemplateResult, label: string, value: unknown, detail: unknown = nothing) {
  return html`
    <div class="community-game-account__stat">
      <dt>
        <span class="community-game-account__stat-icon" aria-hidden="true">${glyph}</span>
        <span>${label}</span>
      </dt>
      <dd>
        <strong>${value}</strong>
        ${detail}
      </dd>
    </div>
  `;
}

function renderClears(summary: Value, songTotal: number | undefined, view: GameAccountsView) {
  const clears = (summary.clears as Record<string, unknown> | undefined) || {};
  const rows = DIFFICULTIES.map((key) => {
    const row = clears[key];
    return [key, Array.isArray(row) && row.length === 3 ? (row as number[]) : null] as const;
  });
  if (!rows.some(([, row]) => row)) return nothing;
  const number = new Intl.NumberFormat(view.locale);
  const totals = [0, 1, 2].map((index) => rows.reduce((sum, [, row]) => sum + (row?.[index] ?? 0), 0));
  const fullCombo = view.label("catalog.songProgress.fullCombo", "FULL COMBO");
  const allPerfect = view.label("catalog.songProgress.allPerfect", "ALL PERFECT");
  const share = (value: number) => (songTotal ? `${Math.min(100, (value / songTotal) * 100)}%` : "0%");
  return html`
    <div class="community-game-account__clears">
      <div class="community-game-account__clears-head">
        <h4 class="community-game-account__subhead">${view.label("community.page.gameClears", "Clear records")}</h4>
        <span class="community-game-account__song-total">
          ${view.label("community.page.gameSongTotal", "{count} songs", {
            count: songTotal == null ? "—" : number.format(songTotal),
          })}
        </span>
      </div>
      <div class="table-scroll" role="region" tabindex="0" aria-label=${view.label("community.page.gameClears", "Clear records")}>
        <table class="data-table data-table--numeric">
          <thead>
            <tr>
              <th scope="col">${view.label("community.page.gameDifficulty", "Difficulty")}</th>
              <th scope="col" class="is-numeric">${view.label("community.page.gameClear", "CLEAR")}</th>
              <th scope="col" class="is-numeric">${fullCombo}</th>
              <th scope="col" class="is-numeric">${allPerfect}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(([key, row]) => {
              const [clear, combo, perfect] = row ?? [0, 0, 0];
              return html`
                <tr style=${`--difficulty-color:var(--md-extended-color-difficulty-${key})`}>
                  <th scope="row">
                    <span class="community-game-account__difficulty">${key.toUpperCase()}</span>
                    <span
                      class="community-game-account__meter"
                      style=${`--clear:${share(clear)};--fc:${share(combo)};--ap:${share(perfect)}`}
                      aria-hidden="true"
                    ></span>
                  </th>
                  ${row
                    ? html`
                        <td class="is-numeric">${number.format(clear)}</td>
                        <td class="is-numeric">${number.format(combo)}</td>
                        <td class="is-numeric">${number.format(perfect)}</td>
                      `
                    : html`
                        <td class="is-numeric">—</td>
                        <td class="is-numeric">—</td>
                        <td class="is-numeric">—</td>
                      `}
                </tr>
              `;
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">${view.label("community.page.gameTotal", "Total")}</th>
              ${totals.map((value) => html`<td class="is-numeric">${number.format(value)}</td>`)}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}

function renderAccount(account: Value, view: GameAccountsView) {
  const { locale } = view;
  const playerUid = String(account.playerUid || "");
  const region = gameAccountRegion(String(account.region), locale, playerUid);
  const regionOption = GAME_RECORDS_REGIONS.find((option) => option.value === region)!;
  const regionName = view.label(`catalog.rankings.songs.${regionOption.key}`, region.toUpperCase());
  const name = String(account.displayName || playerUid);
  const summary = summaryOf(account);
  const favoriteId = count(summary?.favoriteMemberCardId);
  const source = cardSource(account, locale);
  const card = favoriteId == null ? undefined : view.showcase.cards.get(cardKey(source, favoriteId));
  const number = new Intl.NumberFormat(locale);
  const value = (input: unknown) => {
    const amount = count(input);
    return amount == null ? null : number.format(amount);
  };
  const startedAt = count(summary?.startedAt);
  const startedMs = startedAt == null || startedAt <= 0 ? null : startedAt * 1000;
  const days = startedMs == null ? null : Math.max(0, Math.floor((Date.now() - startedMs) / DAY_MS));
  const stats = summary
    ? [
        value(summary.rank) != null
          ? renderStat(icon("military_tech", 20), view.label("community.page.gameRank", "Player rank"), value(summary.rank),
              value(summary.exp) != null ? html`<small>${view.label("community.page.gameExperience", "Experience")} ${value(summary.exp)}</small>` : nothing)
          : nothing,
        value(summary.rating) != null
          ? renderStat(icon("leaderboard", 20), view.label("community.page.gameRating", "High score rating"), value(summary.rating))
          : nothing,
        value(summary.members) != null
          ? renderStat(icon("groups", 20), view.label("community.page.gameMembers", "Members"), value(summary.members))
          : nothing,
        value(summary.snapshots) != null
          ? renderStat(icon("photo_library", 20), view.label("community.page.gameSnapshots", "Snapshots"), value(summary.snapshots))
          : nothing,
        startedMs != null
          ? renderStat(
              icon("calendar_month", 20),
              view.label("community.page.gameStarted", "Started"),
              html`<time datetime=${new Date(startedMs).toISOString()}>${formatDate(locale, startedMs, { year: "always" })}</time>`,
              html`<small>${view.label("community.page.gameDays", "{count} days", { count: number.format(days!) })}</small>`,
            )
          : nothing,
      ]
    : [];
  const synced = account.lastSyncedAt ?? (account.latestSnapshot as Value | null | undefined)?.capturedAt;
  const art = html`
    <span class="community-game-account__art">
      ${card?.image
        ? html`<img src=${card.image} alt="" width="96" height="96" loading="lazy" decoding="async" />`
        : icon("sports_esports", 40)}
    </span>
  `;
  return html`
    <article class="community-game-account">
      <header class="community-game-account__head">
        ${card ? html`<a class="community-game-account__card" href=${card.href} lang=${card.language} aria-label=${card.name}>${art}</a>` : art}
        <div class="community-game-account__identity">
          <h3>${name}</h3>
          <p class="community-game-account__meta">
            <img src=${regionOption.flag} width="20" height="20" alt="" />
            <span>${regionName}</span>
            <span aria-hidden="true">/</span>
            <span>${view.label("community.page.gameAccountPlayerId", "Player ID {id}", { id: playerUid })}</span>
          </p>
          ${account.verificationStatus === "verified"
            ? html`
                <div class="cluster community-game-account__chips">
                  <span class="chip chip--tonal chip--static">${icon("verified", 18)}<span class="chip__label">${view.label("community.page.gameVerified", "Verified")}</span></span>
                </div>
              `
            : nothing}
        </div>
        ${/* html`
        <a class="button button--tonal community-game-account__lookup" href=${playerProfileHref(locale, region, playerUid)}>
          ${icon("person_search", 18)}${view.label("tools.playerProfile.title", "Player lookup")}
        </a>
        ` */ nothing}
      </header>
      ${summary
        ? html`
            <div class="community-game-account__body">
              ${stats.some((stat) => stat !== nothing) ? html`<dl class="community-game-account__stats">${stats}</dl>` : nothing}
              ${renderClears(summary, view.showcase.songCounts.get(source), view)}
            </div>
          `
        : html`<p class="community-game-account__empty">${icon("cloud_off", 20)}<span>${view.label("community.page.gameNoData", "No public data")}</span></p>`}
      ${synced != null
        ? html`
            <footer class="community-game-account__foot">
              ${icon("sync", 18)}<span>${view.label("community.page.gameSynced", "Synced")}</span>${view.time(synced)}
            </footer>
          `
        : nothing}
    </article>
  `;
}

export function renderCommunityGameAccounts(accounts: readonly Value[], view: GameAccountsView) {
  return html`<div class="community-user-games__list">${accounts.map((account) => renderAccount(account, view))}</div>`;
}
