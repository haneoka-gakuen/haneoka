import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { clientText } from "../i18n/client";
import { communityExcerpt } from "../lib/community-markup";
import { communityPostMedia, communityMediaThumbnail } from "../lib/community-artwork";
import { readReleaseServer } from "../lib/release-server";
import { SEARCH_SCOPES, isSearchScope, searchCategory, type SearchScope } from "../lib/search-categories";
import { loadingState, emptyState, errorState } from "./ui/state";
import { filterChip, segmented } from "./ui/controls";
import { readCommunityBootstrap } from "../lib/community-bootstrap";
import { readCommunityViewer, CommunityRealmChanged } from "../lib/community-viewer";
import { JsonResponseError } from "./shared/catalog";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  "all": "common.states.all",
  "community": "navigation.community",
  "catalog": "navigation.catalog",
  "stories": "navigation.stories",
  "help": "navigation.help",
  "empty": "common.states.empty",
  "loadMore": "common.actions.loadMore",
  "loading": "common.states.loading",
  "retry": "common.actions.retry",
  "search": "common.actions.search",
  "type": "catalog.fields.type",
  "unavailable": "common.states.unavailable",
  "recent": "common.search.recent",
  "clear": "common.actions.clear",
  "remove": "common.actions.remove",
  "browse": "common.search.browse"
};


type RecordValue = Record<string, unknown>;
interface SearchResult {
  url: string;
  excerpt: string;
  meta: { title?: string; label?: string; image?: string; kind?: string };
  sub_results?: Array<{ url: string; title: string; excerpt: string }>;
}
interface ServiceResults {
  total: number;
  kinds: Record<string, number>;
  hits: Array<{ url: string; kind: string; title: string; excerpt: string; image?: string }>;
}
interface SearchHit { id: string; data(): Promise<SearchResult>; }
type SearchFilter = string | string[] | { any: string[] };
interface SearchOptions { filters?: Record<string, SearchFilter>; }
interface SearchApi {
  init(): Promise<void>;
  destroy(): Promise<void>;
  filters(): Promise<Record<string, Record<string, number>>>;
  preload(query: string, options?: SearchOptions): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<{ results: SearchHit[] }>;
}
const KIND_LABELS: Readonly<Record<string, string>> = {
  songs: "navigation.songs", "member-cards": "navigation.memberCards", "support-cards": "navigation.supportCards",
  characters: "navigation.characters", events: "navigation.events", gacha: "navigation.gacha",
  "real-lives": "navigation.realLives", comics: "navigation.comics", stamps: "navigation.stamps",
  stickers: "navigation.stickers", backgrounds: "navigation.backgrounds", items: "navigation.items",
  "band-items": "navigation.bandItems", stories: "navigation.stories",
};
const moduleUrl = "/pagefind/pagefind.js";
const RECENT_KEY = "haneoka.search.recent.v1";
const BROWSE: ReadonlyArray<[path: string, label: string, icon: string]> = [
  ["catalog", "navigation.catalog", "category"],
  ["songs", "navigation.songs", "music_note"],
  ["member-cards", "navigation.memberCards", "style"],
  ["support-cards", "navigation.supportCards", "photo_library"],
  ["characters", "navigation.characters", "groups"],
  ["events", "navigation.events", "event"],
  ["gacha", "navigation.gacha", "redeem"],
  ["stories", "navigation.stories", "auto_stories"],
];
function readRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}
function writeRecent(values: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(values.slice(0, 10)));
  } catch {
    // Private mode keeps no history.
  }
}
let indexModule: Promise<SearchApi> | undefined;
let indexLanguage = "";
let initialization = Promise.resolve();
const publicResults = new Map<string, { hits: SearchHit[]; results: SearchResult[]; consumed: number; total: number; time: number }>();

async function searchIndex(): Promise<SearchApi> {
  indexModule ??= import(/* @vite-ignore */ moduleUrl).catch((error) => { indexModule = undefined; throw error; });
  const api = await indexModule;
  const language = document.documentElement.lang;
  initialization = initialization.catch(() => undefined).then(async () => {
    if (indexLanguage === language) return;
    if (indexLanguage) await api.destroy();
    publicResults.clear();
    await api.init();
    indexLanguage = language;
  });
  await initialization;
  return api;
}
const resultData = (result: SearchResult): SearchResult => ({
  url: result.url, excerpt: result.excerpt, meta: result.meta,
  ...(result.sub_results ? { sub_results: result.sub_results.slice(0, 4) } : {}),
});

export class GlobalSearch extends LitElement {
  static properties = {
    locale: { type: String }, query: { state: true }, scope: { state: true },
    catalogBusy: { state: true }, communityBusy: { state: true },
    results: { state: true }, posts: { state: true }, catalogError: { state: true },
    communityError: { state: true }, total: { state: true }, catalogMore: { state: true },
    recent: { state: true }, kind: { state: true }, kinds: { state: true },
  };
  /** Read after hydration: the browser's history cannot be part of the pre-rendered markup. */
  declare recent: string[];
  /** Result kind picked from the service's facets; empty is every kind. */
  declare kind: string;
  declare kinds: Record<string, number>;
  private fromService = false;
  declare locale: string;
  declare query: string;
  declare scope: SearchScope;
  declare catalogBusy: boolean;
  declare communityBusy: boolean;
  declare results: SearchResult[];
  declare posts: RecordValue[];
  declare catalogError: string;
  declare communityError: string;
  declare total: number;
  declare catalogMore: boolean;
  private hits: SearchHit[] = [];
  private consumed = 0;
  private cursor = "";
  private communityRealm?: string;
  private generation = 0;
  private communityRequest?: AbortController;
  private lifetime?: AbortController;
  private timer?: number;
  private composing = false;
  constructor() {
    super();
    this.locale = "en"; this.query = ""; this.scope = "all"; this.recent = []; this.kind = ""; this.kinds = {};
    this.catalogBusy = false; this.communityBusy = false;
    this.results = []; this.posts = []; this.catalogError = ""; this.communityError = "";
    this.total = 0; this.catalogMore = false;
  }
  createRenderRoot() { return this; }
  private label(key: string) { return clientText(this.locale, (uiLabelPaths[key] ?? key)); }
  private syncUrl() {
    const params = new URLSearchParams(location.search);
    if (this.query) params.set("q", this.query); else params.delete("q");
    if (this.scope === "all") params.delete("type"); else params.set("type", this.scope);
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private warm(query = "") {
    if (this.scope === "community") return;
    void searchIndex().then((api) => Promise.all([api.filters(), query ? api.preload(query) : Promise.resolve()])).catch(() => {});
  }
  connectedCallback() {
    super.connectedCallback();
    if (this.hasAttribute("data-prerendered")) void this.updateComplete.then(() => this.connectSearch());
    else this.connectSearch();
  }
  protected update(changed: PropertyValues) {
    if (this.hasAttribute("data-prerendered")) {
      hydrate(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  private connectSearch() {
    if (!this.isConnected) return;
    this.lifetime = new AbortController();
    const params = new URLSearchParams(location.search);
    this.query = params.get("q") || "";
    const scope = params.get("type");
    this.scope = isSearchScope(scope) ? scope : "all";
    const form = document.querySelector<HTMLFormElement>("[data-global-search-form]");
    const input = form?.querySelector<HTMLElement & { value: string }>("[data-global-search-input]");
    if (input) input.value = this.query;
    const perform = () => {
      window.clearTimeout(this.timer);
      this.query = input?.value.trim() || "";
      this.syncUrl(); this.search();
    };
    const schedule = () => {
      window.clearTimeout(this.timer);
      this.communityRequest?.abort();
      ++this.generation;
      if (this.composing) return;
      const query = input?.value.trim() || "";
      this.warm(query);
      if (!query) { perform(); return; }
      this.catalogBusy = this.scope !== "community";
      this.communityBusy = this.scope === "all" || this.scope === "community";
      this.timer = window.setTimeout(perform, 150);
    };
    const options = { signal: this.lifetime.signal };
    form?.addEventListener("submit", (event) => { event.preventDefault(); perform(); this.remember(); }, options);
    this.addEventListener("click", (event) => {
      if ((event.target as Element).closest?.(".search-result")) this.remember();
    }, options);
    input?.addEventListener("focusin", () => this.warm(), options);
    input?.addEventListener("compositionstart", () => {
      this.composing = true; window.clearTimeout(this.timer); this.communityRequest?.abort(); ++this.generation;
    }, options);
    input?.addEventListener("compositionend", () => { this.composing = false; schedule(); }, options);
    input?.addEventListener("input", schedule, options);
    window.addEventListener("haneoka:session-changed", () => { this.posts = []; this.cursor = ""; this.search(); }, options);
    window.addEventListener("haneoka:locale-ready", () => { this.locale = document.documentElement.lang; this.search(); }, options);
    window.addEventListener("haneoka:server-change", () => this.search(), options);
    window.addEventListener("storage", (event) => {
      if (event.key === "haneoka.release-server") this.search();
    }, options);
    this.search();
    this.recent = readRecent();
  }
  disconnectedCallback() {
    ++this.generation;
    window.clearTimeout(this.timer); this.communityRequest?.abort(); this.lifetime?.abort();
    super.disconnectedCallback();
  }
  private remember() {
    const query = this.query.trim();
    if (query) writeRecent([query, ...readRecent().filter((entry) => entry !== query)]);
    this.recent = readRecent();
  }
  private forget(query?: string) {
    writeRecent(query === undefined ? [] : readRecent().filter((entry) => entry !== query));
    this.recent = readRecent();
  }
  private renderStart() {
    const recent = this.recent;
    const server = readReleaseServer();
    const text = (key: string) => clientText(this.locale, key, key);
    return html`
      ${
        recent.length
          ? html`
              <section class="stack stack--tight" aria-labelledby="search-recent">
                <div class="row row--between">
                  <h2 id="search-recent">${this.label("recent")}</h2>
                  <button class="button button--text" type="button" @click=${() => this.forget()}>${this.label("clear")}</button>
                </div>
                <div class="chip-set">
                  ${recent.map(
                    (query) => html`
                      <span class="chip chip--input">
                        <a class="chip__label" href=${`?q=${encodeURIComponent(query)}`}>${query}</a>
                        <button class="chip__remove" type="button" aria-label=${this.label("remove")} @click=${() => this.forget(query)}>
                          <svg class="material-icon" width="18" height="18" aria-hidden="true"><use href="/icons.svg#close"></use></svg>
                        </button>
                      </span>
                    `,
                  )}
                </div>
              </section>
            `
          : nothing
      }
      <section class="stack stack--tight" aria-labelledby="search-browse">
        <h2 id="search-browse">${this.label("browse")}</h2>
        <div class="chip-set">
          ${BROWSE.map(
            ([path, key, icon]) => html`
              <a class="chip chip--assist" href=${`/${server}/${this.locale}/${path}/`}>
                <svg class="material-icon" width="18" height="18" aria-hidden="true"><use href=${`/icons.svg#${icon}`}></use></svg>
                ${text(key)}
              </a>
            `,
          )}
          <a class="chip chip--assist" href=${`/${this.locale}/community/`}>
            <svg class="material-icon" width="18" height="18" aria-hidden="true"><use href="/icons.svg#forum"></use></svg>
            ${text("navigation.community")}
          </a>
        </div>
      </section>
    `;
  }
  private selectScope(scope: SearchScope) {
    window.clearTimeout(this.timer);
    const input = document.querySelector<HTMLElement & { value: string }>("[data-global-search-input]");
    if (input) this.query = input.value.trim();
    this.scope = scope; this.kind = ""; this.syncUrl(); this.search();
  }
  private search() {
    const generation = ++this.generation;
    this.communityRequest?.abort();
    this.results = []; this.posts = []; this.hits = []; this.consumed = 0;
    this.cursor = ""; this.total = 0; this.catalogMore = false;
    this.catalogError = ""; this.communityError = "";
    this.catalogBusy = false; this.communityBusy = false;
    if (!this.query.trim()) return;
    if (this.scope !== "community") void this.loadCatalog(generation);
    if (this.scope === "all" || this.scope === "community") void this.loadCommunity(generation);
  }
  /** The search service; false hands this query to the static index. */
  private async loadService(append: boolean, current: () => boolean) {
    const server = readReleaseServer();
    if (server !== "jp" && server !== "intl") return false;
    if (this.scope === "help") return false;
    const params = new URLSearchParams({ q: this.query.trim(), server, locale: this.locale, limit: "24", offset: String(append ? this.results.length : 0) });
    if (this.scope === "catalog" || this.scope === "stories") params.set("section", this.scope);
    if (this.kind) params.set("kind", this.kind);
    const response = await fetch(`/api/v1/search?${params}`).catch(() => null);
    if (!response?.ok) return false;
    const data = (await response.json()) as ServiceResults;
    if (!current()) return true;
    const rows = data.hits.map((hit): SearchResult => ({
      url: hit.url, excerpt: hit.excerpt,
      meta: { label: hit.title, ...(hit.image ? { image: hit.image } : {}), kind: hit.kind },
    }));
    this.results = append ? [...this.results, ...rows] : rows;
    this.total = data.total; this.kinds = data.kinds;
    this.catalogMore = this.results.length < data.total;
    this.fromService = true;
    return true;
  }
  private async loadCatalog(generation: number, append = false) {
    if (this.catalogBusy) return;
    if (!append) { this.results = []; this.hits = []; this.consumed = 0; this.catalogMore = false; this.kinds = {}; this.fromService = false; }
    const query = this.query.trim(), locale = this.locale, scope = this.scope, server = readReleaseServer();
    const current = () => this.isConnected && generation === this.generation && locale === this.locale && server === readReleaseServer();
    const key = JSON.stringify([locale, server, scope, query]);
    this.catalogBusy = true; this.catalogError = "";
    try {
      if ((!append || this.fromService) && (await this.loadService(append, current))) return;
      if (!current()) return;
      const api = await searchIndex();
      if (!current()) return;
      const cached = !append ? publicResults.get(key) : undefined;
      if (cached && Date.now() - cached.time < 300000) {
        this.hits = cached.hits; this.results = cached.results; this.consumed = cached.consumed;
        this.total = cached.total; this.catalogMore = this.consumed < this.hits.length;
        return;
      }
      const [available] = await Promise.all([api.filters(), api.preload(query)]);
      if (!current()) return;
      const filters: Record<string, SearchFilter> = {};
      if (available.server) filters.server = { any: [server, "global"] };
      if (scope !== "all" && available.section) filters.section = scope;
      if (!append) {
        const found = await api.search(query, { filters });
        if (!current()) return;
        this.hits = found.results;
        this.total = scope === "all" || available.section ? found.results.length : 0;
      }
      const added: SearchResult[] = [];
      let inspected = 0;
      while (added.length < 12 && this.consumed < this.hits.length && inspected < 48) {
        const batch = this.hits.slice(this.consumed, this.consumed + Math.min(8, 12 - added.length));
        const rows = await Promise.all(batch.map(async (hit) => resultData(await hit.data())));
        if (!current()) return;
        this.consumed += batch.length; inspected += batch.length;
        const visible = rows.filter((row) => scope === "all" || searchCategory(row.url).section === scope);
        added.push(...visible); this.results = [...this.results, ...visible];
      }
      if (!current()) return;
      this.catalogMore = this.consumed < this.hits.length;
      if (scope !== "all" && !available.section) this.total = this.results.length;
      if (!append) {
        publicResults.delete(key);
        publicResults.set(key, { hits: this.hits, results: this.results, consumed: this.consumed, total: this.total, time: Date.now() });
        if (publicResults.size > 16) publicResults.delete(publicResults.keys().next().value!);
      }
    } catch (error) {
      if (current()) this.catalogError = String(error instanceof Error ? error.message : error);
    } finally { if (current()) this.catalogBusy = false; }
  }
  private async loadCommunity(generation: number, append = false) {
    if (this.communityBusy || (append && !this.cursor)) return;
    if (!append) { this.posts = []; this.cursor = ""; this.communityRealm = undefined; }
    const query = this.query.trim(), locale = this.locale;
    const controller = new AbortController();
    this.communityRequest?.abort(); this.communityRequest = controller;
    const current = () => this.isConnected && generation === this.generation && !controller.signal.aborted && locale === this.locale;
    this.communityBusy = true; this.communityError = "";
    try {
      const params = new URLSearchParams({ q: query, scope: "latest", order: "relevance", state: "active", limit: "12" });
      if (append) params.set("cursor", this.cursor);
      const bootstrap = await readCommunityBootstrap<{ posts?: RecordValue[]; nextCursor?: string }>(`/api/v1/community/posts?${params}`, controller.signal);
      const latest = await readCommunityViewer(controller.signal);
      if (!current()) return;
      if (latest.realm !== bootstrap.viewer.realm) throw new CommunityRealmChanged();
      if (append && this.communityRealm !== latest.realm) throw new CommunityRealmChanged();
      const data = bootstrap.data;
      this.communityRealm = latest.realm;
      this.posts = [...this.posts, ...(data.posts || [])]; this.cursor = data.nextCursor || "";
    } catch (error) {
      if (current()) {
        if (error instanceof CommunityRealmChanged || (error instanceof JsonResponseError && [401, 403].includes(error.status))) {
          this.posts = []; this.cursor = ""; this.communityRealm = undefined;
        }
        this.communityError = String(error instanceof Error ? error.message : error);
      }
    } finally { if (current()) this.communityBusy = false; }
  }
  private image(source?: string) {
    return source?.trim() ? html`<span class="search-result__image"><img src=${source} alt="" loading="lazy" decoding="async" /></span>` : nothing;
  }
  private resultHref(rawUrl: string): string {
    try {
      const url = new URL(rawUrl, document.baseURI);
      return url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : "#";
    } catch { return "#"; }
  }
  private kindLabel(kind: string) {
    return clientText(this.locale, KIND_LABELS[kind] ?? "navigation.catalog", kind);
  }
  /** One relevance-ordered list; titles and excerpts arrive escaped from the search service. */
  private renderRanked() {
    const kinds = Object.entries(this.kinds).sort((a, b) => b[1] - a[1]);
    return html`
      <div class="search-page__summary">
        <span class="md-label-large">${clientText(this.locale, "common.search.results", "{count} results", { count: this.total.toLocaleString(this.locale) })}</span>
        ${kinds.length > 1 || this.kind ? html`
          <div class="chip-set">
            ${kinds.map(([kind, count]) => filterChip({
              label: `${this.kindLabel(kind)} ${count}`, selected: this.kind === kind,
              onToggle: () => { this.kind = this.kind === kind ? "" : kind; void this.loadCatalog(this.generation); },
            }))}
          </div>` : nothing}
      </div>
      <ul class="search-results">
        ${this.results.map((result) => html`<li><a class="search-result state-layer" href=${this.resultHref(result.url)}>
          ${this.image(result.meta.image)}<span class="search-result__copy">
            <span class="search-result__kind md-label-small">${this.kindLabel(String(result.meta.kind))}</span>
            <strong>${unsafeHTML(result.meta.label ?? "")}</strong>
            ${result.excerpt ? html`<p>${unsafeHTML(result.excerpt)}</p>` : nothing}
          </span></a></li>`)}
      </ul>`;
  }
  render() {
    const groups = new Map<string, SearchResult[]>();
    for (const result of this.results) {
      let path: string;
      try { path = new URL(result.url, document.baseURI).pathname; } catch { continue; }
      const key = searchCategory(path).labelKey;
      groups.set(key, [...(groups.get(key) || []), result]);
    }
    return html`
      <div class="search-page__filters">
        ${segmented({ label: this.label("search"), value: this.scope, grow: false,
          options: SEARCH_SCOPES.map((value) => ({ value, label: this.label(value) })),
          onSelect: (value) => this.selectScope(value) })}
      </div>
      ${this.query.trim() ? html`
        ${this.scope !== "community" ? html`
          <section aria-label=${this.label(this.scope === "all" ? "search" : this.scope)} aria-busy=${String(this.catalogBusy)}>
            ${this.catalogBusy && !this.results.length ? loadingState(this.label("loading"), { local: true }) : nothing}
            ${this.catalogError ? errorState(this.label("unavailable"), this.label("retry"), () => void this.loadCatalog(this.generation)) : nothing}
            ${this.fromService ? this.renderRanked() : [...groups].map(([kind, rows]) => html`
              <div class="search-page__group"><h2>${this.label(kind)}</h2><ul class="search-results">
                ${rows.map((result) => {
                  const target = result.sub_results?.find((row) => row.url.includes("#")) || result;
                  return html`<li><a class="search-result state-layer" href=${this.resultHref(target.url)}>
                    ${this.image(result.meta.image)}<span class="search-result__copy">
                      <strong>${result.meta.label || result.meta.title || target.url}</strong><p>${unsafeHTML(target.excerpt)}</p>
                    </span></a></li>`;
                })}
              </ul></div>`)}
            ${this.catalogMore ? html`<button class="button button--tonal search-page__more" ?disabled=${this.catalogBusy}
              @click=${() => void this.loadCatalog(this.generation, true)}>${this.label(this.catalogBusy ? "loading" : "loadMore")}</button>` : nothing}
          </section>` : nothing}
        ${this.scope === "all" || this.scope === "community" ? html`
          <section aria-label=${this.label("community")} aria-busy=${String(this.communityBusy)}>
            <h2>${this.label("community")}</h2>
            ${this.communityBusy && !this.posts.length ? loadingState(this.label("loading"), { local: true }) : nothing}
            ${this.communityError ? errorState(this.label("unavailable"), this.label("retry"), () => void this.loadCommunity(this.generation)) : nothing}
            <ul class="search-results">${this.posts.map((post) => html`
              <li><a class="search-result state-layer" href=${`/${this.locale}/community/posts/${encodeURIComponent(String(post.id))}/`}>
                ${this.image(communityPostMedia(post).map(communityMediaThumbnail).find(Boolean))}
                <span class="search-result__copy"><strong>${String(post.title || "")}</strong>
                  <p>${communityExcerpt(String(post.excerpt || post.body || "")).slice(0, 180)}</p>
                  <p>${String(post.authorName || post.authorHandle || "")}</p></span>
              </a></li>`)}</ul>
            ${this.cursor ? html`<button class="button button--tonal search-page__more" ?disabled=${this.communityBusy}
              @click=${() => void this.loadCommunity(this.generation, true)}>${this.label(this.communityBusy ? "loading" : "loadMore")}</button>` : nothing}
          </section>` : nothing}
        ${!this.catalogBusy && !this.communityBusy && !this.results.length && !this.posts.length && !this.catalogError && !this.communityError && !this.catalogMore
          ? emptyState({ title: this.label("empty") }) : nothing}
      ` : this.renderStart()}
    `;
  }
}
customElements.define("global-search", GlobalSearch);
