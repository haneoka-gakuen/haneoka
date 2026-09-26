import type { Locale } from "../i18n/locales";

/**
 * Real-money shop prices arrive on the entry's `payment.prices` as the
 * per-region storefront figures the pipeline lifts out of the master tables
 * (US headline plus whatever regional tiers it records). Every locale leads
 * with the currency its own storefront charges in, and when a region has no
 * price of its own it reads the closest thing to it: zh-CN falls back to the
 * NT$/HK$ tiers before the headline currencies, because those stores share
 * the same price points; everything else falls back to JPY, then USD.
 */
export type ShopCurrency = "usd" | "jpy" | "cny" | "twd" | "hkd" | "krw";

/** Currency groups each locale reads first, tried in order. */
const CURRENCY_CHAINS: Record<Locale, ShopCurrency[][]> = {
  ja: [["jpy"], ["usd"]],
  en: [["usd"], ["jpy"]],
  "zh-TW": [["twd", "hkd"], ["jpy"], ["usd"]],
  "zh-CN": [["cny"], ["twd", "hkd"], ["jpy"], ["usd"]],
  ko: [["krw"], ["jpy"], ["usd"]],
};

const currencyChain = (locale: string): ShopCurrency[][] => CURRENCY_CHAINS[locale as Locale] || CURRENCY_CHAINS.en;

/** The locale's own storefront currency, converter default. */
export const localeShopCurrency = (locale: string): ShopCurrency => currencyChain(locale)[0][0];

const priceTable = (prices: unknown): Record<string, number> => {
  const source = prices && typeof prices === "object" ? (prices as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([code, amount]): [string, number] => [code.toLowerCase(), Number(amount)])
      .filter(([, amount]) => Number.isFinite(amount) && amount > 0),
  );
};

/**
 * The price currencies a locale's subtitle shows, following its fallback
 * chain until one has a price — empty when nothing regional exists.
 */
export function resolveShopPriceCurrencies(locale: string, prices: unknown): ShopCurrency[] {
  const table = priceTable(prices);
  for (const group of currencyChain(locale)) {
    const available = group.filter((code) => table[code] > 0);
    if (available.length) return available;
  }
  return [];
}

/** Display order for the detail page's price facts. */
const CURRENCY_ORDER: readonly string[] = ["usd", "jpy", "cny", "twd", "hkd", "krw"];

/** Every priced currency an entry carries, in stable display order. */
export function availableShopCurrencies(prices: unknown): string[] {
  const table = priceTable(prices);
  return [...Object.keys(table)].sort(
    (left, right) =>
      (CURRENCY_ORDER.indexOf(left) + 1 || CURRENCY_ORDER.length + 1) -
      (CURRENCY_ORDER.indexOf(right) + 1 || CURRENCY_ORDER.length + 1),
  );
}

/** Every priced currency an entry carries, most-reference first. */
export function shopPriceEntries(prices: unknown): Array<{ code: string; amount: number }> {
  const table = priceTable(prices);
  return availableShopCurrencies(prices).map((code) => ({ code, amount: table[code] }));
}

/**
 * Fixed cross-region symbols rather than per-locale CLDR ones: CLDR writes
 * TWD as a bare "$" in zh-TW (and USD as "$" in ja/en), which inside one
 * mixed price line reads as several identical "$". Amounts keep the locale's
 * digit grouping; unknown currencies fall back to their ISO code.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  usd: "US$",
  twd: "NT$",
  hkd: "HK$",
  krw: "₩",
  jpy: "JP¥",
  cny: "CN¥",
};

/** Storefront-style money: whole amounts shed their cents (NT$30, ₩1,400). */
export function formatMoney(amount: number, currency: string, locale: string): string {
  const digits = Number.isInteger(amount) ? 0 : 2;
  const figure = amount.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: 2 });
  const symbol = CURRENCY_SYMBOLS[currency.toLowerCase()];
  return symbol ? `${symbol}${figure}` : `${figure} ${currency.toUpperCase()}`;
}

/** Localized currency name ("米ドル", "新台幣"), falling back to the code. */
export function moneyName(currency: string, locale: string): string {
  try {
    return new Intl.DisplayNames(locale, { type: "currency" }).of(currency.toUpperCase()) || currency.toUpperCase();
  } catch {
    return currency.toUpperCase();
  }
}

/** "NT$30 · HK$8" — one subtitle line for a locale's resolved price group. */
export function shopPriceLine(locale: string, prices: unknown): string {
  const table = priceTable(prices);
  return resolveShopPriceCurrencies(locale, prices)
    .map((code) => formatMoney(table[code], code, locale))
    .join(" · ");
}

export interface ShopFxRates {
  /** The upstream table's own date, YYYY-MM-DD. */
  date: string;
  /** Units of each (lowercase) currency one US dollar buys. */
  rates: Record<string, number>;
}

export const convertShopPrice = (amount: number, from: string, to: string, rates: ShopFxRates): number =>
  amount * ((rates.rates[to] || 0) / (rates.rates[from] || 1));

const FX_CACHE_KEY = "haneoka.fx";
const FX_MAX_AGE_MS = 6 * 60 * 60 * 1000;
let fxRatesPromise: Promise<ShopFxRates | null> | null = null;

const sanitizeRates = (value: unknown): Record<string, number> =>
  Object.fromEntries(
    Object.entries(value && typeof value === "object" ? (value as Record<string, unknown>) : {})
      .map(([code, rate]): [string, number] => [code.toLowerCase(), Number(rate)])
      .filter(([, rate]) => Number.isFinite(rate) && rate > 0),
  );

const readSessionCache = (): ShopFxRates | null => {
  try {
    const value = JSON.parse(sessionStorage.getItem(FX_CACHE_KEY) || "null");
    if (!value || typeof value.at !== "number" || Date.now() - value.at > FX_MAX_AGE_MS) return null;
    const rates = sanitizeRates(value.rates);
    return rates.usd ? { date: String(value.date || ""), rates } : null;
  } catch {
    return null;
  }
};

/** Daily reference rates relative to USD: the currency-api mirror on
 * jsDelivr, with the open.er-api endpoint as a second source. Display-only
 * reference data, cached per browsing session — never a purchase price. */
export function fetchShopFxRates(): Promise<ShopFxRates | null> {
  fxRatesPromise ??= (async () => {
    const cached = readSessionCache();
    if (cached) return cached;
    const jsDelivr = await fetch("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json", {
      headers: { accept: "application/json" },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const rates = sanitizeRates(payload?.usd);
        return rates.usd ? { date: String(payload?.date || ""), rates } : null;
      })
      .catch(() => null);
    const rates =
      jsDelivr ??
      (await fetch("https://open.er-api.com/v6/latest/USD", { headers: { accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          const rates = sanitizeRates(payload?.rates);
          return rates.usd
            ? {
                date: new Date(Number(payload?.time_last_update_unix || 0) * 1000 || Date.now())
                  .toISOString()
                  .slice(0, 10),
                rates,
              }
            : null;
        })
        .catch(() => null));
    if (!rates) return null;
    try {
      sessionStorage.setItem(FX_CACHE_KEY, JSON.stringify({ at: Date.now(), ...rates }));
    } catch {
      // The conversion still works this session without a cache to read.
    }
    return rates;
  })();
  return fxRatesPromise;
}
