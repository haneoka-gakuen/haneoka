import { LitElement, html, nothing } from "lit";
import { catalogUrl, fetchJson, localizedText, type JsonRecord } from "./shared/catalog";
import { isReleaseServer, readReleaseServer } from "../lib/release-server";
import { validStickerToken } from "../lib/community-markup";

const catalogs = new Map<string, { expires: number; promise: Promise<JsonRecord> }>();
export function communityStamps(server: string, reload = false): Promise<JsonRecord> {
  if (!isReleaseServer(server)) return Promise.resolve({});
  const existing = catalogs.get(server);
  if (!reload && existing && existing.expires > Date.now()) return existing.promise;
  const promise = fetchJson<JsonRecord>(catalogUrl("stamps", "", server)).catch((error) => {
    catalogs.delete(server);
    throw error;
  });
  catalogs.set(server, { expires: Date.now() + 300000, promise });
  return promise;
}
export function stampServers(server: string): string[] {
  return [...new Set([server, readReleaseServer(), "intl", "jp"])].filter(isReleaseServer);
}
export function stampSources(stamp: JsonRecord, locale: string): string[] {
  const source = String(stamp.image || "");
  const variants = (stamp.imageVariants as Record<string, Record<string, string>> | undefined)?.[source] || {};
  const key = locale === "zh-CN" ? "zh-Hans" : locale === "zh-TW" ? "zh-Hant" : locale;
  return [
    ...new Set(
      [variants[key], variants.ja, source, ...Object.values(variants)].filter(
        (value): value is string => !!value && value.startsWith("/assets/"),
      ),
    ),
  ];
}
export class CommunitySticker extends LitElement {
  static properties = { token: {}, locale: {}, label: {}, sources: { state: true }, index: { state: true } };
  declare token: string;
  declare locale: string;
  declare label: string;
  declare sources: string[];
  declare index: number;
  private sequence = 0;
  constructor() {
    super();
    this.token = "";
    this.locale = "en";
    this.label = "";
    this.sources = [];
    this.index = 0;
  }
  createRenderRoot() {
    return this;
  }
  updated(changed: Map<string, unknown>) {
    if (changed.has("token") || changed.has("locale")) void this.resolve();
  }
  disconnectedCallback() {
    this.sequence++;
    super.disconnectedCallback();
  }
  private async resolve() {
    const sequence = ++this.sequence;
    this.sources = [];
    this.index = 0;
    if (!validStickerToken(this.token)) return;
    const [server, id, language] = this.token.split(":");
    for (const candidate of [...new Set([server, readReleaseServer(), "intl", "jp"])]) {
      try {
        const catalog = await communityStamps(candidate);
        if (!this.isConnected || sequence !== this.sequence) return;
        const stamp = catalog[id] as JsonRecord | undefined;
        if (!stamp) continue;
        const sources = stampSources(stamp, language || this.locale);
        if (!sources.length) continue;
        this.sources = sources;
        if (!this.label) this.label = localizedText(stamp.name, language || this.locale);
        return;
      } catch {
        if (sequence !== this.sequence) return;
      }
    }
  }
  render() {
    const source = this.sources[this.index];
    return source
      ? html`
          <img
            src=${source}
            alt=${this.label}
            title=${this.label}
            width="48"
            height="48"
            loading="lazy"
            decoding="async"
            @error=${() => this.index++}
          />
        `
      : html`
          <span>${this.label || nothing}</span>
        `;
  }
}
if (!customElements.get("community-sticker")) customElements.define("community-sticker", CommunitySticker);
