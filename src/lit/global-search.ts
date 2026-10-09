import { LitElement, html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { clientText } from "../i18n/client";
import { communityExcerpt } from "../lib/community-markup";
import { communityPostMedia, communityMediaThumbnail } from "../lib/community-artwork";
import { readReleaseServer } from "../lib/release-server";
import { SEARCH_SCOPES, isSearchScope, searchCategory, type SearchScope } from "../lib/search-categories";
import { loadingState, emptyState, errorState } from "./ui/state";
import { segmented } from "./ui/controls";
import { readCommunityBootstrap } from "../lib/community-bootstrap";
import { readCommunityViewer, CommunityRealmChanged } from "../lib/community-viewer";
import { JsonResponseError } from "./shared/catalog";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  "all": "common.states.all",
  "community": "navigation.community",
  "empty": "common.states.empty",
  "loadMore": "common.actions.loadMore",
  "loading": "common.states.loading",
  "retry": "common.actions.retry",
  "search": "common.actions.search",
  "type": "catalog.fields.type",
  "unavailable": "common.states.unavailable"
};


type RecordValue = Record<string, unknown>;
interface SearchResult {
  url: string;
  excerpt: string;
  meta: { title?: string; label?: string; image?: string; kind?: string };
  sub_results?: Array<{ url: string; title: string; excerpt: string }>;
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
const moduleUrl = "/pagefind/pagefind.js";
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
  };
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
    this.locale = "en"; this.query = ""; this.scope = "all";
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
    form?.addEventListener("submit", (event) => { event.preventDefault(); perform(); }, options);
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
  }
  disconnectedCallback() {
    ++this.generation;
    window.clearTimeout(this.timer); this.communityRequest?.abort(); this.lifetime?.abort();
    super.disconnectedCallback();
  }
  private selectScope(scope: SearchScope) {
    window.clearTimeout(this.timer);
    const input = document.querySelector<HTMLElement & { value: string }>("[data-global-search-input]");
    if (input) this.query = input.value.trim();
    this.scope = scope; this.syncUrl(); this.search();
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
  private async loadCatalog(generation: number, append = false) {
    if (this.catalogBusy) return;
    if (!append) { this.results = []; this.hits = []; this.consumed = 0; this.catalogMore = false; }
    const query = this.query.trim(), locale = this.locale, scope = this.scope, server = readReleaseServer();
    const current = () => this.isConnected && generation === this.generation && locale === this.locale && server === readReleaseServer();
    const key = JSON.stringify([locale, server, scope, query]);
    this.catalogBusy = true; this.catalogError = "";
    try {
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
            ${[...groups].map(([kind, rows]) => html`
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
      ` : nothing}
    `;
  }
}
customElements.define("global-search", GlobalSearch);
