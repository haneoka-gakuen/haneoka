import { EVENT_LABEL_PATHS, SYSTEM_LABEL_PATHS } from "../i18n/system-labels";
import { cardRarityName, rarityIcon } from "./shared/rarity-icon";
/**
 * Detail sections for the rotating game systems (events, real lives, gacha,
 * login campaigns, shop, exchange, circle, challenge, missions, passes).
 *
 * These collections render through the generic catalogue screen; this module
 * is the per-resource body of the detail pane, in the same position — and
 * with the same house patterns — as card-detail is for cards and
 * song-detail-rewards is for songs: titled sections, spec lists, object
 * rows and related grids from the shared detail pattern, never a private
 * component tree.
 */

import { html, nothing } from "lit";
import { finiteExchangeCost } from "../lib/exchange-cost-summary";
import { filterChip, segmented } from "./ui/controls";
import { accordion } from "./ui/accordion";
import {
  availableShopCurrencies,
  convertShopPrice,
  fetchShopFxRates,
  formatMoney,
  shopPaymentPrices,
  localeShopCurrency,
  moneyName,
  shopPriceEntries,
} from "../lib/shop-currency";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { collectionTable } from "./ui/collection-view";
import { icon } from "./ui/icon";
import { tile, tileMedia, type TileMark } from "./ui/tile";
import { nextImageCandidate } from "./ui/lazy-images";
import { episodeArtwork } from "../lib/story-artwork";
import { storyTile } from "./shared/story-tile";
import { localizedContent } from "./ui/localized-content";
import { renderLevelSwitch } from "./ui/level-switch";
import { clientText } from "../i18n/client";
import {
  canSimulate,
  drawCountOf,
  gachaGuarantee,
  kindRarityCounts,
  simulateGacha,
  tallyGacha,
  useLimitOf,
  type GachaPrize,
  type GachaRun,
} from "../lib/gacha-simulation";
import "../styles/gacha-simulator.css";

type Item = Record<string, unknown>;
type Controller = Record<string, any>;

const EVENT_SCORE_RANK_NAMES = ["", "E", "D", "C", "B", "A", "S", "SS"];

function canonicalHref(c: Controller, href: string): string {
  if (!href) return "";
  return typeof c.resourceHref === "function" ? String(c.resourceHref(href) || href) : href;
}


/** Real-time rate session for the open shop detail; owned by the screen like sim. */
export interface ShopFxState {
  status: "loading" | "ready" | "error";
  rates?: import("../lib/shop-currency").ShopFxRates;
}

const rateText = (value: unknown, locale?: string) =>
  Number(value) > 0 ? `${(Number(value) * 100).toLocaleString(locale, { maximumFractionDigits: 3 })}%` : "";

const rarityMark = (c: Controller, value: unknown) => rarityIcon(c.rarityMark(value), cardRarityName(value));

/** One reward row: emblem, linked name, secondary credit, trailing number. */
function rewardRow(c: Controller, reward: Item, trailing: unknown = nothing, badgeLabel?: string) {
  const name = c.localized(reward.name);
  if (!name) return nothing;
  const secondary = c.localized(reward.secondary);
  const image = String(reward.image || "");
  const href = canonicalHref(c, String(reward.href || ""));
  const count = Number(reward.count || 0);
  const badgeKey = reward.pickup ? "pickup" : reward.bonus ? "bonus" : "";
  const badge =
    badgeLabel || badgeKey
      ? html`
          <span class="chip chip--static chip--assist" style="--chip-height:22px">
            <span class="chip__label">
              ${badgeLabel || c.label(badgeKey, badgeKey === "pickup" ? "Pickup" : "Bonus")}
            </span>
          </span>
        `
      : nothing;
  const copy = html`
    <span>
      ${name}
      ${
        secondary
          ? html`
              <small class="detail-copy">${secondary}</small>
            `
          : nothing
      }
      ${badge}
    </span>
  `;
  const trailingNode =
    trailing === nothing && count > 1
      ? html`
          <strong>×${count.toLocaleString(c.settings.locale)}</strong>
        `
      : trailing;
  const body = html`
    ${
      image
        ? html`
            <img src=${image} alt="" loading="lazy" decoding="async" />
          `
        : icon("redeem", 32)
    }
    ${copy} ${trailingNode}
  `;
  return href
    ? html`
        <a class="detail-object" href=${href}>${body}</a>
      `
    : html`
        <div class="detail-object">${body}</div>
      `;
}

function rewardSection(
  c: Controller,
  rewards: Item[],
  title: string,
  options: {
    kind?: any;
    collapsible?: boolean;
    /** Per-row trailing cell, e.g. a gacha prize's rate. */
    trailing?: (reward: Item) => unknown;
  } = {},
) {
  if (!rewards.length) return nothing;
  const list = html`
    <ul class="detail-object-list" role="list">
      ${rewards.map(
        (reward) => html`
          <li>${rewardRow(c, reward, options.trailing ? options.trailing(reward) : nothing)}</li>
        `,
      )}
    </ul>
  `;
  if (options.collapsible) return fold(c, `rewards-${options.kind || "rewards"}`, title, list);
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(title, options.kind || "rewards", { count: rewards.length })} ${list}
    </section>
  `;
}

/** Controlled detail fold; expanded state belongs to the catalogue controller. */
export function fold(c: Controller, key: string, title: unknown, content: unknown, meta: unknown = nothing) {
  const scope = JSON.stringify([
    c.dataServer(),
    c.settings.resource,
    c.itemKey(c.selected || {}),
  ]);
  const state = c.detailFoldState as { scope: string; expanded: Map<string, boolean> } | undefined;
  const current = state?.scope === scope ? state : { scope, expanded: new Map<string, boolean>() };
  c.detailFoldState = current;
  return accordion({
    id: `detail-fold-${encodeURIComponent(scope)}-${encodeURIComponent(key)}`,
    label: title,
    metadata: meta === nothing ? undefined : meta,
    expanded: current.expanded.get(key) ?? false,
    onExpandedChange: (expanded) => {
      current.expanded.set(key, expanded);
      c.requestUpdate();
    },
    className: "detail-fold",
    content: html`<div class="detail-fold__body">${content}</div>`,
  });
}

/** Currency-or-plain cost line with the emblem leading the figure. */
function costLine(amount: string, image: unknown) {
  if (!amount) return "";
  const emblem =
    typeof image === "string" && image
      ? html`
          <img src=${image} alt="" width="18" height="18" class="detail-cost__emblem" />
        `
      : nothing;
  return html`
    <span class="detail-cost">
      ${emblem}
      <span>${amount}</span>
    </span>
  `;
}

type CardTileKind = "member" | "support";

function cardTileKind(item: Item): CardTileKind | "" {
  return item.kind === "SupportCard" || Number(item.resourceType) === 3
    ? "support"
    : item.kind === "MemberCard" || Number(item.resourceType) === 2
      ? "member"
      : "";
}

function rewardCardOptions(c: Controller, reward: Item, kind: CardTileKind) {
  return c.cardTileOptions(
    {
      ...reward,
      [kind === "support" ? "supportCardId" : "cardId"]:
        reward[kind === "support" ? "supportCardId" : "cardId"] ?? reward.resourceId,
      prefix: reward.prefix || reward.name,
      cardName: reward.cardName || reward.secondary,
      images: reward.images || { thumbnail: reward.image },
    },
    kind,
  );
}

function gachaRewardTile(c: Controller, reward: Item, extraMarks: TileMark[] = [], subtitle = "") {
  const kind = cardTileKind(reward);
  const href = canonicalHref(c, String(reward.href || ""));
  if (kind && typeof c.cardTileOptions === "function") {
    const options = rewardCardOptions(c, reward, kind);
    return tile({ ...options, href: href || undefined, marks: [...(options.marks || []), ...extraMarks] });
  }
  const title = c.localized(reward.name) || c.label("reward", "Reward");
  return tile({
    kind: kind || "item",
    title,
    titleLanguage: c.localizedLanguage(reward.name),
    subtitle: subtitle || c.localized(reward.secondary),
    label: title,
    image: String(reward.image || ""),
    href: href || undefined,
    fit: "contain",
    marks: extraMarks,
  });
}

/** Use each resource's catalog tile and collection sizing wherever it is linked. */
function renderRewardGrid(c: Controller, rewards: Item[], marks: (reward: Item) => TileMark[] = () => []) {
  return html`
    <div class="detail-columns detail-columns--cards">
      ${(["member", "support", "item"] as const).map((kind) => {
        const entries = rewards.filter((reward) => (cardTileKind(reward) || "item") === kind);
        if (!entries.length) return nothing;
        const label = c.label(
          kind === "member" ? "memberCards" : kind === "support" ? "supportCards" : "items",
          kind === "member" ? "Member cards" : kind === "support" ? "Support cards" : "Items",
        );
        return html`
          <div class="stack stack--tight">
            <h4 class="md-title-small">${label}</h4>
            <div class=${`collection collection--${kind}`}>
              ${entries.map((reward) => gachaRewardTile(c, reward, marks(reward)))}
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

function featuredGrid(c: Controller, featured: Item[]) {
  if (!featured.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("featured", "Featured"), "cards", { count: featured.length })}
      ${renderRewardGrid(c, featured, (reward) =>
        Number(reward.rate) > 0
          ? [{ at: "bottom-start", text: rateText(reward.rate, c.settings.locale), label: c.label("rates", "Rates") }]
          : [],
      )}
    </section>
  `;
}

/** The game's own ratio table: one collapsible group per slot, prizes inside. */
function renderRates(c: Controller, item: Item) {
  const rates = Array.isArray(item.rates) ? (item.rates as Item[]) : [];
  if (!rates.length) return nothing;
  const slotLabel = (row: Item) => html`
    <span class="rarity-inline">
      ${c.label(String(row.resourceType || ""), String(row.resourceType || ""))}
      ${cardRarityName(row.rarity) ? rarityMark(c, row.rarity) : nothing}
    </span>
  `;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("rates", "Rates"), "works", { count: rates.length })}
      <div class="detail-fold-stack">
        ${rates.map((row, index) => {
          const prizes = (Array.isArray(row.prizes) ? row.prizes : []) as Item[];
          if (!prizes.length) return nothing;
          return fold(
            c,
            `rates-${index}`,
            slotLabel(row),
            html`
              <ul class="detail-object-list" role="list">
                ${prizes.map(
                  (prize) => html`
                    <li>
                      ${rewardRow(
                        c,
                        prize,
                        html`
                          <strong>${rateText(prize.rate, c.settings.locale)}</strong>
                        `,
                      )}
                    </li>
                  `,
                )}
              </ul>
            `,
            rateText(row.rate, c.settings.locale),
          );
        })}
      </div>
      ${
        c.localized(item.warning)
          ? html`
              <p class="detail-copy">${c.plainGameText(item.warning)}</p>
            `
          : nothing
      }
    </section>
  `;
}

const gachaOptions = (item: Item): Item[] => (Array.isArray(item.drawOptions) ? (item.drawOptions as Item[]) : []);
const gachaOptionKey = (item: Item, option: Item): string => String(option.id ?? gachaOptions(item).indexOf(option));
const MAX_SIMULATED_DRAWS = 3000;

export interface GachaSimState {
  /** Recruitments to run with the selected option. */
  uses: number;
  view: "pulls" | "stats";
  runs: GachaRun[];
  exporting?: boolean;
}

const simText = (c: Controller, key: string, fallback: string, values?: Record<string, unknown>) =>
  clientText(c.settings.locale, `catalog.recruitments.${key}`, fallback, values as never);

const simState = (c: Controller): GachaSimState => (c.sim as GachaSimState | null) || { uses: 10, view: "pulls", runs: [] };

function usedOf(item: Item, runs: readonly GachaRun[], option: Item) {
  const key = gachaOptionKey(item, option);
  return runs.filter((run) => gachaOptionKey(item, run.option) === key).reduce((sum, run) => sum + run.pulls.length, 0);
}

/** Recruitments still possible with this option: its use limit and the session's draw ceiling. */
function maxUses(item: Item, runs: readonly GachaRun[], option: Item) {
  const drawn = runs.reduce((sum, run) => sum + run.draws, 0);
  const byDraws = Math.floor((MAX_SIMULATED_DRAWS - drawn) / drawCountOf(option));
  const limit = useLimitOf(option);
  return Math.max(0, limit ? Math.min(byDraws, limit - usedOf(item, runs, option)) : byDraws);
}

/** Attribute and rarity emblems for a drawn card, from its catalogue tile. */
function prizeMarks(c: Controller, prize: GachaPrize) {
  if (prize.kind === "item" || typeof c.cardTileOptions !== "function") return { attribute: "", rarityMark: "" };
  const marks = (rewardCardOptions(c, prize.source, prize.kind).marks || []) as Array<TileMark | null>;
  return {
    attribute: String(marks.find((mark) => mark?.at === "start")?.image || ""),
    rarityMark: String(marks.find((mark) => mark?.at === "end")?.image || ""),
  };
}

function prizeCard(c: Controller, prize: GachaPrize, marks: ReturnType<typeof prizeMarks>, count = 0) {
  const name = c.localized(prize.source.name) || c.label("reward", "Reward");
  const href = canonicalHref(c, String(prize.source.href || ""));
  const body = html`
    <img class="gacha-card__art" src=${String(prize.source.image || "")} alt="" loading="lazy" decoding="async" />
    ${marks.attribute ? html`<img class="gacha-card__attribute" src=${marks.attribute} alt="" />` : nothing}
    ${marks.rarityMark ? html`<img class="gacha-card__rarity" src=${marks.rarityMark} alt="" />` : nothing}
    ${prize.pickup ? html`<span class="gacha-card__pickup">UP</span>` : nothing}
    ${count ? html`<span class="gacha-card__count tabular">×${count}</span>` : nothing}
  `;
  const label = `${cardRarityName(prize.rarity)} ${name}${count > 1 ? ` ×${count}` : ""}`;
  return href
    ? html`<a class="gacha-card" data-kind=${prize.kind} data-rarity=${prize.rarity} href=${href} title=${label} aria-label=${label}>${body}</a>`
    : html`<span class="gacha-card" data-kind=${prize.kind} data-rarity=${prize.rarity} title=${label} role="img" aria-label=${label}>${body}</span>`;
}

/** One row per recruitment of five or more draws; single draws packed ten to a row. */
function runRows(run: GachaRun, offset: number): Array<{ start: number; prizes: GachaPrize[] }> {
  const size = drawCountOf(run.option);
  if (size >= 5) return run.pulls.map((prizes, index) => ({ start: offset + index * size + 1, prizes }));
  const flat = run.pulls.flat();
  return Array.from({ length: Math.ceil(flat.length / 10) }, (_, index) => ({
    start: offset + index * 10 + 1,
    prizes: flat.slice(index * 10, index * 10 + 10),
  }));
}

function optionLabel(c: Controller, option: Item) {
  return `${eventText(c, "draw", "{count} draws", { count: drawCountOf(option) })} · ${c.localized(option.currency) || c.label("free", "Free")}`;
}

const kindLabel = (c: Controller, kind: string) =>
  c.label(kind === "member" ? "memberCards" : kind === "support" ? "supportCards" : "items", kind);

function batchLabel(c: Controller, run: GachaRun) {
  return `${optionLabel(c, run.option)} × ${run.pulls.length.toLocaleString(c.settings.locale)}`;
}

function sessionCosts(runs: readonly GachaRun[]) {
  const costs = new Map<string, { currency: unknown; image: string; spent: number }>();
  for (const run of runs) {
    const key = JSON.stringify([run.option.currencyImage || "", run.option.currency || []]);
    const cost = costs.get(key) || { currency: run.option.currency, image: String(run.option.currencyImage || ""), spent: 0 };
    cost.spent += run.cost;
    costs.set(key, cost);
  }
  return [...costs.values()];
}

async function exportGachaImage(c: Controller, item: Item, state: GachaSimState) {
  if (!state.runs.length || state.exporting) return;
  c.sim = { ...state, exporting: true };
  c.requestUpdate();
  try {
    const { renderGachaImage } = await import("../lib/gacha-simulation-image");
    const marks = new Map<string, ReturnType<typeof prizeMarks>>();
    const card = (prize: GachaPrize, count = 0) => {
      if (!marks.has(prize.key)) marks.set(prize.key, prizeMarks(c, prize));
      return { kind: prize.kind, rarity: prize.rarity, pickup: prize.pickup, image: String(prize.source.image || ""), count, ...marks.get(prize.key)! };
    };
    const tally = tallyGacha(state.runs);
    const draws = state.runs.reduce((sum, run) => sum + run.draws, 0);
    const points = state.runs.reduce((sum, run) => sum + run.points, 0);
    let offset = 0;
    const blob = await renderGachaImage({
      mode: state.view,
      title: c.localized(item.title) || "",
      subtitle: `${c.label("drawCount", "Draws")} ${draws.toLocaleString(c.settings.locale)}`,
      summary: [
        {
          label: c.label("spent", "Cost"),
          entries: [
            ...sessionCosts(state.runs).map((cost) => ({
              image: cost.image,
              label: c.localized(cost.currency) || c.label("free", "Free"),
              count: cost.spent,
            })),
            ...(points ? [{ label: c.label("gachaPoint", "Gacha points"), count: points }] : []),
          ],
        },
        ...kindRarityCounts(state.runs).map(({ kind, counts }) => ({
          label: kindLabel(c, kind),
          entries: counts.map(([rarity, count]) => ({ image: c.rarityMark(rarity) as string, label: cardRarityName(rarity), count })),
        })),
        { label: "", entries: [{ label: "UP", count: state.runs.flatMap((run) => run.pulls.flat()).filter((prize) => prize.pickup).length }] },
      ],
      batches: state.runs.map((run) => {
        const rows = runRows(run, offset).map((row) => ({ label: `#${row.start}`, cards: row.prizes.map((prize) => card(prize)) }));
        offset += run.draws;
        return { label: batchLabel(c, run), rows };
      }),
      groups: (["member", "support", "item"] as const)
        .filter((kind) => tally[kind].length)
        .map((kind) => ({ kind, label: kindLabel(c, kind), cards: tally[kind].map((entry) => card(entry.prize, entry.count)) })),
      brand: { name: "haneoka", url: "haneoka.org", logo: "/android-chrome-192x192.png" },
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `gacha-${String(item.id || "")}-${state.view}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } finally {
    c.sim = { ...(c.sim as GachaSimState), exporting: false };
    c.requestUpdate();
  }
}

function renderSimulationSummary(c: Controller, runs: readonly GachaRun[]) {
  const locale = c.settings.locale;
  const draws = runs.reduce((sum, run) => sum + run.draws, 0);
  const points = runs.reduce((sum, run) => sum + run.points, 0);
  const groups = kindRarityCounts(runs);
  const rarities = [...new Set(groups.flatMap((group) => group.counts.map(([rarity]) => rarity)))].sort((a, b) => b - a);
  const cell = (count: number) =>
    count
      ? html`${count.toLocaleString(locale)} <small>${((count / draws) * 100).toLocaleString(locale, { maximumFractionDigits: 2 })}%</small>`
      : "—";
  const totals = rarities.map((rarity) => groups.reduce((sum, group) => sum + (group.counts.find(([value]) => value === rarity)?.[1] || 0), 0));
  return html`
    <dl class="spec-list spec-list--split spec-list--numeric">
      <div><dt>${c.label("drawCount", "Draws")}</dt><dd>${draws.toLocaleString(locale)}</dd></div>
      ${sessionCosts(runs).map(
        (cost) => html`
          <div>
            <dt>${c.label("spent", "Cost")} · ${c.localized(cost.currency) || c.label("free", "Free")}</dt>
            <dd>${cost.spent ? costLine(cost.spent.toLocaleString(locale), cost.image) : c.label("free", "Free")}</dd>
          </div>
        `,
      )}
      ${points ? html`<div><dt>${c.label("gachaPoint", "Gacha points")}</dt><dd>${points.toLocaleString(locale)}</dd></div>` : nothing}
      <div>
        <dt><span class="gacha-card__pickup gacha-card__pickup--inline">UP</span></dt>
        <dd>${runs.flatMap((run) => run.pulls.flat()).filter((prize) => prize.pickup).length.toLocaleString(locale)}</dd>
      </div>
    </dl>
    ${collectionTable(
      c.label("drawCount", "Draws"),
      ["", ...rarities.map((rarity) => rarityMark(c, rarity))],
      [
        ...groups.map((group) => [
          kindLabel(c, group.kind),
          ...rarities.map((rarity) => cell(group.counts.find(([value]) => value === rarity)?.[1] || 0)),
        ]),
        ...(groups.length > 1 ? [[simText(c, "total", "Total"), ...totals.map(cell)]] : []),
      ],
      { numeric: true },
    )}
  `;
}

function renderSimulator(c: Controller, item: Item) {
  const options = gachaOptions(item);
  if (!options.length) return nothing;
  const selected = options.find((option) => gachaOptionKey(item, option) === c.gachaOption) || options[0]!;
  const key = gachaOptionKey(item, selected);
  const state = simState(c);
  const runs = state.runs;
  const size = drawCountOf(selected);
  const available = maxUses(item, runs, selected);
  const uses = Math.min(Math.max(1, Math.floor(state.uses) || 1), Math.max(1, available));
  const ready = canSimulate(item, selected) && available > 0;
  const guarantee = gachaGuarantee(selected);
  const locale = c.settings.locale;
  const price = Math.max(0, Number(selected.price) || 0);
  const update = (next: Partial<GachaSimState>) => {
    c.sim = { ...simState(c), ...next };
    c.requestUpdate();
  };
  const simulate = () => {
    const run = simulateGacha(item, selected, uses, usedOf(item, runs, selected));
    update({ runs: [...runs, run], uses });
  };
  const marks = new Map<string, ReturnType<typeof prizeMarks>>();
  const cardFor = (prize: GachaPrize, count = 0) => {
    if (!marks.has(prize.key)) marks.set(prize.key, prizeMarks(c, prize));
    return prizeCard(c, prize, marks.get(prize.key)!, count);
  };
  const tally = runs.length ? tallyGacha(runs) : null;
  let offset = 0;
  return html`
    <section class="detail-section gacha-sim" data-gacha-simulator>
      ${renderDetailSectionHeading(c.label("simulator", "Simulator"), "difficulty")}
      <form
        class="gacha-sim__controls"
        @submit=${(event: Event) => {
          event.preventDefault();
          if (ready) simulate();
        }}
      >
        <md-outlined-select
          label=${c.label("drawOptions", "Draw options")}
          .value=${key}
          .displayText=${optionLabel(c, selected)}
          @change=${(event: Event) => {
            c.gachaOption = (event.target as HTMLSelectElement).value;
            c.requestUpdate();
          }}
        >
          ${options.map(
            (option) => html`
              <md-select-option value=${gachaOptionKey(item, option)} ?selected=${gachaOptionKey(item, option) === key}>
                <div slot="headline">${optionLabel(c, option)}</div>
              </md-select-option>
            `,
          )}
        </md-outlined-select>
        <md-outlined-text-field
          type="number"
          label=${simText(c, "useCount", "Recruitments")}
          suffix-text=${`= ${(uses * size).toLocaleString(locale)}`}
          .value=${String(uses)}
          min="1"
          max=${Math.max(1, available)}
          step="1"
          ?disabled=${!available}
          @change=${(event: Event) => update({ uses: Number((event.target as HTMLInputElement).value) || 1 })}
        ></md-outlined-text-field>
        <button class="button" type="submit" ?disabled=${!ready}>${icon("casino", 18)}${simText(c, "simulate", "Simulate")}</button>
      </form>
      <ul class="chip-set" role="list">
        <li class="chip chip--static">
          ${price
            ? costLine(price.toLocaleString(locale), selected.currencyImage)
            : html`<span class="chip__label">${c.label("free", "Free")}</span>`}
          <span class="chip__label">/ ${eventText(c, "draw", "{count} draws", { count: size })}</span>
        </li>
        ${Number(selected.firstPrice) > 0
          ? html`<li class="chip chip--static">
              <span class="chip__label">${c.label("firstTime", "First time")}</span>
              ${costLine(Number(selected.firstPrice).toLocaleString(locale), selected.currencyImage)}
            </li>`
          : nothing}
        ${guarantee
          ? html`<li class="chip chip--static">
              ${eventText(c, "guaranteedDraws", "At least {count} {rarity} or higher", { count: guarantee.count, rarity: "￼" })
                .split("￼")
                .map((part, index) => html`${index ? rarityMark(c, guarantee.rarity) : nothing}<span class="chip__label">${part}</span>`)}
            </li>`
          : nothing}
        ${useLimitOf(selected)
          ? html`<li class="chip chip--static">
              <span class="chip__label">${c.label("limit", "Limit")} ${usedOf(item, runs, selected)} / ${useLimitOf(selected)}</span>
            </li>`
          : nothing}
      </ul>
      ${!canSimulate(item, selected)
        ? html`<p class="detail-copy" role="status">${c.label("simulationUnavailable", "Complete rates are required to simulate this recruitment.")}</p>`
        : nothing}
      ${runs.length && tally
        ? html`
            ${renderSimulationSummary(c, runs)}
            <div class="gacha-sim__toolbar">
              ${segmented({
                label: c.label("simulator", "Simulator"),
                grow: false,
                value: state.view,
                options: [
                  { value: "pulls", label: simText(c, "viewPulls", "Each draw"), icon: "view_list" },
                  { value: "stats", label: simText(c, "viewStats", "Summary"), icon: "leaderboard" },
                ],
                onSelect: (view) => update({ view }),
              })}
              <div class="cluster">
                <button class="button button--text" type="button" @click=${() => update({ runs: [] })}>
                  ${icon("restart_alt", 18)}${simText(c, "reset", "Reset")}
                </button>
                <button class="button button--tonal" type="button" ?disabled=${state.exporting} @click=${() => void exportGachaImage(c, item, state)}>
                  ${icon("download", 18)}${simText(c, "exportImage", "Save image")}
                </button>
              </div>
            </div>
            ${state.view === "pulls"
              ? runs.map((run, index) => {
                  const rows = runRows(run, offset);
                  offset += run.draws;
                  return html`
                    <section class="gacha-batch">
                      <h4 class="gacha-batch__title">
                        <span class="tabular">${index + 1}</span>
                        <span>${batchLabel(c, run)}</span>
                        <span class="gacha-batch__meta tabular">${run.cost ? costLine(run.cost.toLocaleString(locale), run.option.currencyImage) : nothing}</span>
                      </h4>
                      <ol class="gacha-pulls" role="list">
                        ${rows.map(
                          (row) => html`
                            <li class="gacha-pulls__row">
                              <span class="gacha-pulls__index tabular">#${row.start}</span>
                              <div class="gacha-pulls__cards">${row.prizes.map((prize) => cardFor(prize))}</div>
                            </li>
                          `,
                        )}
                      </ol>
                    </section>
                  `;
                })
              : (["member", "support", "item"] as const).map((kind) =>
                  tally[kind].length
                    ? html`
                        <section class="stack stack--tight">
                          <h4 class="md-title-small">
                            ${kindLabel(c, kind)}
                            <span class="tabular">${tally[kind].length} · ${tally[kind].reduce((sum, entry) => sum + entry.count, 0)}</span>
                          </h4>
                          <div class="gacha-stats" data-kind=${kind}>${tally[kind].map((entry) => cardFor(entry.prize, entry.count))}</div>
                        </section>
                      `
                    : nothing,
                )}
          `
        : nothing}
    </section>
  `;
}

/** Day-indexed reward sheets, listed one day per row rather than one row per item. */
function renderLoginDays(c: Controller, rewards: Item[]) {
  if (!rewards.length) return nothing;
  const days = new Map<number, Item[]>();
  for (const slot of rewards) {
    const key = Number(slot.day || 0);
    const list = days.get(key) || [];
    list.push((slot.reward || {}) as Item);
    days.set(key, list);
  }
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("dailyRewards", "Daily rewards"), "rewards", { count: days.size })}
      <dl class="spec-list spec-list--split">
        ${[...days.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(
            ([day, rows]) => html`
              <div>
                <dt>${c.label("dayN", "Day {day}").replace("{day}", day.toLocaleString(c.settings.locale))}</dt>
                <dd>
                  <div class="detail-object-list">${rows.map((reward) => rewardRow(c, reward))}</div>
                </dd>
              </div>
            `,
          )}
      </dl>
    </section>
  `;
}

function renderExchangeGoods(c: Controller, item: Item) {
  const products = Array.isArray(item.products) ? (item.products as Item[]) : [];
  if (!products.length) return nothing;
  const currency = (item.currency || {}) as Item;
  const scope = `${c.itemSourceServer(item)}:${c.payload?.releaseId ?? c.nativeCatalogPin?.releaseId ?? ""}:${item.id}`;
  if (c.detailExchangeScope !== scope) {
    c.detailExchangeScope = scope;
    c.detailExchangeOnlyFinite = false;
  }
  const totals = finiteExchangeCost(products);
  const shown = c.detailExchangeOnlyFinite
    ? products.filter((product) => typeof product.limit === "number" && Number.isSafeInteger(product.limit) && product.limit > 0)
    : products;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("exchangeGoods", "Exchange goods"), "content", { count: shown.length })}
      <dl class="spec-list">
        <div>
          <dt>${c.label("exchangeFiniteTotal", "Full finite stock cost")}</dt>
          <dd>${totals.total === undefined
            ? c.label("exchangeUnknownCost", "Some product costs or limits are unavailable")
            : costLine(`${totals.total.toLocaleString(c.settings.locale)} ${c.localized(currency.name)}`, currency.image)}</dd>
        </div>
      </dl>
      <p class="detail-copy">${c.label("exchangeFullStockHint", "All listed finite stock; prior purchases are not deducted. Unlimited goods are excluded.")}</p>
      ${filterChip({
        label: c.label("exchangeFiniteOnly", "Finite stock only"), selected: Boolean(c.detailExchangeOnlyFinite),
        count: totals.finite,
        onToggle: () => { c.detailExchangeOnlyFinite = !c.detailExchangeOnlyFinite; c.requestUpdate(); },
      })}
      <ul class="detail-object-list" role="list">
        ${shown.map((product) => {
          const cost = typeof product.cost === "number" && Number.isSafeInteger(product.cost) && product.cost >= 0
            ? product.cost.toLocaleString(c.settings.locale) : c.label("unknown", "Unknown");
          const limit = typeof product.limit === "number" && Number.isSafeInteger(product.limit)
            ? product.limit > 0 ? String(product.limit) : c.label("unlimited", "Unlimited")
            : c.label("unknown", "Unknown");
          return rewardRow(
            c, (product.reward || {}) as Item,
            html`<span><strong>${costLine(`${cost} ${c.localized(currency.name)}`, currency.image)}</strong>
              <small class="detail-copy">${c.label("exchangePurchaseLimit", "Purchase limit")}: ${limit}</small></span>`,
          );
        })}
      </ul>
    </section>
  `;
}

function renderShopFacts(c: Controller, item: Item) {
  const payment = (item.payment || {}) as Item;
  const rows: Array<{ label: string; value: unknown }> = [];
  const prices = shopPaymentPrices(payment, c.itemSourceServer(item));
  if (payment.advertisement) {
    rows.push({ label: c.detailLabel("price"), value: c.label("watchAd", "Watch an ad") });
  } else {
    // Cash entries read like the song page's difficulty facts: one spec row
    // per storefront currency, with the real-time conversion into the
    // reading locale's own currency attached under the price. In-game
    // currency rows keep the emblem figure.
    const fx = c.fx as ShopFxState | null;
    const target = localeShopCurrency(c.settings.locale);
    for (const { code, amount } of shopPriceEntries(prices)) {
      const price = formatMoney(amount, code, c.settings.locale);
      const rate = fx?.status === "ready" && code !== target ? fx.rates?.rates[code] : undefined;
      // While rates load, the conversion's line is held by a placeholder of
      // the same size, so the facts below never move when the rate lands.
      const converted =
        rate && Number.isFinite(convertShopPrice(amount, code, target, fx!.rates!))
          ? html`
              <small class="shop-fx__note">
                ≈ ${formatMoney(convertShopPrice(amount, code, target, fx!.rates!), target, c.settings.locale)}
              </small>
            `
          : code !== target && (!fx || fx.status === "loading")
            ? html`<small class="shop-fx__note" aria-hidden="true"><span class="skeleton-line">≈ US$0.00</span></small>`
            : nothing;
      rows.push({
        label: moneyName(code, c.settings.locale),
        value: html`
          ${price} ${converted}
        `,
      });
    }
    if (!availableShopCurrencies(prices).length) {
      if (payment.storePurchase && !Number(payment.price || 0))
        rows.push({ label: c.detailLabel("price"), value: c.label("inAppPurchase", "In-app purchase") });
      else if (Number(payment.price || 0))
        rows.push({
          label: c.detailLabel("price"),
          value: costLine(
            `${Number(payment.price).toLocaleString(c.settings.locale)} ${c.localized(payment.currency)}`,
            payment.currencyImage,
          ),
        });
    }
  }
  if (Number(item.limit || 0))
    rows.push({ label: c.detailLabel("limit"), value: Number(item.limit).toLocaleString(c.settings.locale) });
  if (Number(item.vipRank || 0))
    rows.push({
      label: c.detailLabel("tgwCard"),
      value: c.label("requiresRank", "Rank {rank}").replace("{rank}", String(item.vipRank)),
    });
  if (!rows.length) return nothing;
  return html`
    <section class="detail-section detail-section--facts">
      ${renderDetailSectionHeading(c.label("details", "Details"), "details")}
      <dl class="spec-list spec-list--split">
        ${rows.map(
          ({ label, value }) => html`
            <div>
              <dt>${label}</dt>
              <dd>${value}</dd>
            </div>
          `,
        )}
      </dl>
    </section>
  `;
}

async function loadShopFx(c: Controller) {
  c.fx = { status: "loading" };
  c.requestUpdate();
  const rates = await fetchShopFxRates();
  c.fx = rates ? { status: "ready", rates } : { status: "error" };
  c.requestUpdate();
}

/** Level-indexed pass rewards: one row per level, its tracks badged Free/Premium. */
function renderPassLevels(c: Controller, levels: Item[]) {
  if (!levels.length) return nothing;
  const grouped = new Map<number, Array<{ premium: boolean; rewards: Item[] }>>();
  for (const level of levels) {
    const key = Number(level.level || 0);
    const list = grouped.get(key) || [];
    list.push({
      premium: Boolean(level.premium),
      rewards: (Array.isArray(level.rewards) ? level.rewards : []) as Item[],
    });
    grouped.set(key, list);
  }
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("levelRewards", "Level rewards"), "rewards", { count: grouped.size })}
      <dl class="spec-list spec-list--split">
        ${[...grouped.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(
            ([level, tracks]) => html`
              <div>
                <dt>Lv.${level.toLocaleString(c.settings.locale)}</dt>
                <dd>
                  <div class="detail-object-list">
                    ${tracks.flatMap((track) =>
                      track.rewards.map((reward) =>
                        rewardRow(
                          c,
                          reward,
                          nothing,
                          c.label(track.premium ? "premium" : "free", track.premium ? "Premium" : "Free"),
                        ),
                      ),
                    )}
                  </div>
                </dd>
              </div>
            `,
          )}
      </dl>
    </section>
  `;
}

function renderPassMissions(c: Controller, tasks: Item[]) {
  if (!tasks.length) return nothing;
  return fold(
    c,
    "pass-missions",
    c.label("passMissions", "Pass missions"),
    html`
      <ul class="detail-object-list" role="list">
        ${tasks.map(
          (task) => html`
            <li>
              ${rewardRow(
                c,
                { name: task.title } as Item,
                html`
                  <strong>
                    ${Number(task.points || 0).toLocaleString(c.settings.locale)} ${c.label("points", "pt")}
                  </strong>
                `,
              )}
            </li>
          `,
        )}
      </ul>
    `,
  );
}

function renderEventBands(c: Controller, bands: Item[]) {
  if (!bands.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("bands", "Bands"), "details", { count: bands.length })}
      <ul class="detail-object-list" role="list">
        ${bands.map((band) => rewardRow(c, { name: band.name, image: band.logo || band.icon } as Item))}
      </ul>
    </section>
  `;
}

function eventRewardValue(row: Item): Item {
  const nested = row.reward && typeof row.reward === "object" ? (row.reward as Item) : row;
  return nested && typeof nested === "object" ? nested : {};
}

/** Interpolate the authored message before rendering it, including repeated tokens. */
function eventText(c: Controller, key: string, fallback: string, values: Record<string, unknown> = {}): string {
  const format = (template: string) =>
    template.replace(/\{([\w.]+)(?::[^}]*)?\}/gu, (token, name: string) => {
      const value = values[name];
      return value === undefined
        ? token
        : typeof value === "number"
          ? value.toLocaleString(c.settings.locale)
          : String(value);
    });
  const result = format(c.label(EVENT_LABEL_PATHS[key] ?? SYSTEM_LABEL_PATHS[key] ?? key, fallback));
  return /\{[^{}]+\}/u.test(result) ? format(fallback) : result;
}

const eventRows = (value: unknown): Item[] =>
  Array.isArray(value) ? value.filter((row): row is Item => Boolean(row && typeof row === "object")) : [];
const eventRaw = (row: Item): Item => (row.raw && typeof row.raw === "object" ? (row.raw as Item) : {});
const eventNumber = (c: Controller, value: unknown) => Number(value ?? 0).toLocaleString(c.settings.locale);
const eventPoints = (c: Controller, value: unknown) =>
  eventText(c, "eventPoints", "{points} pt", { points: Number(value ?? 0) });

function eventRewardCondition(c: Controller, row: Item): string {
  const raw = eventRaw(row);
  if (row.sourceTable === "MasterEventAchievementLoopReward")
    return eventText(c, "eventLoopCondition", "Every {every} pt after {from} pt", {
      every: Number(raw._loopEventPoint ?? 0),
      from: Number(raw._loopStartEventPoint ?? 0),
    });
  const values: string[] = [];
  const point = raw._eventPoint ?? raw._point ?? raw._requiredPoint;
  if (point !== undefined) values.push(eventPoints(c, point));
  const rank = raw._rank ?? raw._ranking;
  if (rank !== undefined) values.push(eventText(c, "eventRankN", "Rank {rank}", { rank: Number(rank) }));
  if (raw._scoreRank !== undefined) values.push(EVENT_SCORE_RANK_NAMES[Number(raw._scoreRank)] || "—");
  for (const [field, key, fallback] of [
    ["_achievementCount", "eventGoalN", "Goal {count}"],
    ["_limitCount", "eventLimitN", "Limit {count}"],
    ["_boxNumber", "eventBoxN", "Box {count}"],
  ] as const)
    if (Number(raw[field]) > 0) values.push(eventText(c, key, fallback, { count: Number(raw[field]) }));
  return values.join(" · ");
}

/** One resource with its quantity and authored probability. */
function eventRewardRow(c: Controller, row: Item, quantity = true, compactIdentity = false) {
  const reward = eventRewardValue(row);
  const name = c.localized(reward.name) || c.label("rewardUnavailable", "Reward unavailable");
  const secondary = c.localized(reward.secondary);
  const count = Number(reward.count ?? row.resourceCount ?? 1);
  const probability = eventRaw(row)._probability;
  const href = canonicalHref(c, String(reward.href || ""));
  const kind = cardTileKind(reward);
  if (compactIdentity && kind) {
    const options = rewardCardOptions(c, reward, kind);
    const content = html`
      <span class=${`detail-object__artwork tile--${kind}`}>${tileMedia(options)}</span>
      <span class="tile__identity detail-object__copy" title=${[name, secondary].filter(Boolean).join(" · ")}>
        <strong class="tile__title" lang=${options.titleLanguage || nothing}>${options.title}</strong>
        <small class="tile__subtitle">
          ${options.adornment || nothing}
          <span>${options.subtitle}</span>
        </small>
      </span>
    `;
    return html`
      <li>
        ${
          href
            ? html`
                <a class="detail-object" href=${href}>${content}</a>
              `
            : html`
                <div class="detail-object">${content}</div>
              `
        }
      </li>
    `;
  }
  const body = html`
    ${
      reward.image
        ? html`
            <img src=${String(reward.image)} alt="" width="32" height="32" loading="lazy" decoding="async" />
          `
        : icon("redeem", 24)
    }
    <span
      title=${compactIdentity ? [name, secondary].filter(Boolean).join(" · ") : nothing}
      lang=${c.localizedLanguage(reward.name) || nothing}
    >
      ${
        compactIdentity
          ? html`
              <span class="clamp-2">${name}</span>
            `
          : name
      }${
        secondary && secondary !== name
          ? html`
              <small
                class=${compactIdentity ? "detail-copy truncate" : "detail-copy"}
                lang=${c.localizedLanguage(reward.secondary) || nothing}
              >
                ${secondary}
              </small>
            `
          : nothing
      }
      ${
        probability !== undefined && Number(probability) < 10000
          ? html`
              <small class="detail-copy">
                ${eventText(c, "eventProbability", "{rate}% chance", { rate: Number(probability) / 100 })}
              </small>
            `
          : nothing
      }
    </span>
    ${
      quantity
        ? html`
            <strong>×${eventNumber(c, count)}</strong>
          `
        : nothing
    }
  `;
  return html`
    <li>
      ${
        href
          ? html`
              <a class="detail-object" href=${href}>${body}</a>
            `
          : html`
              <div class="detail-object">${body}</div>
            `
      }
    </li>
  `;
}

function renderRotatingOverview(c: Controller, item: Item) {
  const instant = (value: unknown) =>
    Number((Array.isArray(value) ? value.find((part) => Number(part) > 0) : value) || 0);
  const start = instant(item.startAt),
    end = instant(item.endAt);
  const state = start > Date.now() ? "upcoming" : end && end < Date.now() ? "ended" : "ongoing";
  const eventItem = item.eventItem && typeof item.eventItem === "object" ? (item.eventItem as Item) : null;
  const rankingFields = [
    ["rankingDisabled", "eventScoreRanking", "Score ranking"],
    ["musicRankingDisabled", "eventSongRanking", "Song ranking"],
    ["totalMusicRankingDisabled", "eventTotalSongRanking", "Total song ranking"],
  ];
  const activeRankings = rankingFields.filter(([field]) => item[field] === false);
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("details", "Details"), "details")}
      ${
        start || end
          ? html`
              <div class="cluster">
                <span class="chip chip--static">
                  <span class="chip__label">
                    ${c.label(state, state === "ongoing" ? "Ongoing" : state === "upcoming" ? "Upcoming" : "Ended")}
                  </span>
                </span>
              </div>
            `
          : nothing
      }
      <dl class="spec-list spec-list--split">
        ${
          item.category
            ? html`
                <div>
                  <dt>${c.label("category", "Category")}</dt>
                  <dd>${c.label(String(item.category), String(item.category))}</dd>
                </div>
              `
            : nothing
        }
        ${[
          ["startAt", start],
          ["endAt", end],
        ].map(([key, value]) =>
          value
            ? html`
                <div>
                  <dt>${c.label(key === "startAt" ? "starts" : "ends", key === "startAt" ? "Starts" : "Ends")}</dt>
                  <dd>
                    <time datetime=${new Date(Number(value)).toISOString()}>${c.release(value)}</time>
                  </dd>
                </div>
              `
            : nothing,
        )}
        ${
          rankingFields.some(([field]) => typeof item[field] === "boolean")
            ? html`
                <div class="spec-list__wide">
                  <dt>${c.label("eventAvailableRankings", "Rankings")}</dt>
                  <dd>
                    ${activeRankings.length ? activeRankings.map(([, key, fallback]) => c.label(key, fallback)).join(" · ") : c.label("eventRankingOff", "No rankings")}
                  </dd>
                </div>
              `
            : nothing
        }
        ${
          eventItem
            ? html`
                <div class="spec-list__wide">
                  <dt>${c.label("eventItem", "Event item")}</dt>
                  <dd>
                    <ul class="detail-object-list">
                      ${eventRewardRow(c, eventItem, false)}
                    </ul>
                  </dd>
                </div>
              `
            : nothing
        }
      </dl>
      ${
        c.plainGameText(item.description)
          ? html`
              <p class="detail-copy" lang=${c.localizedLanguage(item.description) || nothing}>
                ${c.plainGameText(item.description)}
              </p>
            `
          : nothing
      }
    </section>
  `;
}

function renderEventSong(c: Controller, item: Item) {
  if (!item.song || typeof item.song !== "object") return nothing;
  const song = item.song as Item;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("eventSong", "Event song"), "songs")}
      <div class="collection collection--song">
        ${tile({ ...c.songTileOptions(song), href: canonicalHref(c, String(song.href || "")) || undefined })}
      </div>
    </section>
  `;
}

function renderEventCardGrid(c: Controller, cards: Item[]) {
  return renderRewardGrid(c, cards, (card) =>
    Number(card.rate) > 0
      ? [{ at: "bottom-start", text: eventText(c, "eventUpRate", "UP {rate}%", { rate: Number(card.rate) * 100 }) }]
      : [],
  );
}

function renderEventPickups(c: Controller, item: Item) {
  const cards = eventRows(item.pickupCards).map((row) => ({
    ...eventRewardValue(row.card as Item),
    resourceType: row.resourceType,
  }));
  if (!cards.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("eventRewardCards", "Event reward cards"), "cards", { count: cards.length })}${renderEventCardGrid(c, cards)}
    </section>
  `;
}

function renderEventRecruitments(c: Controller, item: Item) {
  const recruitments = eventRows(item.recruitments);
  if (!recruitments.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("eventRecruitments", "Related recruitments"), "content", { count: recruitments.length })}
      <div class="collection collection--system">
        ${recruitments.map((gacha) => {
          const title = c.localized(gacha.title);
          return tile({
            kind: "system",
            title,
            titleLanguage: c.localizedLanguage(gacha.title),
            subtitle: c.systemRelativeSubtitle(gacha),
            label: title,
            image: String(gacha.image || ""),
            aspectRatio: "16 / 9",
            href: canonicalHref(c, String(gacha.href || "")) || undefined,
            fit: "contain",
          });
        })}
      </div>
    </section>
  `;
}

function renderEventStory(c: Controller, item: Item) {
  const story = item.story && typeof item.story === "object" ? (item.story as Item) : null;
  if (!story) return nothing;
  const episodes = eventRows(story.episodes);
  const groups = [
    ["eventMainEpisodes", "Main", episodes.filter((row) => !row.isExtraEpisode && !row.isAnotherEpisode)],
    ["eventExtraStory", "Extra", episodes.filter((row) => row.isExtraEpisode && !row.isAnotherEpisode)],
    ["eventAnotherStory", "Another", episodes.filter((row) => row.isAnotherEpisode)],
  ] as const;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("eventStory", "Event story"), "stories", { count: episodes.length })}
      ${
        story.banner || story.image
          ? html`
              <div class="collection collection--story">
                ${tile({
                  kind: "story",
                  title: c.localized(story.chapterName) || c.localized(item.title),
                  titleLanguage: c.localizedLanguage(story.chapterName),
                  label: c.localized(story.chapterName) || c.localized(item.title),
                  image: String(story.banner || story.image),
                  aspectRatio: "16 / 9",
                  fit: "contain",
                  href: c.resourceHref(`/catalog/stories/event?chapter=${story.chapterId}`),
                })}
              </div>
            `
          : nothing
      }
      ${
        c.plainGameText(story.description) && c.plainGameText(story.description) !== c.plainGameText(item.description)
          ? html`
              <p class="detail-copy" lang=${c.localizedLanguage(story.description) || nothing}>
                ${c.plainGameText(story.description)}
              </p>
            `
          : nothing
      }
      ${groups.map(([key, fallback, entries]) =>
        entries.length
          ? html`
              <div class="stack stack--tight">
                <h4 class="md-title-small md-on-surface-variant">${c.label(key, fallback)}</h4>
                <div class="collection collection--story">
                  ${entries.map((episode) => {
                    const titleValue = episode.titleText || episode.title || episode.prefix;
                    const title = c.localized(titleValue) || c.label("storyEpisode", "Story episode");
                    const subtitleValue = [episode.description, episode.caption, story.chapterName].find((value) =>
                      c.localized(value),
                    );
                    const bandIcon = String((story.bandDetails as Item | undefined)?.icon || "");
                    const seconds = Math.round(Number(episode.playTime || 0));
                    return tile(
                      storyTile(
                        episode,
                        {
                          title,
                          titleLanguage: c.localizedLanguage(titleValue),
                          subtitle: localizedContent(subtitleValue, c.settings.locale),
                          bandIcon: bandIcon ? c.imageForLocale(bandIcon) : "",
                          image: episodeArtwork(episode, story),
                          imageFallback: String(story.banner || ""),
                          fit: "cover",
                          natural: true,
                          onImageError: nextImageCandidate,
                          href: c.relatedEntityHref("stories", String(episode.storyId || episode.storyKey), {
                            mode: "event",
                          }),
                          duration: seconds
                            ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
                            : "",
                        },
                        [
                          Number(episode.eventPoint) > 0
                            ? {
                                at: "bottom-start",
                                text: eventText(c, "eventStoryUnlock", "Unlock at {points} pt", {
                                  points: Number(episode.eventPoint),
                                }),
                              }
                            : null,
                        ],
                      ),
                    );
                  })}
                </div>
              </div>
            `
          : nothing,
      )}
    </section>
  `;
}

function renderEventRewards(c: Controller, item: Item) {
  const all = eventRows(item.rewards);
  // Score-linked rewards live beside their point rows. Keep any unmatched row here.
  const mapped = new Set(
    eventRows(item.rankings).flatMap((rank) =>
      eventRows(rank.rewards).map((row) => `${row.sourceTable}:${row.sourceId}:${row.rewardId ?? row.resourceId}`),
    ),
  );
  const rewards = all.filter(
    (row) => !mapped.has(`${row.sourceTable}:${row.sourceId}:${row.rewardId ?? row.resourceId}`),
  );
  if (!rewards.length) return nothing;
  const labels: Record<string, [string, string]> = {
    MasterEventAchievementReward: ["achievementRewards", "Achievement rewards"],
    MasterEventAchievementLoopReward: ["loopRewards", "Loop rewards"],
    MasterEventBoxGachaReward: ["boxGachaRewards", "Box rewards"],
    MasterEventRankingReward: ["rankingRewards", "Ranking rewards"],
    MasterLiveEventReward: ["liveEventRewards", "Live rewards"],
    MasterChallengeLiveEventReward: ["challengeRewards", "Challenge rewards"],
  };
  const tables = new Map<string, Item[]>();
  for (const row of rewards) {
    const key = String(row.sourceTable || "");
    tables.set(key, [...(tables.get(key) || []), row]);
  }
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("eventRewards", "Event rewards"), "rewards")}
      ${[...tables].map(([table, rows]) => {
        const tiers = new Map<string, Item[]>();
        for (const row of rows) {
          const key = String(row.sourceId);
          tiers.set(key, [...(tiers.get(key) || []), row]);
        }
        const [key, fallback] = labels[table] || ["rewards", "Rewards"];
        const content = html`
          <dl class="spec-list">
            ${[...tiers.values()].map(
              (tier) => html`
                <div>
                  <dt>${eventRewardCondition(c, tier[0]) || c.label("rewards", "Rewards")}</dt>
                  <dd>
                    <ul class="detail-object-list">
                      ${tier.map((row) => eventRewardRow(c, row))}
                    </ul>
                  </dd>
                </div>
              `,
            )}
          </dl>
        `;
        return tiers.size > 12
          ? fold(c, `event-rewards-${table}`, c.label(key, fallback), content, eventNumber(c, tiers.size))
          : html`
              <div class="stack stack--tight">
                <h4 class="md-title-small md-on-surface-variant">${c.label(key, fallback)}</h4>
                ${content}
              </div>
            `;
      })}
    </section>
  `;
}

function renderEventRankings(c: Controller, item: Item) {
  const rows = eventRows(item.rankings);
  if (!rows.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("eventLiveRewards", "Live rewards"), "rewards")}
      <div class="detail-columns">
        ${["live", "challenge"].map((kind) => {
          const entries = rows.filter((row) => row.kind === kind);
          if (!entries.length) return nothing;
          return html`
            <div class="stack stack--tight">
              <h4 class="md-title-small md-on-surface-variant">
                ${c.label(kind === "live" ? "liveRanking" : "challengeRanking", kind === "live" ? "Live" : "Challenge live")}
              </h4>
              <ul class="song-reward-list">
                ${entries.map(
                  (row) => html`
                    <li>
                      <img
                        src=${`/assets/${c.dataServer()}/Assets/AddressableResources/UI/Texture/BandRank/ImgScorerank_${EVENT_SCORE_RANK_NAMES[Number(row.scoreRank)]}.png`}
                        alt=${EVENT_SCORE_RANK_NAMES[Number(row.scoreRank)] || "—"}
                        loading="lazy"
                        decoding="async"
                      />
                      <span class="song-reward-list__condition">
                        <strong>${eventPoints(c, row.pointValue)}</strong>
                      </span>
                      <div class="stack stack--tight">
                        ${eventRows(row.rewards).map((row) => {
                          const reward = eventRewardValue(row);
                          const body = html`
                            ${
                              reward.image
                                ? html`
                                    <img src=${String(reward.image)} alt="" loading="lazy" decoding="async" />
                                  `
                                : nothing
                            }
                            <span lang=${c.localizedLanguage(reward.name) || nothing}>
                              ${c.localized(reward.name)}
                              <b>×${eventNumber(c, reward.count ?? row.resourceCount ?? 1)}</b>
                            </span>
                          `;
                          const href = canonicalHref(c, String(reward.href || ""));
                          return href
                            ? html`
                                <a class="song-reward-value" href=${href}>${body}</a>
                              `
                            : html`
                                <span class="song-reward-value">${body}</span>
                              `;
                        })}
                      </div>
                    </li>
                  `,
                )}
              </ul>
            </div>
          `;
        })}
      </div>
    </section>
  `;
}

function renderEventEffects(c: Controller, item: Item) {
  const effects = eventRows(item.effects);
  if (!effects.length) return nothing;
  const levels = [...new Set(effects.flatMap((effect) => eventRows(effect.perRank).map((value) => Number(value.rank))))]
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 5)
    .sort((left, right) => left - right);
  const rank = levels.includes(Number(c.eventBonusRank)) ? Number(c.eventBonusRank) : levels.at(-1) || 5;
  const targetKey = (row: Item) => {
    const raw = eventRaw(row);
    return [
      row.resourceTypeConstraint ?? raw._resourceTypeConstraint,
      raw._memberCardId,
      raw._supportCardId,
      raw._characterId,
      raw._bandId,
      raw._cardType,
      raw._tagId,
    ].join(":");
  };
  const groups = new Map<string, Item[]>();
  for (const effect of effects) {
    const key = targetKey(effect);
    groups.set(key, [...(groups.get(key) || []), effect]);
  }
  const bonusType = (row: Item) => Number(row.bonusType ?? eventRaw(row)._eventBonusType);
  const percent = (row: Item | undefined) => {
    const value = eventRows(row?.perRank).find((value) => Number(value.rank) === rank);
    return value ? `+${eventNumber(c, value.percent)}%` : "—";
  };
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("eventEffects", "Event bonuses"), "effects", { count: groups.size })}
      ${renderLevelSwitch(
        c.label("eventBonusRank", "Card rank"),
        levels,
        rank,
        (value) => {
          c.eventBonusRank = value;
          c.requestUpdate();
        },
        (value) => eventText(c, "eventRankN", "Rank {rank}", { rank: value }),
      )}
      <div class="detail-columns">
        ${[2, 3].map((type) => {
          const entries = [...groups.values()].filter(
            (group) => Number(group[0].resourceTypeConstraint ?? eventRaw(group[0])._resourceTypeConstraint) === type,
          );
          if (!entries.length) return nothing;
          return html`
            <div class="stack stack--tight">
              <h4 class="md-title-small md-on-surface-variant">
                ${c.label(type === 2 ? "memberCards" : "supportCards", type === 2 ? "Member cards" : "Support cards")}
              </h4>
              <dl class="spec-list spec-list--trailing">
                ${entries.map((group) => {
                  const first = group[0];
                  const cardType = Number(first.cardType ?? eventRaw(first)._cardType);
                  const targets =
                    first.targets && typeof first.targets === "object"
                      ? Object.entries(first.targets).map(([key, target]) =>
                          key === "attribute"
                            ? {
                                ...(target as Item),
                                image: c.attributeMark(cardType),
                              }
                            : (target as Item),
                        )
                      : [];
                  const fallback =
                    cardType > 0
                      ? {
                          image: c.attributeMark(cardType),
                          name: [
                            c.label(
                              ["", "red", "blue", "green", "yellow", "purple"][cardType] || "attribute",
                              "Attribute",
                            ),
                          ],
                        }
                      : { name: [c.label("eventAnyCard", "All cards")] };
                  return html`
                    <div>
                      <dt>
                        <ul class="detail-object-list">
                          ${(targets.length ? targets : [fallback]).map((target) => eventRewardRow(c, target, false, true))}
                        </ul>
                      </dt>
                      <dd class="cluster">
                        <span class="stack stack--tight">
                          <small class="md-label-medium md-on-surface-variant">
                            ${c.label("eventParameterBonus", "Parameters")}
                          </small>
                          <strong>${percent(group.find((row) => bonusType(row) === type - 2))}</strong>
                        </span>
                        <span class="stack stack--tight">
                          <small class="md-label-medium md-on-surface-variant">
                            ${c.label("eventItemBonus", "Event items")}
                          </small>
                          <strong>${percent(group.find((row) => bonusType(row) === 2))}</strong>
                        </span>
                      </dd>
                    </div>
                  `;
                })}
              </dl>
            </div>
          `;
        })}
      </div>
      ${
        c.plainGameText(item.bonusNote)
          ? html`
              <p class="detail-copy" lang=${c.localizedLanguage(item.bonusNote) || nothing}>
                ${c.plainGameText(item.bonusNote)}
              </p>
            `
          : nothing
      }
    </section>
  `;
}

function renderEventMissions(c: Controller, item: Item) {
  const missions = eventRows(item.missions);
  if (!missions.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("missions", "Missions"), "missions", { count: missions.length })}
      <dl class="spec-list">
        ${missions.map(
          (mission) => html`
            <div>
              <dt>${c.plainGameText(mission.description) || c.label("eventMission", "Event mission")}</dt>
              <dd>
                <ul class="detail-object-list">
                  ${eventRows(mission.rewards).map((reward) => eventRewardRow(c, reward))}
                </ul>
              </dd>
            </div>
          `,
        )}
      </dl>
    </section>
  `;
}

/** The per-resource body, placed after the generic facts section. */
export function renderGameSystemDetail(c: Controller, item: Item) {
  const resource = String(c.settings.resource || "");
  const rewards = (Array.isArray(item.rewards) ? item.rewards : []) as Item[];
  const pickups = (Array.isArray(item.pickupCards) ? item.pickupCards : []) as Item[];
  const rankings = (Array.isArray(item.rankings) ? item.rankings : []) as Item[];
  const effects = (Array.isArray(item.effects) ? item.effects : []) as Item[];
  switch (resource) {
    case "events":
      return html`
        ${renderRotatingOverview(c, item)} ${renderEventRecruitments(c, item)} ${renderEventPickups(c, item)}
        ${renderEventEffects(c, item)} ${renderEventSong(c, item)} ${renderEventStory(c, item)}
        ${renderEventRankings(c, item)} ${renderEventRewards(c, item)} ${renderEventMissions(c, item)}
        ${
          !item.story &&
          !item.song &&
          !pickups.length &&
          !eventRows(item.recruitments).length &&
          !rewards.length &&
          !rankings.length &&
          !effects.length &&
          !eventRows(item.missions).length
            ? html`
                <p class="detail-copy">
                  ${c.label("eventDetailsUnavailable", "No linked event details are available in this release.")}
                </p>
              `
            : nothing
        }
      `;
    case "gacha":
      return html`
        ${renderRotatingOverview(c, item)} ${renderSimulator(c, item)}
        ${featuredGrid(c, (Array.isArray(item.featured) ? item.featured : []) as Item[])} ${renderRates(c, item)}
      `;
    case "login-campaigns":
      return renderLoginDays(c, rewards);
    case "shop":
      return html`
        ${renderShopFacts(c, item)}${rewardSection(c, rewards, c.label("contents", "Contents"))}
      `;
    case "exchange":
      return renderExchangeGoods(c, item);
    case "circle":
      return rewardSection(c, rewards, c.label("rankRewards", "Rank rewards"));
    case "challenge":
      return item.songHref
        ? html`
            <section class="detail-section">
              <a class="button button--tonal" href=${c.resourceHref(String(item.songHref))}>
                ${icon("library_music", 18)}${c.label("viewSong", "View song")}
              </a>
            </section>
          `
        : nothing;
    case "passes":
      return item.kind === "monthly-pass"
        ? renderLoginDays(c, rewards)
        : html`
            ${renderPassLevels(c, (Array.isArray(item.levels) ? item.levels : []) as Item[])}
            ${renderPassMissions(c, (Array.isArray(item.tasks) ? item.tasks : []) as Item[])}
          `;
    case "real-lives":
      return renderEventBands(c, (Array.isArray(item.bands) ? item.bands : []) as Item[]);
    default:
      return nothing;
  }
}

export function initializeGameSystemDetail(c: Controller, item: Item) {
  c.sim = null;
  const options = gachaOptions(item);
  const preferred = [...options].sort(
    (left, right) =>
      Number(Number(left.limitCount) > 0) - Number(Number(right.limitCount) > 0) ||
      drawCountOf(right) - drawCountOf(left),
  )[0];
  c.gachaOption = preferred ? gachaOptionKey(item, preferred) : "";
  c.fx = null;
  c.eventBonusRank = 5;
  // Cash shop entries boot the rate fetch that fills the per-currency
  // conversions; the rates land as one shared session fetch.
  const payment = (item.payment || {}) as Item;
  if (availableShopCurrencies(shopPaymentPrices(payment, c.itemSourceServer(item))).length) void loadShopFx(c);
}
