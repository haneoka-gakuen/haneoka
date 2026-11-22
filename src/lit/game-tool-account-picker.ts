// L3 — GEB
// Input: Private game profiles, active tool account and locale.
// Output: Shared compact switcher and account management cards.
// Pos: [Map](L2-2.md); account control for the three game tools.
// Effects/Dependencies: Native dialog, owner-scoped account directory, and public card imagery.
import { LitElement, html, nothing } from "lit";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import { clientText } from "../i18n/client";
import { languageFlags } from "../i18n/language-flags";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import { GAME_REGION_NAMES, profileRegion } from "../lib/game-records";
import { isGameToolAccountId, legacyToolAccount, type GameTool, type GameToolAccount } from "../lib/game-tool-accounts";
import { createGameToolAccount, GAME_TOOL_ACCOUNTS_CHANGED, gameToolAccounts, legacyGameToolAccounts, legacyGameToolAccountsWithData, moveGameToolAccount, purgeGameToolAccount, refreshGameToolAccounts,
  removeGameToolAccount, renameGameToolAccount, selectGameToolAccount } from "../lib/game-tool-account-store";
import type { GameToolCopyPreview } from "../lib/game-tool-account-copy";
import type { PublicReleaseServer } from "../lib/temporary-public-routing";
import jpIcon from "../assets/icons/bushimo-circle.svg?url";
import intlIcon from "../assets/icons/bilibili-circle.svg?url";
import { icon } from "./ui/icon";
import { iconButton, segmented } from "./ui/controls";
import { modal } from "./ui/modal";
import "../styles/game-tool-account.css";

const shape = Array.from({ length: 96 }, (_, index) => {
  const angle = index / 96 * 2 * Math.PI;
  const radius = 46 * (1 + .085 * Math.cos(8 * angle));
  return `${(50 + radius * Math.cos(angle)).toFixed(2)},${(50 + radius * Math.sin(angle)).toFixed(2)}`;
}).join(" ");
const regionFlags = {
  tw: languageFlags.find(flag => flag.value === "zh-TW")!.image,
  en: languageFlags.find(flag => flag.value === "en")!.image,
  kr: languageFlags.find(flag => flag.value === "ko")!.image,
};
const releaseIcon = (account: GameToolAccount) => {
  const region = account.uid && profileRegion(account.uid);
  if (region && region !== "jp") return regionFlags[region];
  return account.server === "jp" ? jpIcon : intlIcon;
};
const appBarOwner = (tool: GameTool) => `game-tool-account-${tool}`;
export function setGameToolAccountAction(options: {
  tool: GameTool;
  locale: string;
  account?: GameToolAccount;
  legacyServers?: PublicReleaseServer[];
  onSelect: (account: GameToolAccount) => void;
}, host: object) {
  setAppBarActions(appBarOwner(options.tool), html`
    <game-tool-account-picker data-app-bar-keep tool=${options.tool} .locale=${options.locale} .account=${options.account}
      .legacyServers=${options.legacyServers ?? []} .onSelect=${options.onSelect}></game-tool-account-picker>
  `, host, "leading");
}
export const clearGameToolAccountAction = (tool: GameTool) => clearAppBarActions(appBarOwner(tool));
const regionName = (account: GameToolAccount) => {
  const region = account.uid && profileRegion(account.uid);
  return region ? GAME_REGION_NAMES[region] : account.server === "jp" ? "JP" : "Global";
};
export class GameToolAccountPicker extends LitElement {
  static properties = {
    locale: {}, tool: {}, account: { attribute: false }, legacyServers: { attribute: false },
  };
  declare locale: string;
  declare tool: GameTool;
  declare account: GameToolAccount | undefined;
  declare legacyServers: PublicReleaseServer[];
  onSelect?: (account: GameToolAccount) => void;
  private opened = false;
  private creating = false;
  private manage = false;
  private busy = false;
  private error = "";
  private server: PublicReleaseServer = "intl";
  private claim?: { target: GameToolAccount; source: string; kind: "team" | "songs"; preview?: GameToolCopyPreview };
  private editing?: { account: GameToolAccount; kind: "rename" | "remove" };
  private copyModule?: typeof import("../lib/game-tool-account-copy");
  private art = new Map<string, string>();
  private loadingArt = new Set<string>();
  private updateAccounts = () => { this.requestUpdate(); void this.loadArtwork(); };
  constructor() {
    super();
    this.locale = "en";
    this.tool = "team";
    this.legacyServers = [];
  }
  createRenderRoot() { return this; }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(GAME_TOOL_ACCOUNTS_CHANGED, this.updateAccounts);
    void refreshGameToolAccounts().then(this.updateAccounts);
  }
  disconnectedCallback() {
    window.removeEventListener(GAME_TOOL_ACCOUNTS_CHANGED, this.updateAccounts);
    super.disconnectedCallback();
  }
  private t(key: string, fallback: string) {
    return clientText(this.locale, `account.page.toolAccounts.${key}`, fallback);
  }
  private name(account: GameToolAccount) {
    if (account.settings?.alias) return account.settings.alias;
    if (!isGameToolAccountId(account.id)) {
      if (!this.legacyServers.includes(account.server) && !legacyGameToolAccountsWithData(this.tool).includes(account.server))
        return this.t("temporary", "Temporary profile");
      return account.server === "jp" ? this.t("legacyJp", "Original JP") : this.t("legacyGlobal", "Original Global");
    }
    return account.name || account.uid || this.t("temporary", "Temporary profile");
  }
  private close() {
    this.opened = this.creating = this.manage = false;
    this.claim = undefined;
    this.editing = undefined;
    this.error = "";
    this.requestUpdate();
  }
  private finishManagementAction() {
    this.claim = this.editing = undefined;
    this.error = "";
    this.requestUpdate();
  }
  private choose(account: GameToolAccount) {
    selectGameToolAccount(account);
    const url = new URL(location.href);
    url.searchParams.set("gameAccount", account.id);
    history.replaceState(history.state, "", url);
    this.close();
    this.onSelect?.(account);
  }
  private async add(event: SubmitEvent) {
    event.preventDefault();
    if (this.busy) return;
    const field = (event.currentTarget as HTMLFormElement).querySelector("md-outlined-text-field");
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
      const name = field?.value?.trim() || `${this.server === "jp" ? "JP" : "Global"} ${this.t("manual", "Manual account")} ${gameToolAccounts(this.tool).filter(account => account.server === this.server && !account.uid).length + 1}`;
      const account = await createGameToolAccount(this.tool, this.server, name);
      if (this.isConnected) this.choose(account);
    } catch {
      this.error = this.t("saveFailed", "Could not save account");
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }
  private async loadArtwork() {
    if (!this.isConnected || !this.opened) return;
    for (const account of gameToolAccounts(this.tool)) {
      if (!account.favoriteCardId || this.loadingArt.has(account.id)) continue;
      this.loadingArt.add(account.id);
      void fetch(`/api/v1/servers/${account.server}/cards/${account.favoriteCardId}`)
        .then(response => response.ok ? response.json() : null)
        .then((data: { images?: { full?: string; thumbnail?: string } } | null) => {
          const path = data?.images?.full ?? data?.images?.thumbnail;
          if (path?.startsWith("/") && !path.startsWith("//")) {
            this.art.set(account.id, path);
            this.requestUpdate();
          }
        }).catch(() => {});
    }
  }
  private async prepareCopy() {
    const claim = this.claim;
    if (!claim || this.busy) return;
    const source = gameToolAccounts(this.tool).find(account => account.id === claim.source) ?? legacyToolAccount(claim.target.server, this.tool);
    this.busy = true; this.error = ""; this.requestUpdate();
    try {
      const copy = this.copyModule ??= await import("../lib/game-tool-account-copy");
      const preview = await copy.previewGameToolCopy(source, claim.target, claim.kind);
      if (this.claim === claim) this.claim = { ...claim, preview };
    } catch { this.error = this.t("saveFailed", "Could not save account"); }
    finally { this.busy = false; this.requestUpdate(); }
  }
  private async finishCopy(replace: boolean) {
    if (!this.claim?.preview || !this.copyModule || this.busy) return;
    const preview = this.claim.preview;
    this.busy = true; this.error = ""; this.requestUpdate();
    try { await this.copyModule.applyGameToolCopy(preview, replace); this.finishManagementAction(); }
    catch { this.error = this.t("saveFailed", "Could not save account"); }
    finally { this.busy = false; this.requestUpdate(); }
  }
  private async editAccount(event: SubmitEvent) {
    event.preventDefault();
    const editing = this.editing;
    if (!editing || this.busy) return;
    this.busy = true; this.error = ""; this.requestUpdate();
    try {
      if (editing.kind === "rename") {
        const value = (event.currentTarget as HTMLFormElement).querySelector("md-outlined-text-field")?.value ?? "";
        await renameGameToolAccount(editing.account, value);
      } else if (isGameToolAccountId(editing.account.id) && !editing.account.uid) await purgeGameToolAccount(editing.account);
      else await removeGameToolAccount(editing.account, true);
      this.finishManagementAction();
    } catch { this.error = this.t("saveFailed", "Could not save account"); }
    finally { this.busy = false; this.requestUpdate(); }
  }
  private restoreAccount(account: GameToolAccount) {
    void removeGameToolAccount(account, false).catch(() => {
      this.error = this.t("saveFailed", "Could not save account"); this.requestUpdate();
    });
  }
  private copyForm() {
    const claim = this.claim!;
    const sources = [legacyToolAccount(claim.target.server, this.tool), ...gameToolAccounts(this.tool).filter(item =>
      item.server === claim.target.server && !item.uid && item.id !== claim.target.id)];
    return html`<div class="dialog__body stack">
      <div class="tool-account__card">${this.profile(claim.target)}</div>
      <md-outlined-select label=${this.t("source", "Copy from")} .value=${claim.source} ?disabled=${this.busy}
        @change=${(event: Event) => {
          this.claim = { ...claim, source: (event.currentTarget as HTMLElement & { value: string }).value, preview: undefined };
          this.requestUpdate();
        }}>
        ${sources.map(source => html`<md-select-option value=${source.id}><div slot="headline">${this.name(source)}</div></md-select-option>`)}
      </md-outlined-select>
      ${claim.preview ? html`
        <div class="cluster">
          <span class="chip chip--static">${icon("add_circle", 18)} ${this.t("missing", "Missing entries")} ${claim.preview.missing.length}</span>
          <span class="chip chip--static">${icon("swap_horiz", 18)} ${this.t("conflicts", "Conflicting entries")} ${claim.preview.conflicts.length}</span>
        </div>
        <div class="cluster">
          <button class="button button--filled" type="button" ?disabled=${this.busy || !claim.preview.missing.length}
            @click=${() => void this.finishCopy(false)}>${this.t("copyMissing", "Fill missing entries")}</button>
          ${claim.preview.conflicts.length ? html`<button class="button button--outlined" type="button" ?disabled=${this.busy}
            @click=${() => void this.finishCopy(true)}>${this.t("copyReplace", "Copy and replace conflicts")}</button>` : nothing}
        </div>` : html`<button class="button button--tonal" type="button" ?disabled=${this.busy} @click=${() => void this.prepareCopy()}>
          ${icon("swap_horiz", 18)} ${clientText(this.locale, "common.actions.preview", "Preview")}</button>`}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
    </div>`;
  }
  private profile(account: GameToolAccount) {
    const image = this.art.get(account.id);
    const legacy = !isGameToolAccountId(account.id) &&
      (this.legacyServers.includes(account.server) || legacyGameToolAccountsWithData(this.tool).includes(account.server));
    return html`
      ${image ? html`<img class="tool-account__art" src=${image} alt="" loading="lazy" decoding="async" />` : nothing}
      <span class="tool-account__rank" aria-hidden="true">
        <svg viewBox="0 0 100 100"><polygon points=${shape}></polygon></svg>
        ${account.rank === undefined ? icon(account.uid ? "sports_esports" : "person", 23) : html`<span><small>RANK</small><strong>${account.rank}</strong></span>`}
      </span>
      <span class="tool-account__identity">
        <strong class="tool-account__name">${this.name(account)}</strong>
        <span class="tool-account__detail"><img src=${releaseIcon(account)} alt="" />${regionName(account)}</span>
        ${account.uid || account.name || legacy ? html`<span class="tool-account__detail">${icon(account.uid ? "badge" : "edit", 15)}
          ${account.uid ? `UID ${account.uid}` : legacy ? this.t("legacy", "Original data") : this.t("manual", "Manual account")}
        </span>` : nothing}
        ${account.savedAt ? html`<span class="tool-account__detail">${icon("schedule", 15)}
          ${new Intl.DateTimeFormat(this.locale, { dateStyle: "short", timeStyle: "short" }).format(account.savedAt)}
        </span>` : nothing}
      </span>`;
  }
  render() {
    const accounts: GameToolAccount[] = [];
    const selected = this.account ?? legacyToolAccount("intl", this.tool);
    if (this.opened) {
      accounts.push(...gameToolAccounts(this.tool), ...legacyGameToolAccounts(this.tool, selected, this.legacyServers));
      accounts.sort((a, b) => (a.settings?.position ?? 0) - (b.settings?.position ?? 0) || a.id.localeCompare(b.id));
    }
    const title = this.t("title", "Game accounts");
    const add = this.t("add", "Add account");
    const copy = this.t("claim", "Copy account data");
    const manage = this.t("manage", "Manage accounts");
    const removed = this.manage ? [...gameToolAccounts(this.tool, true), ...legacyGameToolAccounts(this.tool, undefined, this.legacyServers, true)]
      .filter(account => account.settings?.removed) : [];
    const active = this.manage ? accounts.filter(account => isGameToolAccountId(account.id) || this.legacyServers.includes(account.server) ||
      legacyGameToolAccountsWithData(this.tool).includes(account.server)) : [];
    const rename = this.t("rename", "Rename account");
    const remove = this.t("remove", "Remove account");
    const editingTitle = this.editing?.kind === "rename" ? rename : remove;
    const close = clientText(this.locale, "common.actions.close", "Close");
    const dialogTitle = this.editing ? editingTitle : this.claim ? copy : this.creating ? add : this.manage ? manage : title;
    const rows = (this.manage ? active : accounts).map(account => this.manage
      ? html`<article class="tool-account__managed">
          <div class="tool-account__card">${this.profile(account)}</div>
          <div class="tool-account__actions">
            ${this.tool !== "history" && isGameToolAccountId(account.id) ? iconButton({ icon: "content_copy", label: copy, onClick: () => {
              if (this.tool === "history") return;
              this.claim = { target: account, source: legacyToolAccount(account.server, this.tool).id, kind: this.tool };
              this.requestUpdate();
            } }) : nothing}
            ${this.copyModule?.hasGameToolCopyBackup(account) ? iconButton({
              icon: "undo", label: this.t("undoCopy", "Undo last copy"), onClick: () => {
                void this.copyModule?.undoGameToolCopy(account).then(() => this.requestUpdate()).catch(() => {
                  if (this.tool === "history") return;
                  this.claim = { target: account, source: legacyToolAccount(account.server, this.tool).id, kind: this.tool };
                  this.error = this.t("saveFailed", "Could not save account"); this.opened = true; this.requestUpdate();
                });
              },
            }) : nothing}
            ${iconButton({ icon: "edit", label: rename, onClick: () => {
              this.editing = { account, kind: "rename" }; this.opened = true; this.requestUpdate();
            } })}
            ${iconButton({ icon: "arrow_upward", label: this.t("moveUp", "Move up"), disabled: active[0]?.id === account.id,
              onClick: () => void moveGameToolAccount(account, -1, active) })}
            ${iconButton({ icon: "arrow_downward", label: this.t("moveDown", "Move down"), disabled: active.at(-1)?.id === account.id,
              onClick: () => void moveGameToolAccount(account, 1, active) })}
            ${iconButton({ icon: "delete", label: remove, onClick: () => {
              this.editing = { account, kind: "remove" }; this.opened = true; this.requestUpdate();
            } })}
          </div>
        </article>`
      : html`<button class="tool-account__card" type="button" aria-pressed=${String(account.id === selected.id)}
          @click=${() => this.choose(account)}>
          ${this.profile(account)}
          <span class="tool-account__select" aria-hidden="true">${icon(account.id === selected.id ? "check_circle" : "chevron_right", 21)}</span>
        </button>`);
    return html`
      <button class="button button--tonal tool-account__trigger" type="button" aria-haspopup="dialog"
            aria-label=${`${title} / ${this.name(selected)}`} @click=${() => {
              this.opened = true; this.requestUpdate(); void refreshGameToolAccounts(); void this.loadArtwork();
            }}>
            <img src=${releaseIcon(selected)} alt="" title=${regionName(selected)} /><span>${this.name(selected)}</span>${icon("expand_more", 17)}
          </button>
      ${this.opened ? html`<dialog class="dialog tool-account__dialog" aria-label=${dialogTitle} ${modal(() => this.close())}>
        <header class="dialog__header tool-account__header">
          <h2>${icon(this.editing?.kind === "remove" ? "delete" : this.editing ? "edit" : this.claim ? "content_copy" : this.creating ? "person_add" : "manage_accounts", 24)}
            ${dialogTitle}</h2>
          ${iconButton({ icon: "close", label: close, onClick: () => this.close() })}
        </header>
        ${this.editing ? html`<form class="dialog__body stack" @submit=${(event: SubmitEvent) => void this.editAccount(event)}>
            ${this.editing.kind === "rename" ? html`<md-outlined-text-field label=${this.t("name", "Nickname")} maxlength="80"
              .value=${this.editing.account.settings?.alias || this.editing.account.name}></md-outlined-text-field>`
              : html`<div class="tool-account__card">${this.profile(this.editing.account)}</div>
                <p>${isGameToolAccountId(this.editing.account.id) && !this.editing.account.uid
                  ? this.t("removeDetailTemporary", "This profile and its data are deleted permanently.")
                  : this.t("removeDetail", "You can restore this account and its data from Removed accounts.")}</p>`}
            ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
            <button class="button button--filled" type="submit" ?disabled=${this.busy}>${this.editing.kind === "rename"
              ? clientText(this.locale, "account.page.save", "Save") : remove}</button>
          </form>` : this.claim ? this.copyForm() : this.creating
          ? html`<form class="dialog__body stack" @submit=${(event: SubmitEvent) => void this.add(event)}>
              ${segmented({ label: this.t("server", "Game version"), value: this.server,
                options: [{ value: "jp", label: "JP", icon: "language" }, { value: "intl", label: "Global", icon: "public" }],
                onSelect: (server: PublicReleaseServer) => { this.server = server; this.requestUpdate(); } })}
              <md-outlined-text-field label=${this.t("name", "Nickname")} maxlength="80"></md-outlined-text-field>
              ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
              <button class="button button--filled" type="submit" ?disabled=${this.busy}>${icon("person_add", 18)}${add}</button>
            </form>`
          : html`<div class="dialog__body tool-account__rows">${rows}
              ${removed.length ? html`<h3 class="detail-section-title">${icon("delete", 20)}${this.t("removed", "Removed accounts")}</h3>
                ${removed.map(account => html`<div class="tool-account__card">
                  ${this.profile(account)}
                  ${iconButton({ icon: "undo", label: this.t("restore", "Restore account"), onClick: () => this.restoreAccount(account) })}
                </div>`)}` : nothing}
            </div>
            <footer class="dialog__actions"><button class="button button--text" type="button" @click=${() => {
              this.manage = !this.manage;
              this.requestUpdate();
              if (this.manage && this.tool !== "history" && !this.copyModule)
                void import("../lib/game-tool-account-copy").then(module => { this.copyModule = module; this.requestUpdate(); });
            }}>${icon("manage_accounts", 18)}${this.manage ? title : manage}</button><button class="button button--tonal" type="button" @click=${() => {
              this.server = selected.server; this.creating = true; this.requestUpdate();
            }}>${icon("person_add", 18)}${add}</button></footer>`}
      </dialog>` : nothing}
    `;
  }
}
if (!customElements.get("game-tool-account-picker")) customElements.define("game-tool-account-picker", GameToolAccountPicker);
