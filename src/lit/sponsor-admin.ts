// L3 — GEB
// Input: 管理工作区、管理员会话、`/api/v1/admin/sponsors` 的来源值／覆盖值／生效值与档位。
// Output: 赞助者列表与筛选、逐字段覆盖与恢复跟随来源的编辑对话框（金额与币种成对编辑，可清除为不公开）、手动条目的新增／删除、隐藏／恢复，以及档位整体编辑。
// Pos: [Map](L2-2.md)；管理面板内的赞助区。
// Effects/Dependencies: 管理员 API（版本检查与幂等键）、应用栏搜索与 snackbar；失去权限时通知工作区并清理私有状态。
import { LitElement, html, nothing } from "lit";
import { clientText, initializeI18nClient } from "../i18n/client";
import { fetchJson, JsonResponseError } from "./shared/catalog";
import { setAppBarSearch, clearAppBarSearch } from "../lib/app-bar";
import { collectionList } from "./ui/collection-view";
import { segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { loadingState, errorState, emptyState } from "./ui/state";
import { modal } from "./ui/modal";
import { snackbar } from "../lib/snackbar";
import { formatDate } from "../lib/date-format";
import {
  SPONSOR_CARDS,
  SPONSOR_CHANNELS,
  SPONSOR_LOCALES,
  SPONSOR_MESSAGE_LENGTH,
  SPONSOR_NAME_LENGTH,
  SPONSOR_TIER_ID,
  formatSponsorAmount,
  isSponsorAvatar,
  sponsorAmount,
  sponsorCardImage,
  type SponsorAmount,
  type SponsorChannel,
  type SponsorTier,
} from "../config/sponsor";
import type { Locale } from "../i18n/locales";

const API = "/api/v1/admin/sponsors";
const FIELDS = ["name", "avatar", "message", "channel", "tier", "status", "firstAt", "lastAt"] as const;
type Field = (typeof FIELDS)[number];
type Filter = "all" | "active" | "past" | "hidden";
const LOCALE_NAMES: Record<string, string> = { ja: "日本語", en: "English", "zh-TW": "繁體中文", "zh-CN": "简体中文", ko: "한국어" };

interface Source {
  channel: SponsorChannel;
  name: string;
  avatar: string | null;
  message: string | null;
  tier: string;
  active: boolean;
  firstAt: number;
  lastAt: number | null;
  amount: SponsorAmount | null;
}
/** `null` follows the source; an amount override of `""` publishes none. */
type AmountChoice = SponsorAmount | "" | null;
type Overrides = { [K in Field]: string | number | null } & { amount: AmountChoice };
interface Entry {
  id: string;
  origin: "manual" | "source";
  source: Source | null;
  overrides: Overrides;
  effective: {
    channel: SponsorChannel;
    name: string;
    avatar: string | null;
    message: string | null;
    tier: string;
    active: boolean;
    firstAt: number;
    amount: SponsorAmount | null;
  };
  hidden: boolean;
  version: number;
  updatedAt: number;
}
interface SponsorList {
  revision: number;
  tiersVersion: number;
  sourceUpdatedAt: string | null;
  tiers: SponsorTier[];
  entries: Entry[];
}
/**
 * An open supporter editor. `fields` holds only what changed: a string sets the value, `null` follows the source.
 * `amount` is undefined until the amount or currency changes; typed values stay as text until saved.
 */
interface Draft {
  entry: Entry | null;
  fields: Partial<Record<Field, string | null>>;
  amount?: AmountChoice;
  hidden: boolean;
  attempted: boolean;
  key: string;
}
interface TierDraft {
  tiers: (Omit<SponsorTier, "cny" | "usd"> & { cny: string; usd: string; existing: boolean })[];
  attempted: boolean;
  key: string;
}

const day = (seconds: number | null | undefined) =>
  typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : "";
const today = () => new Date().toISOString().slice(0, 10);

export class SponsorAdmin extends LitElement {
  static properties = {
    locale: {},
    document: { state: true },
    phase: { state: true },
    filter: { state: true },
    query: { state: true },
    draft: { state: true },
    tierDraft: { state: true },
    removing: { state: true },
    busy: { state: true },
  };
  declare locale: string;
  declare private document: SponsorList | null;
  declare private phase: "loading" | "ready" | "error";
  declare private filter: Filter;
  declare private query: string;
  declare private draft: Draft | null;
  declare private tierDraft: TierDraft | null;
  declare private removing: boolean;
  declare private busy: boolean;
  private lifetime = new AbortController();
  private generation = 0;
  private stopLocale?: () => void;

  constructor() {
    super();
    this.locale = initializeI18nClient().committed;
    this.document = null;
    this.phase = "loading";
    this.filter = "all";
    this.query = "";
    this.draft = null;
    this.tierDraft = null;
    this.removing = false;
    this.busy = false;
  }
  createRenderRoot() {
    return this;
  }
  private t = (key: string) => clientText(this.locale, `admin.page.sponsors.${key}`);
  private channelName = (channel: string) => this.t(`channels.${channel}`);
  private tierName = (id: string) => this.document?.tiers.find((tier) => tier.id === id)?.labels[this.locale as Locale] ?? id;

  override connectedCallback() {
    super.connectedCallback();
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    const i18n = initializeI18nClient();
    this.locale = i18n.committed;
    this.stopLocale = i18n.subscribe((catalogue) => {
      this.locale = catalogue.locale;
      this.requestUpdate();
      this.syncSearch();
    });
    this.syncSearch();
    this.refresh();
  }
  override disconnectedCallback() {
    this.lifetime.abort();
    this.stopLocale?.();
    clearAppBarSearch("sponsor-admin");
    this.document = null;
    this.draft = null;
    this.tierDraft = null;
    super.disconnectedCallback();
  }
  private syncSearch() {
    setAppBarSearch("sponsor-admin", {
      value: this.query,
      label: this.t("search"),
      onInput: (value) => {
        this.query = value.trim().toLocaleLowerCase();
      },
    });
  }

  refresh() {
    void this.load();
  }
  private async request<T>(path: string, init: RequestInit = {}, key?: string): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    if (init.body) headers.set("content-type", "application/json");
    if (key) headers.set("Idempotency-Key", key);
    return fetchJson<T>(path, { credentials: "same-origin", cache: "no-store", ...init, headers, signal: this.lifetime.signal });
  }
  private denied(error: unknown) {
    if (error instanceof JsonResponseError && (error.status === 401 || error.status === 403)) {
      this.document = null;
      this.draft = null;
      this.tierDraft = null;
      this.dispatchEvent(new CustomEvent("admin-access-denied"));
      return true;
    }
    return false;
  }
  private async load() {
    const generation = ++this.generation;
    if (!this.document) this.phase = "loading";
    try {
      const { sponsors } = await this.request<{ sponsors: SponsorList }>(API);
      if (generation !== this.generation) return;
      this.document = sponsors;
      this.phase = "ready";
    } catch (error) {
      if (this.lifetime.signal.aborted || generation !== this.generation) return;
      if (!this.denied(error)) this.phase = this.document ? "ready" : "error";
      if (this.document) snackbar(this.t("loadFailed"), { error: true });
    }
  }

  /** Send one write; on success the response carries the refreshed list. */
  private async write(path: string, method: string, body: unknown, key: string, done: string): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const result = await this.request<{ sponsors?: SponsorList }>(path, { method, body: JSON.stringify(body) }, key);
      if (result.sponsors) this.document = result.sponsors;
      else await this.load();
      snackbar(this.t(done));
      return true;
    } catch (error) {
      if (this.lifetime.signal.aborted || this.denied(error)) return false;
      if (error instanceof JsonResponseError && error.status === 409) {
        await this.load();
        snackbar(this.t("conflict"), { error: true });
        return true;
      }
      const code = (error as JsonResponseError).body as { error?: { code?: string } } | undefined;
      snackbar(this.t(code?.error?.code === "invalid_sponsor" || code?.error?.code === "invalid_sponsor_tiers" ? "invalid" : "saveFailed"), {
        error: true,
      });
      return false;
    } finally {
      this.busy = false;
    }
  }

  /* ---- Supporter editor ---- */

  private open(entry: Entry | null) {
    this.draft = {
      entry,
      fields: entry ? {} : { channel: "other", firstAt: today(), name: "" },
      hidden: entry?.hidden ?? false,
      attempted: false,
      key: `sponsor-${crypto.randomUUID()}`,
    };
  }
  private close = () => {
    if (!this.busy) {
      this.draft = null;
      this.removing = false;
    }
  };
  private sourceText(field: Field): string {
    const source = this.draft?.entry?.source;
    if (!source) return "";
    if (field === "status") return "";
    if (field === "firstAt" || field === "lastAt") return day(source[field]);
    return String(source[field] ?? "");
  }
  /** The value a field shows: the pending change, the stored override, or the source. */
  private value(field: Field): string {
    const draft = this.draft!;
    if (field in draft.fields) return draft.fields[field] ?? this.sourceText(field);
    const stored = draft.entry?.overrides[field];
    if (stored === null || stored === undefined) return this.sourceText(field);
    return field === "firstAt" || field === "lastAt" ? day(stored as number) : String(stored);
  }
  private overridden(field: Field): boolean {
    const draft = this.draft!;
    return field in draft.fields ? draft.fields[field] !== null : draft.entry?.overrides[field] !== null && draft.entry?.overrides[field] !== undefined;
  }
  private set(field: Field, value: string | null) {
    this.draft = { ...this.draft!, fields: { ...this.draft!.fields, [field]: value }, key: `sponsor-${crypto.randomUUID()}` };
  }
  /** The stored or pending amount choice, before falling back to the source. */
  private amountChoice(): AmountChoice {
    const draft = this.draft!;
    return draft.amount !== undefined ? draft.amount : (draft.entry?.overrides.amount ?? null);
  }
  private amountValue(): SponsorAmount {
    const choice = this.amountChoice();
    const shown = choice === null ? (this.draft!.entry?.source?.amount ?? null) : choice || null;
    return shown ?? { value: "", currency: "" };
  }
  private setAmount(change: AmountChoice | Partial<SponsorAmount>) {
    const amount = change === null || change === "" ? change : { ...this.amountValue(), ...change };
    this.draft = { ...this.draft!, amount, key: `sponsor-${crypto.randomUUID()}` };
  }
  /** What the request sends: empty text publishes no amount; a manual supporter has no source to follow. */
  private amountPayload(choice: AmountChoice): AmountChoice {
    if (choice === null || choice === "") return choice;
    return sponsorAmount(choice.value, choice.currency) ?? (this.draft!.entry?.origin === "source" ? "" : null);
  }
  private missing(): (Field | "amount")[] {
    const draft = this.draft!;
    const missing: (Field | "amount")[] = [];
    const amount = this.amountValue();
    if ((amount.value.trim() || amount.currency.trim()) && !sponsorAmount(amount.value, amount.currency)) missing.push("amount");
    if (!this.value("name").trim()) missing.push("name");
    if ((!draft.entry || draft.entry.origin === "manual") && !this.value("firstAt")) missing.push("firstAt");
    if ([...this.value("name")].length > SPONSOR_NAME_LENGTH) missing.push("name");
    if (!isSponsorAvatar(this.value("avatar").trim())) missing.push("avatar");
    if ([...this.value("message")].length > SPONSOR_MESSAGE_LENGTH) missing.push("message");
    return [...new Set(missing)];
  }
  private async save(event: SubmitEvent) {
    event.preventDefault();
    const draft = this.draft!;
    if (this.missing().length) {
      this.draft = { ...draft, attempted: true };
      return;
    }
    // An empty select or date follows the source (or the dates, for hand-entered supporters).
    const fields: Record<string, string | null | AmountChoice> = Object.fromEntries(
      Object.entries(draft.fields).map(([field, value]) => [
        field,
        (field === "status" || field === "firstAt" || field === "lastAt") && value === "" ? null : value,
      ]),
    );
    if (draft.amount !== undefined) fields.amount = this.amountPayload(draft.amount);
    const saved = draft.entry
      ? await this.write(
          `${API}/${draft.entry.id}`,
          "PUT",
          { expectedVersion: draft.entry.version, fields, ...(draft.hidden !== draft.entry.hidden ? { hidden: draft.hidden } : {}) },
          draft.key,
          "saved",
        )
      : await this.write(API, "POST", { fields }, draft.key, "saved");
    if (saved) this.draft = null;
  }
  private async removeDonor() {
    const entry = this.draft?.entry;
    if (!entry) return;
    const removed = await this.write(`${API}/${entry.id}`, "DELETE", { expectedVersion: entry.version }, this.draft!.key, "removed");
    if (removed) {
      this.draft = null;
      this.removing = false;
    }
  }

  private restore(field: Field) {
    const source = this.draft?.entry?.source;
    if (!source || !this.overridden(field)) return nothing;
    const label = this.t("follow").replace("{channel}", this.channelName(source.channel));
    return html`<button class="icon-button" type="button" aria-label=${label} title=${label} ?disabled=${this.busy}
      @click=${() => this.set(field, null)}>${icon("undo", 20)}</button>`;
  }
  private field(field: Field, control: unknown) {
    return html`<div class="admin-sponsor-field">${control}${this.restore(field)}</div>`;
  }
  private textField(field: "name" | "avatar" | "message" | "firstAt" | "lastAt", options: { type?: string; maxlength?: number; rows?: number } = {}) {
    const invalid = this.draft!.attempted && this.missing().includes(field);
    return this.field(
      field,
      html`<md-outlined-text-field
        id=${`admin-sponsor-${field}`}
        label=${this.t(field)}
        type=${options.type ?? "text"}
        rows=${options.rows ?? nothing}
        maxlength=${options.maxlength ?? nothing}
        .value=${this.value(field)}
        ?error=${invalid}
        ?disabled=${this.busy}
        @input=${(event: Event) => this.set(field, (event.target as HTMLInputElement).value)}
      ></md-outlined-text-field>`,
    );
  }
  private select(field: "channel" | "tier" | "status", options: { value: string; label: string }[]) {
    return this.field(
      field,
      html`<md-outlined-select
        id=${`admin-sponsor-${field}`}
        label=${this.t(field)}
        .value=${this.value(field)}
        ?disabled=${this.busy}
        @change=${(event: Event) => this.set(field, (event.target as HTMLSelectElement).value)}
      >
        ${options.map((option) => html`<md-select-option value=${option.value} ?selected=${option.value === this.value(field)}>
          <div slot="headline">${option.label}</div>
        </md-select-option>`)}
      </md-outlined-select>`,
    );
  }
  /** Amount and currency edit as one value; clearing publishes none, undo follows the source again. */
  private amountField() {
    const draft = this.draft!;
    const invalid = draft.attempted && this.missing().includes("amount");
    const { value, currency } = this.amountValue();
    const source = draft.entry?.source;
    const follow = source ? this.t("follow").replace("{channel}", this.channelName(source.channel)) : "";
    const input = (event: Event) => (event.target as HTMLInputElement).value;
    return html`<div class="admin-sponsor-field admin-sponsor-amount">
      <md-outlined-text-field id="admin-sponsor-amount" label=${this.t("amount")} inputmode="decimal" .value=${value}
        ?error=${invalid} ?disabled=${this.busy} @input=${(event: Event) => this.setAmount({ value: input(event) })}></md-outlined-text-field>
      <md-outlined-text-field id="admin-sponsor-currency" label=${this.t("currency")} maxlength="3" .value=${currency}
        ?error=${invalid} ?disabled=${this.busy}
        @input=${(event: Event) => this.setAmount({ currency: input(event).toUpperCase() })}></md-outlined-text-field>
      ${value || currency
        ? html`<button class="icon-button" type="button" aria-label=${this.t("clearAmount")} title=${this.t("clearAmount")} ?disabled=${this.busy}
            @click=${() => this.setAmount(draft.entry?.origin === "source" ? "" : null)}>${icon("close", 20)}</button>`
        : nothing}
      ${source && this.amountChoice() !== null
        ? html`<button class="icon-button" type="button" aria-label=${follow} title=${follow} ?disabled=${this.busy}
            @click=${() => this.setAmount(null)}>${icon("undo", 20)}</button>`
        : nothing}
    </div>`;
  }
  private avatarPreview(url: string, name: string, size = 40) {
    return html`<span class="list-item__avatar admin-sponsor-avatar" style=${`--avatar-size: ${size}px`}>
      ${url && isSponsorAvatar(url)
        ? html`<img src=${url} alt="" width=${size} height=${size} decoding="async" referrerpolicy="no-referrer" />`
        : html`<span aria-hidden="true">${[...name][0]?.toUpperCase() ?? ""}</span>`}
    </span>`;
  }
  private renderEditor() {
    const draft = this.draft;
    if (!draft) return nothing;
    const entry = draft.entry;
    const synced = entry?.origin === "source";
    const missing = draft.attempted ? this.missing() : [];
    const tiers = this.document?.tiers ?? [];
    const statusLabel = synced ? this.t("statusSource") : this.t("statusAuto");
    return html`<dialog class="dialog admin-sponsor-dialog" aria-labelledby="admin-sponsor-title" ${modal(this.close)}>
      <header class="dialog__header"><h2 id="admin-sponsor-title">${entry ? this.t("edit") : this.t("add")}</h2></header>
      <div class="dialog__body">
        <form id="admin-sponsor-form" class="stack" novalidate @submit=${(event: SubmitEvent) => void this.save(event)}>
          <div class="cluster admin-sponsor-identity">
            ${this.avatarPreview(this.value("avatar").trim(), this.value("name"), 64)}
            <span class="stack">
              <strong>${this.value("name") || "—"}</strong>
              ${synced ? html`<span class="chip chip--static">${this.channelName(entry!.source!.channel)}</span>` : nothing}
            </span>
          </div>
          ${this.textField("name", { maxlength: SPONSOR_NAME_LENGTH })}
          ${this.textField("avatar", { type: "url" })}
          ${this.textField("message", { type: "textarea", rows: 3, maxlength: SPONSOR_MESSAGE_LENGTH })}
          ${this.select("channel", SPONSOR_CHANNELS.map((channel) => ({ value: channel, label: this.channelName(channel) })))}
          ${this.select("tier", tiers.map((tier) => ({ value: tier.id, label: this.tierName(tier.id) })))}
          ${this.amountField()}
          ${this.select("status", [
            { value: "", label: statusLabel },
            { value: "active", label: this.t("current") },
            { value: "past", label: this.t("past") },
          ])}
          ${this.textField("firstAt", { type: "date" })}
          ${this.textField("lastAt", { type: "date" })}
          <label class="check-row admin-sponsor-shown">
            <md-switch ?selected=${!draft.hidden} ?disabled=${this.busy}
              @change=${(event: Event) => (this.draft = { ...draft, hidden: !(event.target as HTMLInputElement & { selected: boolean }).selected })}></md-switch>
            ${this.t("shown")}
          </label>
          <div class="cluster" role="status">${missing.length
            ? html`<span>${this.t("checkFields")}</span>${missing.map((field) => html`<a href=${`#admin-sponsor-${field}`} @click=${(event: Event) => {
                event.preventDefault();
                this.querySelector<HTMLElement>(`#admin-sponsor-${field}`)?.focus();
              }}>${this.t(field)}</a>`)}`
            : nothing}</div>
        </form>
      </div>
      <footer class="dialog__actions">
        ${entry && !synced
          ? html`<button class="button button--text admin-sponsor-remove" type="button" ?disabled=${this.busy} @click=${() => (this.removing = true)}>${this.t("remove")}</button>`
          : nothing}
        <button class="button button--text" type="button" ?disabled=${this.busy} @click=${this.close}>${this.t("cancel")}</button>
        <button class="button" type="submit" form="admin-sponsor-form" ?disabled=${this.busy}>${this.t("save")}</button>
      </footer>
    </dialog>
    ${this.removing && entry
      ? html`<dialog class="dialog" aria-labelledby="admin-sponsor-remove-title" ${modal(() => {
          if (!this.busy) this.removing = false;
        })}>
          <header class="dialog__header"><h2 id="admin-sponsor-remove-title">${this.t("confirmRemove")}</h2></header>
          <div class="dialog__body"><strong>${entry.effective.name}</strong></div>
          <footer class="dialog__actions">
            <button class="button button--text" type="button" ?disabled=${this.busy} @click=${() => (this.removing = false)}>${this.t("cancel")}</button>
            <button class="button button--danger" type="button" ?disabled=${this.busy} @click=${() => void this.removeDonor()}>${this.t("remove")}</button>
          </footer>
        </dialog>`
      : nothing}`;
  }

  /* ---- Tiers ---- */

  private openTiers() {
    this.tierDraft = {
      tiers: (this.document?.tiers ?? []).map((tier) => ({ ...tier, cny: String(tier.cny), usd: String(tier.usd), existing: true })),
      attempted: false,
      key: `sponsor-tiers-${crypto.randomUUID()}`,
    };
  }
  private closeTiers = () => {
    if (!this.busy) this.tierDraft = null;
  };
  private editTier(index: number, change: Partial<TierDraft["tiers"][number]>) {
    const tiers = [...this.tierDraft!.tiers];
    tiers[index] = { ...tiers[index]!, ...change };
    this.tierDraft = { ...this.tierDraft!, tiers, key: `sponsor-tiers-${crypto.randomUUID()}` };
  }
  private moveTier(index: number, offset: number) {
    const tiers = [...this.tierDraft!.tiers];
    const [tier] = tiers.splice(index, 1);
    tiers.splice(index + offset, 0, tier!);
    this.tierDraft = { ...this.tierDraft!, tiers, key: `sponsor-tiers-${crypto.randomUUID()}` };
  }
  private tierProblems(): string[] {
    const tiers = this.tierDraft!.tiers;
    const problems: string[] = [];
    tiers.forEach((tier, index) => {
      if (!SPONSOR_TIER_ID.test(tier.id) || tiers.findIndex((other) => other.id === tier.id) !== index) problems.push(`${index}-id`);
      for (const locale of SPONSOR_LOCALES) if (!tier.labels[locale]?.trim()) problems.push(`${index}-${locale}`);
      for (const currency of ["cny", "usd"] as const) {
        const amount = Number(tier[currency]);
        if (tier[currency].trim() === "" || !Number.isFinite(amount) || amount < 0) problems.push(`${index}-${currency}`);
      }
    });
    return problems;
  }
  private async saveTiers(event: SubmitEvent) {
    event.preventDefault();
    const draft = this.tierDraft!;
    if (this.tierProblems().length) {
      this.tierDraft = { ...draft, attempted: true };
      return;
    }
    const tiers = draft.tiers.map(({ id, labels, cny, usd, card }) => ({ id, labels, cny: Number(cny), usd: Number(usd), card }));
    if (await this.write(`${API}/tiers`, "PUT", { expectedVersion: this.document!.tiersVersion, tiers }, draft.key, "saved"))
      this.tierDraft = null;
  }
  private renderTierEditor() {
    const draft = this.tierDraft;
    if (!draft) return nothing;
    const problems = draft.attempted ? this.tierProblems() : [];
    const field = (index: number, name: string, label: string, value: string, onInput: (value: string) => void, options: { type?: string; readonly?: boolean } = {}) =>
      html`<md-outlined-text-field
        id=${`admin-sponsor-tier-${index}-${name}`}
        label=${label}
        type=${options.type ?? "text"}
        .value=${value}
        ?readonly=${options.readonly}
        ?error=${problems.includes(`${index}-${name}`)}
        ?disabled=${this.busy}
        @input=${(event: Event) => onInput((event.target as HTMLInputElement).value)}
      ></md-outlined-text-field>`;
    return html`<dialog class="dialog admin-sponsor-dialog" aria-labelledby="admin-sponsor-tiers-title" ${modal(this.closeTiers)}>
      <header class="dialog__header"><h2 id="admin-sponsor-tiers-title">${this.t("editTiers")}</h2></header>
      <div class="dialog__body">
        <form id="admin-sponsor-tiers-form" class="stack" novalidate @submit=${(event: SubmitEvent) => void this.saveTiers(event)}>
          ${draft.tiers.map(
            (tier, index) => html`<section class="surface stack admin-sponsor-tier" aria-label=${tier.labels[this.locale as Locale] || tier.id || this.t("addTier")}>
              <div class="cluster">
                <span class="chip chip--static">${index + 1}</span>
                <span class="row__spacer"></span>
                <button class="icon-button" type="button" aria-label=${this.t("moveUp")} title=${this.t("moveUp")} ?disabled=${this.busy || index === 0}
                  @click=${() => this.moveTier(index, -1)}>${icon("arrow_upward", 20)}</button>
                <button class="icon-button" type="button" aria-label=${this.t("moveDown")} title=${this.t("moveDown")} ?disabled=${this.busy || index === draft.tiers.length - 1}
                  @click=${() => this.moveTier(index, 1)}>${icon("arrow_downward", 20)}</button>
                <button class="icon-button" type="button" aria-label=${this.t("removeTier")} title=${this.t("removeTier")} ?disabled=${this.busy || draft.tiers.length === 1}
                  @click=${() => {
                    this.tierDraft = { ...draft, tiers: draft.tiers.filter((_, other) => other !== index), key: `sponsor-tiers-${crypto.randomUUID()}` };
                  }}>${icon("delete", 20)}</button>
              </div>
              ${field(index, "id", this.t("tierId"), tier.id, (value) => this.editTier(index, { id: value.trim().toLowerCase() }), { readonly: tier.existing })}
              <fieldset class="stack admin-sponsor-labels">
                <legend class="detail-section-title">${this.t("label")}</legend>
                ${SPONSOR_LOCALES.map((locale) =>
                  field(index, locale, LOCALE_NAMES[locale],tier.labels[locale] ?? "", (value) =>
                    this.editTier(index, { labels: { ...tier.labels, [locale]: value } }),
                  ),
                )}
              </fieldset>
              <div class="grid grid--fit admin-sponsor-amounts">
                ${field(index, "cny", this.t("cny"), tier.cny, (value) => this.editTier(index, { cny: value }), { type: "number" })}
                ${field(index, "usd", this.t("usd"), tier.usd, (value) => this.editTier(index, { usd: value }), { type: "number" })}
              </div>
              <md-outlined-select label=${this.t("card")} .value=${tier.card ?? ""} ?disabled=${this.busy}
                @change=${(event: Event) => this.editTier(index, { card: (event.target as HTMLSelectElement).value || null })}>
                <md-select-option value="" ?selected=${!tier.card}><div slot="headline">${this.t("noCard")}</div></md-select-option>
                ${SPONSOR_CARDS.map((card) => html`<md-select-option value=${card} ?selected=${tier.card === card}>
                  <img slot="start" src=${sponsorCardImage(card)} alt="" width="36" height="17" loading="lazy" decoding="async" />
                  <div slot="headline">${card.replace(/^tgwcard_|_small$/gu, "")}</div>
                </md-select-option>`)}
              </md-outlined-select>
            </section>`,
          )}
          <button class="button button--tonal" type="button" ?disabled=${this.busy || draft.tiers.length >= 20}
            @click=${() => {
              this.tierDraft = {
                ...draft,
                tiers: [...draft.tiers, { id: "", labels: {} as SponsorTier["labels"], cny: "0", usd: "0", card: null, existing: false }],
                key: `sponsor-tiers-${crypto.randomUUID()}`,
              };
            }}>${icon("add", 20)}${this.t("addTier")}</button>
          <div class="cluster" role="status">${problems.length
            ? html`<span>${this.t("checkFields")}</span>${draft.tiers.map((_, index) => {
                const own = problems.filter((problem) => problem.startsWith(`${index}-`));
                return own.length
                  ? html`<span class="cluster admin-sponsor-problem">
                      <span class="chip chip--static">${index + 1}</span>
                      ${own.map((problem) => html`<a href=${`#admin-sponsor-tier-${problem}`} @click=${(event: Event) => {
                        event.preventDefault();
                        this.querySelector<HTMLElement>(`#admin-sponsor-tier-${problem}`)?.focus();
                      }}>${this.problemLabel(problem)}</a>`)}
                    </span>`
                  : nothing;
              })}`
            : nothing}</div>
        </form>
      </div>
      <footer class="dialog__actions">
        <button class="button button--text" type="button" ?disabled=${this.busy} @click=${this.closeTiers}>${this.t("cancel")}</button>
        <button class="button" type="submit" form="admin-sponsor-tiers-form" ?disabled=${this.busy}>${this.t("save")}</button>
      </footer>
    </dialog>`;
  }
  private problemLabel(problem: string) {
    const name = problem.slice(problem.indexOf("-") + 1);
    return name === "id" ? this.t("tierId") : name === "cny" || name === "usd" ? this.t(name) : LOCALE_NAMES[name];
  }

  /* ---- List ---- */

  private visible(entries: Entry[]) {
    return entries.filter((entry) => {
      if (this.filter === "hidden" ? !entry.hidden : this.filter !== "all" && (entry.hidden || entry.effective.active !== (this.filter === "active")))
        return false;
      return !this.query || entry.effective.name.toLocaleLowerCase().includes(this.query);
    });
  }
  private renderList() {
    if (this.phase === "loading") return loadingState(this.t("loading"));
    if (this.phase === "error" || !this.document) return errorState(this.t("loadFailed"), this.t("retry"), () => this.refresh());
    const list = this.document;
    const entries = this.visible(list.entries);
    const count = (filter: Filter) =>
      list.entries.filter((entry) =>
        filter === "all" ? true : filter === "hidden" ? entry.hidden : !entry.hidden && entry.effective.active === (filter === "active"),
      ).length;
    return html`
      <div class="cluster admin-sponsor-toolbar">
        ${segmented({
          label: this.t("title"),
          value: this.filter,
          onSelect: (value) => (this.filter = value),
          options: (["all", "active", "past", "hidden"] as const).map((value) => ({ value, label: `${this.t(`filters.${value}`)} ${count(value)}` })),
        })}
        <span class="row__spacer"></span>
        <span class="admin-sponsor-sync">${list.sourceUpdatedAt
          ? this.t("synced").replace("{date}", formatDate(this.locale, Date.parse(list.sourceUpdatedAt), { time: true }))
          : this.t("notSynced")}</span>
        <button class="button button--tonal" type="button" ?disabled=${this.busy} @click=${() => this.open(null)}>${icon("person_add", 20)}${this.t("add")}</button>
      </div>
      ${entries.length
        ? collectionList(
            entries.map((entry) => {
              const edited = entry.overrides.amount !== null || FIELDS.some((field) => entry.overrides[field] !== null);
              return {
                id: entry.id,
                title: entry.effective.name,
                subtitle: html`<span class="admin-sponsor-meta">
                    <span>${this.channelName(entry.effective.channel)}</span>
                    <span>${entry.effective.active ? this.tierName(entry.effective.tier) : this.t("past")}</span>
                    ${entry.effective.amount ? html`<span>${formatSponsorAmount(this.locale, entry.effective.amount)}</span>` : nothing}
                  </span>${entry.effective.message ? html`<span class="admin-sponsor-message">${entry.effective.message}</span>` : nothing}`,
                media: this.avatarPreview(entry.effective.avatar ?? "", entry.effective.name),
                trailing: html`<span class="cluster admin-sponsor-marks">
                  ${entry.origin === "manual" ? html`<span class="chip chip--static">${this.t("manual")}</span>` : nothing}
                  ${edited ? html`<span class="chip chip--static chip--tonal">${this.t("edited")}</span>` : nothing}
                  ${entry.hidden ? html`<span class="chip chip--static">${icon("visibility_off", 18)}${this.t("hidden")}</span>` : nothing}
                </span>`,
                onOpen: () => this.open(entry),
              };
            }),
          )
        : emptyState({ title: this.t("empty"), icon: "favorite" })}
    `;
  }
  private renderTiers() {
    const tiers = this.document?.tiers;
    if (!tiers) return nothing;
    return html`<section class="admin-summary surface stack" aria-labelledby="admin-sponsor-tiers-heading">
      <div class="cluster">
        <h3 id="admin-sponsor-tiers-heading" class="detail-section-title">${this.t("tiers")}</h3>
        <span class="row__spacer"></span>
        <button class="button button--text" type="button" ?disabled=${this.busy} @click=${() => this.openTiers()}>${icon("edit", 20)}${this.t("editTiers")}</button>
      </div>
      <ul class="list admin-sponsor-tier-list">
        ${tiers.map((tier) => {
          const amounts = [tier.cny ? `¥${tier.cny}` : "", tier.usd ? `$${tier.usd}` : ""].filter(Boolean).join(" / ");
          return html`<li class="list-item">
            <span class="list-item__leading admin-sponsor-card">${tier.card
              ? html`<img src=${sponsorCardImage(tier.card)} alt="" width="48" height="22" loading="lazy" decoding="async" />`
              : icon("favorite", 20)}</span>
            <span class="list-item__body">
              <strong class="list-item__headline">${this.tierName(tier.id)}</strong>
              <span class="list-item__supporting">${amounts || this.t("anyAmount")}</span>
            </span>
          </li>`;
        })}
      </ul>
    </section>`;
  }
  render() {
    return html`
      <section class="admin-ledger admin-sponsors stack" aria-busy=${String(this.phase === "loading" || this.busy)}>
        <h3 class="detail-section-title">${this.t("title")}</h3>
        ${this.renderList()}
      </section>
      ${this.renderTiers()}
      ${this.renderEditor()}
      ${this.renderTierEditor()}
    `;
  }
}
customElements.define("sponsor-admin", SponsorAdmin);
