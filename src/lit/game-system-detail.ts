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
import {
  availableShopCurrencies,
  convertShopPrice,
  fetchShopFxRates,
  formatMoney,
  localeShopCurrency,
  moneyName,
  shopPriceEntries,
} from "../lib/shop-currency";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { icon } from "./ui/icon";
import { tile } from "./ui/tile";

type Item = Record<string, unknown>;
type Controller = Record<string, any>;

export interface GachaSimState {
  draws: number;
  spent: number;
  points: number;
  currency: string;
  currencyImage: string;
  firstUsed: string[];
  tally: Record<string, number>;
  results: Array<{ prize: Item; rarity: number }>;
}

/** Real-time rate session for the open shop detail; owned by the screen like sim. */
export interface ShopFxState {
  status: "loading" | "ready" | "error";
  rates?: import("../lib/shop-currency").ShopFxRates;
}

const rateText = (value: unknown) =>
  Number(value) > 0 ? `${(Number(value) * 100).toLocaleString(undefined, { maximumFractionDigits: 3 })}%` : "";

const RARITY_NAMES: Record<number, string> = { 2: "R", 3: "SR", 4: "SSR" };

/** One reward row: emblem, linked name, secondary credit, trailing number. */
function rewardRow(c: Controller, reward: Item, trailing: unknown = nothing, badgeLabel?: string) {
  const name = c.localized(reward.name);
  if (!name) return nothing;
  const secondary = c.localized(reward.secondary);
  const image = String(reward.image || "");
  const href = String(reward.href || "");
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
      ${rewards.map((reward) => rewardRow(c, reward, options.trailing ? options.trailing(reward) : nothing))}
    </ul>
  `;
  if (options.collapsible) return fold(title, list);
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(title, options.kind || "rewards", { count: rewards.length })} ${list}
    </section>
  `;
}

/**
 * A disclosure in the house style: one Material summary row (title, optional
 * trailing meta, chevron) over an indented body, mirroring the manual's
 * entries. Summaries stay inside the section rhythm instead of looking like
 * bare unstyled <details>.
 */
function fold(title: unknown, content: unknown, meta: unknown = nothing) {
  return html`
    <details class="detail-fold">
      <summary>
        <span class="detail-fold__title">${title}</span>
        ${meta ? html`<span class="detail-fold__meta">${meta}</span>` : nothing}
        <svg class="material-icon detail-fold__chevron" width="20" height="20" aria-hidden="true">
          <use href="/icons.svg#expand_more"></use>
        </svg>
      </summary>
      <div class="detail-fold__body">${content}</div>
    </details>
  `;
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
    <span class="detail-cost"
      >${emblem}<span>${amount}</span></span
    >
  `;
}

/** Pickup and other headline rewards, as the same tiles the card catalogue uses. */
function featuredGrid(c: Controller, featured: Item[]) {
  if (!featured.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("featured", "Featured"), "cards", { count: featured.length })}
      <ul class="related-grid related-grid--wide" role="list">
        ${featured.map((reward) => {
          const title = c.localized(reward.name);
          const image = String(reward.image || "");
          return tile({
            kind: "member",
            title,
            titleLanguage: c.localizedLanguage(reward.name),
            subtitle: c.localized(reward.secondary),
            label: title,
            image,
            href: String(reward.href || "") || undefined,
            fit: "contain",
            marks: rateText(reward.rate)
              ? [{ at: "bottom-start" as const, text: rateText(reward.rate), label: c.label("rates", "Rates") }]
              : undefined,
          });
        })}
      </ul>
    </section>
  `;
}

/** The game's own ratio table: one collapsible group per slot, prizes inside. */
function renderRates(c: Controller, item: Item) {
  const rates = Array.isArray(item.rates) ? (item.rates as Item[]) : [];
  if (!rates.length) return nothing;
  const slotLabel = (row: Item) =>
    `${c.label(String(row.resourceType || ""), String(row.resourceType || ""))} · ${c.label("rarity", "Rarity")} ${
      RARITY_NAMES[Number(row.rarity || 0)] || "—"
    }`;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("rates", "Rates"), "works", { count: rates.length })}
      <div class="detail-fold-stack">
        ${rates.map((row) => {
          const prizes = (Array.isArray(row.prizes) ? row.prizes : []) as Item[];
          if (!prizes.length) return nothing;
          return fold(
            slotLabel(row),
            html`
              <ul class="detail-object-list" role="list">
                ${prizes.map((prize) =>
                  rewardRow(
                    c,
                    prize,
                    html`
                      <strong>${rateText(prize.rate)}</strong>
                    `,
                  ),
                )}
              </ul>
            `,
            rateText(row.rate),
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

function renderDrawOptions(c: Controller, item: Item) {
  const options = Array.isArray(item.drawOptions) ? (item.drawOptions as Item[]) : [];
  if (!options.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("drawOptions", "Draw options"), "content", { count: options.length })}
      <dl class="spec-list spec-list--split">
        ${options.map((option) => {
          const draws = Number(option.drawCount || 1);
          const price = Number(option.price || 0);
          const firstPrice = Number(option.firstPrice || 0);
          const ensuredRarity = Number(option.guaranteedRarity || 0);
          const ensuredCount = Number(option.guaranteedCount || 0);
          const limit = Number(option.limitCount || 0);
          const currency = c.localized(option.currency);
          const priceText =
            price > 0
              ? costLine(`${price.toLocaleString(c.settings.locale)} ${currency}`, option.currencyImage)
              : c.label("free", "Free");
          return html`
            <div>
              <dt>
                ${c
                  .label(draws === 1 ? "drawOne" : "draw", "{count} draws")
                  .replace("{count}", draws.toLocaleString(c.settings.locale))}
              </dt>
              <dd>
                ${priceText}
                ${
                  firstPrice > 0 && firstPrice !== price
                    ? html`
                        · ${c.label("firstTime", "First time")} ${firstPrice.toLocaleString(c.settings.locale)}
                      `
                    : nothing
                }
                ${
                  ensuredRarity
                    ? html`
                        · ${c.label("guaranteed", "Guaranteed")} ${RARITY_NAMES[ensuredRarity] || ""}
                        ${ensuredCount > 1 ? `×${ensuredCount}` : ""}
                      `
                    : nothing
                }
                ${
                  Number(option.gachaPoint || 0)
                    ? html`
                        · ${Number(option.gachaPoint).toLocaleString(c.settings.locale)} ${c.label("gachaPoint", "pt")}
                      `
                    : nothing
                }
                ${
                  limit
                    ? html`
                        · ${c.label("limit", "Limit")} ${limit.toLocaleString(c.settings.locale)}
                      `
                    : nothing
                }
              </dd>
            </div>
          `;
        })}
      </dl>
    </section>
  `;
}

/**
 * The simulator follows the reconstructed draw contract: a slot is rolled by
 * lot weight, a prize by its absolute basis-point rate inside the slot, and a
 * multi-draw whose rolls all miss the product's ensured rarity re-rolls its
 * last slot from the qualifying slots only — the game's 確定枠.
 */
export function drawGacha(c: Controller, item: Item, option: Item) {
  const rates = (Array.isArray(item.rates) ? item.rates : []) as Item[];
  if (!rates.length) return;
  const pickWeighted = (rows: Item[], weight: (row: Item) => number) => {
    const total = rows.reduce((sum, row) => sum + weight(row), 0);
    let roll = Math.random() * total;
    for (const row of rows) {
      roll -= weight(row);
      if (roll <= 0) return row;
    }
    return rows[rows.length - 1];
  };
  const drawOnce = (pool: Item[] = rates): { prize: Item; rarity: number } => {
    const group = pickWeighted(pool, (row) => Number(row.rate) || 0);
    const prizes = (Array.isArray(group.prizes) ? group.prizes : []) as Item[];
    const prize = prizes.length > 1 ? pickWeighted(prizes, (row) => Number(row.rate) || 0) : prizes[0] || {};
    return { prize, rarity: Number(group.rarity || 0) };
  };
  const draws = Math.max(1, Number(option.drawCount || 1));
  const results: Array<{ prize: Item; rarity: number }> = [];
  for (let index = 0; index < draws; index += 1) results.push(drawOnce());
  const ensured = Number(option.guaranteedRarity || 0);
  if (ensured && !results.some((result) => result.rarity >= ensured)) {
    const pool = rates.filter((row) => Number(row.rarity || 0) >= ensured);
    if (pool.length) results[results.length - 1] = drawOnce(pool);
  }
  const optionKey = String(option.id ?? option.drawCount ?? "");
  const previous: GachaSimState = c.sim || {
    draws: 0,
    spent: 0,
    points: 0,
    currency: c.localized(option.currency),
    currencyImage: String(option.currencyImage || ""),
    firstUsed: [],
    tally: {},
    results: [],
  };
  const price = Number(option.price || 0);
  const firstTime = Number(option.firstPrice || 0) > 0 && !previous.firstUsed.includes(optionKey);
  const spent = firstTime ? Number(option.firstPrice || 0) : price;
  const tally = { ...previous.tally };
  for (const result of results) tally[String(result.rarity)] = (tally[String(result.rarity)] || 0) + 1;
  c.sim = {
    draws: previous.draws + draws,
    spent: previous.spent + spent,
    // _gachaPoint is granted per product consume, not per single draw.
    points: previous.points + Number(option.gachaPoint || 0),
    currency: previous.currency || c.localized(option.currency),
    currencyImage: previous.currencyImage || String(option.currencyImage || ""),
    firstUsed: firstTime ? [...previous.firstUsed, optionKey] : previous.firstUsed,
    tally,
    results: [...results.reverse(), ...previous.results],
  };
  c.requestUpdate();
}

function renderSimulator(c: Controller, item: Item) {
  const options = Array.isArray(item.drawOptions) ? (item.drawOptions as Item[]) : [];
  if (!options.length) return nothing;
  const sim = c.sim as GachaSimState | null;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("simulator", "Simulator"), "difficulty")}
      <div class="field-stack">
        ${options.map((option) => {
          const draws = Number(option.drawCount || 1);
          const price = Number(option.price || 0);
          const currency = c.localized(option.currency);
          const cost = price > 0 ? `${price.toLocaleString(c.settings.locale)} ${currency}` : c.label("free", "Free");
          return html`
            <button class="button button--tonal" type="button" @click=${() => drawGacha(c, item, option)}>
              ${icon("casino", 18)}
              ${c
                .label(draws === 1 ? "drawOne" : "draw", "{count} draws")
                .replace("{count}", draws.toLocaleString(c.settings.locale))}
              · ${cost}
            </button>
          `;
        })}
        ${
          sim?.results?.length
            ? html`
                <button class="button button--text" type="button" @click=${() => ((c.sim = null), c.requestUpdate())}>
                  ${c.label("reset", "Reset")}
                </button>
              `
            : nothing
        }
      </div>
      ${
        sim?.results?.length
          ? html`
              <dl class="spec-list spec-list--split">
                <div>
                  <dt>${c.label("drawCount", "Draws")}</dt>
                  <dd>${sim.draws.toLocaleString(c.settings.locale)}</dd>
                </div>
                <div>
                  <dt>${c.label("spent", "Spent")}</dt>
                  <dd>${costLine(`${sim.spent.toLocaleString(c.settings.locale)} ${sim.currency}`, sim.currencyImage)}</dd>
                </div>
                ${
                  sim.points
                    ? html`
                        <div>
                          <dt>${c.label("gachaPoint", "Gacha points")}</dt>
                          <dd>${sim.points.toLocaleString(c.settings.locale)}</dd>
                        </div>
                      `
                    : nothing
                }
                ${Object.entries(sim.tally)
                  .sort((left, right) => Number(right[0]) - Number(left[0]))
                  .map(
                    ([rarity, count]) => html`
                      <div>
                        <dt>${RARITY_NAMES[Number(rarity)] || rarity}</dt>
                        <dd>${count.toLocaleString(c.settings.locale)}</dd>
                      </div>
                    `,
                  )}
              </dl>
              <ul class="related-grid related-grid--wide" role="list">
                ${sim.results.map(({ prize, rarity }) => {
                  const title = c.localized(prize.name) || c.label(RARITY_NAMES[rarity] || "reward", "Reward");
                  const image = String(prize.image || "");
                  return tile({
                    kind: "member",
                    title,
                    titleLanguage: c.localizedLanguage(prize.name),
                    subtitle: rarity ? RARITY_NAMES[rarity] : "",
                    label: title,
                    image,
                    href: String(prize.href || "") || undefined,
                    fit: "contain",
                    marks: prize.pickup
                      ? [
                          {
                            at: "end" as const,
                            text: c.label("pickup", "Pickup"),
                            accent: "var(--md-sys-color-primary)",
                          },
                        ]
                      : undefined,
                  });
                })}
              </ul>
            `
          : nothing
      }
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
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("exchangeGoods", "Exchange goods"), "content", { count: products.length })}
      <ul class="detail-object-list" role="list">
        ${products.map((product) => {
          const cost = Number(product.cost || 0);
          return rewardRow(
            c,
            (product.reward || {}) as Item,
            html`
              <strong>
                ${costLine(`${cost.toLocaleString(c.settings.locale)} ${c.localized(currency.name)}`, currency.image)}
              </strong>
            `,
          );
        })}
      </ul>
    </section>
  `;
}

function renderShopFacts(c: Controller, item: Item) {
  const payment = (item.payment || {}) as Item;
  const rows: Array<{ label: string; value: unknown }> = [];
  if (payment.advertisement) {
    rows.push({ label: c.detailLabel("price"), value: c.label("watchAd", "Watch an ad") });
  } else {
    // Cash entries read like the song page's difficulty facts: one spec row
    // per storefront currency, with the real-time conversion into the
    // reading locale's own currency attached under the price. In-game
    // currency rows keep the emblem figure.
    const fx = c.fx as ShopFxState | null;
    const target = localeShopCurrency(c.settings.locale);
    for (const { code, amount } of shopPriceEntries(payment.prices)) {
      const price = formatMoney(amount, code, c.settings.locale);
      const rate = fx?.status === "ready" && code !== target ? fx.rates?.rates[code] : undefined;
      const converted =
        rate && Number.isFinite(convertShopPrice(amount, code, target, fx!.rates!))
          ? html`
              <small class="shop-fx__note">
                ≈ ${formatMoney(convertShopPrice(amount, code, target, fx!.rates!), target, c.settings.locale)}
              </small>
            `
          : nothing;
      rows.push({
        label: moneyName(code, c.settings.locale),
        value: html`
          ${price}
          ${converted}
        `,
      });
    }
    if (!availableShopCurrencies(payment.prices).length) {
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

/** The per-resource body, placed after the generic facts section. */
export function renderGameSystemDetail(c: Controller, item: Item) {
  const resource = String(c.settings.resource || "");
  const rewards = (Array.isArray(item.rewards) ? item.rewards : []) as Item[];
  switch (resource) {
    case "gacha":
      return html`
        ${featuredGrid(c, (Array.isArray(item.featured) ? item.featured : []) as Item[])} ${renderDrawOptions(c, item)}
        ${renderRates(c, item)} ${renderSimulator(c, item)}
        ${rewardSection(c, rewards, c.label("prizePool", "Prize pool"), {
          collapsible: true,
          trailing: (reward) =>
            rateText(reward.rate)
              ? html`
                  <strong>
                    ${rateText(reward.rate)}${
                      Number(reward.count || 0) > 1
                        ? ` · ×${Number(reward.count).toLocaleString(c.settings.locale)}`
                        : ""
                    }
                  </strong>
                `
              : nothing,
        })}
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
              <a class="button button--tonal" href=${String(item.songHref)}>
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
  c.fx = null;
  // Cash shop entries boot the rate fetch that fills the per-currency
  // conversions; the rates land as one shared session fetch.
  const payment = (item.payment || {}) as Item;
  if (availableShopCurrencies(payment.prices).length) void loadShopFx(c);
}
