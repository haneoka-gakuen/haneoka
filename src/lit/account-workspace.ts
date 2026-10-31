import { clearContentAccess, refreshContentAccess } from "../lib/content-access";
import { clientText } from "../i18n/client";
import { GAME_REGION_NAMES, gameAccountRegion } from "./shared/game-records";
import { LitElement, html, nothing } from "lit";
import { modal } from "./ui/modal";
import { specList } from "./ui/spec";
import { loadingState } from "./ui/state";
import { svg as discordSvg } from "@thesvg/icons/discord";
import { svg as githubSvg } from "@thesvg/icons/github";
import { svg as googleSvg } from "@thesvg/icons/google";
import { svg as xSvg } from "@thesvg/icons/x";
import { fetchJson, JsonResponseError, preferredLocale } from "./shared/catalog";
import { RequestScope } from "../lib/request-scope";
import { rememberSignedIn, signedInHint } from "../lib/community-viewer";
import { readEarlyJson, takeEarlyRead } from "../lib/early-read";
import { snackbar } from "../lib/snackbar";
import { hasUserCapability } from "../lib/user-roles";
import { formatDate } from "../lib/date-format";

const ACCOUNT_LABEL_KEYS: Readonly<Record<string, string>> = {
  close: "common.actions.close",
  save: "account.page.save",
  privacy: "home.dashboard.privacy",
  terms: "home.dashboard.terms",
};

type Value = Record<string, unknown>;

/** `Chrome · Windows` from a user-agent string; product names stay as they are in every locale. */
function deviceLabel(agent: unknown) {
  const text = String(agent || "");
  const find = (rules: Array<[RegExp, string]>) => rules.find(([pattern]) => pattern.test(text))?.[1];
  const browser = find([[/Edg\//u, "Edge"], [/SamsungBrowser/u, "Samsung Internet"], [/Firefox\//u, "Firefox"], [/Chrome\//u, "Chrome"], [/Safari\//u, "Safari"]]);
  const system = find([[/Android/u, "Android"], [/iPhone|iPad/u, "iOS"], [/Windows/u, "Windows"], [/Mac OS/u, "macOS"], [/Linux/u, "Linux"]]);
  return [browser, system].filter(Boolean).join(" · ");
}
const API_SCOPES = ["team:read", "team:write", "gacha:read", "games:read", "profile:read"];
type AuthMode = "signIn" | "signUp" | "forgotPassword" | "verifyEmail";
type Section = "profile" | "games" | "security" | "sessions" | "relationships" | "moderation" | "management";

const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const icon = (name: string, size = 20) => html`
  <svg class="material-icon" width=${size} height=${size}><use href=${`/icons.svg#${name}`}></use></svg>
`;
const oauthIcons: Record<string, string> = {
  discord: `data:image/svg+xml,${encodeURIComponent(discordSvg)}`,
  github: `data:image/svg+xml,${encodeURIComponent(githubSvg)}`,
  google: `data:image/svg+xml,${encodeURIComponent(googleSvg)}`,
  twitter: `data:image/svg+xml,${encodeURIComponent(xSvg)}`,
};
const oauthIcon = (provider: string) =>
  oauthIcons[provider]
    ? html`
        <img class="oauth-provider-icon" src=${oauthIcons[provider]} alt="" />
      `
    : icon("link", 18);

export class AccountWorkspace extends LitElement {
  static properties = {
    phase: { state: true },
    config: { state: true },
    session: { state: true },
    profile: { state: true },
    sessions: { state: true },
    accounts: { state: true },
    appeals: { state: true },
    games: { state: true },
    relationships: { state: true },
    draft: { state: true },
    removing: { state: true },
    mode: { state: true },
    section: { state: true },
    busy: { state: true },
    message: { state: true },
    error: { state: true },
    apiTokens: { state: true },
    apiTokenValue: { state: true },
    apiTokenRevoking: { state: true },
    apiTokenEvents: { state: true },
    avatarFile: { state: true },
    avatarPreview: { state: true },
    appealOpen: { state: true },
    captchaToken: { state: true },
    captchaFailed: { state: true },
  };
  declare phase: "loading" | "ready" | "error";
  declare config: Value;
  declare session: Value | null;
  declare profile: Value | null;
  declare sessions: Value[];
  declare accounts: Value[];
  declare appeals: Value[];
  declare games: Value[];
  declare relationships: Value[];
  /** Unsaved name, handle and bio, shown in the public card preview. */
  declare draft: { name?: string; handle?: string; bio?: string };
  /** The game account awaiting the removal confirmation. */
  declare removing: Value | null;
  declare mode: AuthMode;
  declare section: Section;
  declare apiTokens: Value[];
  declare apiTokenValue: string;
  declare apiTokenRevoking: Value | null;
  declare apiTokenEvents: Value[];
  declare busy: boolean;
  declare message: string;
  declare error: string;
  declare avatarFile: File | null;
  declare avatarPreview: string;
  declare appealOpen: boolean;
  declare captchaToken: string;
  declare captchaFailed: boolean;
  private lifetime = new AbortController();
  private readonly loadRequests = new RequestScope();
  private readonly profileRequests = new RequestScope();
  private readonly securityRequests = new RequestScope();
  private turnstileContainer: HTMLElement | null = null;
  private turnstileId: string | number | null = null;

  constructor() {
    super();
    this.phase = "loading";
    this.config = {};
    this.session = null;
    this.profile = null;
    this.sessions = [];
    this.accounts = [];
    this.appeals = [];
    this.games = [];
    this.relationships = [];
    this.draft = {};
    this.removing = null;
    this.mode = "signIn";
    this.section = "profile";
    this.apiTokens = [];
    this.apiTokenValue = "";
    this.apiTokenRevoking = null;
    this.apiTokenEvents = [];
    this.busy = false;
    this.message = "";
    this.error = "";
    this.avatarFile = null;
    this.avatarPreview = "";
    this.appealOpen = false;
    this.captchaToken = "";
    this.captchaFailed = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    addEventListener("haneoka:locale-ready", this.onLocale);
    void Promise.all([
      import("@material/web/progress/circular-progress.js"),
      import("@material/web/textfield/outlined-text-field.js"),
    ]);
    const query = new URLSearchParams(location.search);
    if (query.get("verified") === "1") this.message = this.label("verified", "Verified");
    if (query.get("deleted") === "1") this.message = this.label("accountDeleted", "Account deleted.");
    if (query.get("linked") === "1") this.message = this.label("accountLinked", "Account linked.");
    void this.load();
  }

  private readonly onLocale = () => this.requestUpdate();
  disconnectedCallback() {
    this.lifetime.abort();
    this.loadRequests.cancel();
    this.profileRequests.cancel();
    this.securityRequests.cancel();
    removeEventListener("haneoka:locale-ready", this.onLocale);
    this.cancelAvatar();
    this.removeTurnstile();
    super.disconnectedCallback();
  }

  private announced = { error: "", message: "" };
  protected updated() {
    if (this.error !== this.announced.error) {
      this.announced.error = this.error;
      if (this.error) snackbar(this.error, { error: true });
    }
    if (this.message !== this.announced.message) {
      this.announced.message = this.message;
      if (this.message) snackbar(this.message);
    }
    void this.mountTurnstile();
  }

  private label(key: string, fallback: string) {
    return clientText(preferredLocale(), ACCOUNT_LABEL_KEYS[key] ?? `account.page.${key}`, fallback);
  }
  private user() {
    return (this.session?.user as Value | undefined) || null;
  }
  private clearMessages() {
    this.error = "";
    this.message = "";
  }
  private clearSession() {
    clearContentAccess();
    this.loadRequests.cancel();
    this.profileRequests.cancel();
    this.securityRequests.cancel();
    this.cancelAvatar();
    if (this.session) rememberSignedIn(false);
    this.session = null;
    this.profile = null;
    this.sessions = [];
    this.accounts = [];
    this.appeals = [];
    this.appealOpen = false;
    this.mode = "signIn";
    this.phase = "ready";
  }
  private nextPath() {
    const value = new URLSearchParams(location.search).get("next") || "";
    return value.startsWith("/") && !value.startsWith("//") ? value : "/account";
  }
  private date(value: unknown) {
    return formatDate(document.documentElement.lang, typeof value === "number" ? value : String(value || ""), { time: true }) || "—";
  }

  private async request(url: string, init: RequestInit = {}) {
    if (!this.isConnected) throw new DOMException("Page closed", "AbortError");
    const headers = new Headers({ accept: "application/json" });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
    const signal = init.signal ? AbortSignal.any([this.lifetime.signal, init.signal]) : this.lifetime.signal;
    // A plain read AccountDocument.astro already started at document start.
    const early = (init.method ?? "GET") === "GET" && init.body === undefined && init.headers === undefined
      ? takeEarlyRead(url) : null;
    const adopted = early ? await readEarlyJson<Value | null>(early, signal) : undefined;
    if (adopted !== undefined) {
      signal.throwIfAborted();
      return adopted ?? {};
    }
    const data = await fetchJson<Value | null>(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers,
      signal,
    });
    signal.throwIfAborted();
    return data ?? {};
  }

  private captchaHeaders(): Record<string, string> {
    return this.captchaToken ? { "x-captcha-response": this.captchaToken } : {};
  }
  private async action(
    work: () => Promise<unknown>,
    success?: string,
    refresh?: () => Promise<unknown>,
  ): Promise<Value | null> {
    if (this.busy) return null;
    this.busy = true;
    this.clearMessages();
    try {
      const result = await work();
      if (success) this.message = success;
      if (refresh) await refresh();
      return result && typeof result === "object" && !Array.isArray(result) ? (result as Value) : {};
    } catch (error) {
      if (this.isConnected) {
        if (error instanceof JsonResponseError && error.status === 401) this.clearSession();
        this.error = error instanceof Error ? error.message : String(error);
      }
      return null;
    } finally {
      this.busy = false;
      this.resetTurnstile();
    }
  }

  private async load() {
    const signal = this.loadRequests.begin();
    this.profileRequests.cancel();
    this.securityRequests.cancel();
    const current = () => this.isConnected && this.loadRequests.current(signal);
    this.phase = "loading";
    this.error = "";
    try {
      // Configuration and session are independent reads; for a browser that
      // was signed in last time, the signed-in reads start beside them too.
      // Every read carries the same cookie, and each result is checked
      // against the session's user before it is shown.
      const configRead = this.request("/api/v1/account/config", { signal });
      const sessionRead = this.request("/api/auth/get-session", { signal });
      const speculative = signedInHint() ? this.signedInReads(signal) : undefined;
      sessionRead.catch(() => undefined);
      const config = await configRead;
      if (!current()) return;
      this.config = config;
      if (config.available === false) {
        this.clearSession();
        return;
      }
      const session = await sessionRead;
      if (!current()) return;
      if ((session.user as Value | undefined)?.id !== this.user()?.id) this.cancelAvatar();
      this.session = session.user ? session : null;
      rememberSignedIn(Boolean(this.session));
      this.profile = null;
      this.sessions = [];
      this.accounts = [];
      this.appeals = [];
      if (this.session) await Promise.all([this.loadProfile(signal, speculative), this.loadSecurity(signal, speculative)]);
      if (current()) this.phase = "ready";
    } catch (error) {
      if (!current()) return;
      if (error instanceof JsonResponseError && error.status === 401) this.clearSession();
      else this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** Reads a signed-in account page needs, started before the session confirms it. */
  private signedInReads(signal: AbortSignal) {
    const settle = (url: string) => {
      const read = this.request(url, { signal });
      read.catch(() => undefined);
      return read;
    };
    return {
      profile: settle("/api/v1/account/profile"),
      appeals: settle("/api/v1/community/appeals"),
      sessions: settle("/api/auth/list-sessions"),
      accounts: settle("/api/auth/list-accounts"),
    };
  }

  private async loadProfile(signal?: AbortSignal, speculative?: ReturnType<AccountWorkspace["signedInReads"]>): Promise<void> {
    const ownSignal = this.profileRequests.begin();
    const userId = this.user()?.id;
    const init: RequestInit = { signal: signal ? AbortSignal.any([signal, ownSignal]) : ownSignal };
    const [value, appeals] = await Promise.all([
      speculative?.profile ?? this.request("/api/v1/account/profile", init),
      this.user()?.emailVerified
        ? speculative?.appeals ?? this.request("/api/v1/community/appeals", init)
        : Promise.resolve<Value>({}),
    ]);
    if (!this.isConnected || !this.profileRequests.current(ownSignal) || userId !== this.user()?.id) return;
    // A speculative read answered for whoever the cookie named; keep it only
    // when that is the confirmed session's user.
    const seed = (value.profile as Value | undefined)?.avatarSeed;
    if (speculative && typeof seed === "string" && seed !== userId) return this.loadProfile(signal);
    this.profile = (value.profile as Value) || null;
    void refreshContentAccess();
    this.appeals = Array.isArray(appeals.appeals) ? (appeals.appeals as Value[]) : [];
  }

  private async loadSecurity(signal?: AbortSignal, speculative?: ReturnType<AccountWorkspace["signedInReads"]>) {
    const ownSignal = this.securityRequests.begin();
    const userId = this.user()?.id;
    const init: RequestInit = { signal: signal ? AbortSignal.any([signal, ownSignal]) : ownSignal };
    const optional = (url: string) => this.request(url, init).catch((): Value => ({}));
    const [sessions, accounts, games, relationships, apiTokens] = await Promise.all([
      speculative?.sessions ?? this.request("/api/auth/list-sessions", init),
      speculative?.accounts ?? this.request("/api/auth/list-accounts", init),
      optional("/api/v1/account/game-accounts"),
      optional("/api/v1/community/me/relationships"),
      this.request("/api/v1/account/api-tokens", { ...init, headers: this.ownerHeaders() }).catch((): Value => ({})),
    ]);
    if (!this.isConnected || !this.securityRequests.current(ownSignal) || userId !== this.user()?.id) return;
    this.games = Array.isArray(games.accounts) ? (games.accounts as Value[]) : [];
    this.apiTokens = Array.isArray(apiTokens.tokens) ? (apiTokens.tokens as Value[]) : [];
    this.apiTokenEvents = Array.isArray(apiTokens.events) ? (apiTokens.events as Value[]) : [];
    this.relationships = Array.isArray(relationships.relationships) ? (relationships.relationships as Value[]) : [];
    this.sessions = Array.isArray(sessions)
      ? (sessions as unknown as Value[])
      : Array.isArray(sessions.sessions)
        ? (sessions.sessions as Value[])
        : Array.isArray(sessions.data)
          ? (sessions.data as Value[])
          : [];
    this.accounts = Array.isArray(accounts)
      ? (accounts as unknown as Value[])
      : Array.isArray(accounts.accounts)
        ? (accounts.accounts as Value[])
        : Array.isArray(accounts.data)
          ? (accounts.data as Value[])
          : [];
  }

  private permission(name: "write" | "upload" | "deleteAvatar") {
    return (this.profile?.permissions as Value | undefined)?.[name] === true;
  }

  private async submitAuth(event: SubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    if (this.config.turnstileSiteKey && !this.captchaToken) {
      this.error = this.label("completeChallenge", "Complete the verification challenge.");
      return;
    }
    const result = await this.action(async () => {
      if (this.mode === "signUp") {
        await this.request("/api/v1/account/register", {
          method: "POST",
          headers: this.captchaHeaders(),
          body: JSON.stringify({ email }),
        });
        this.mode = "verifyEmail";
        return;
      }
      await this.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: this.captchaHeaders(),
        body: JSON.stringify({ email, password, rememberMe: true, callbackURL: this.nextPath() }),
      });
      if (this.nextPath() !== "/account") {
        location.assign(this.nextPath());
        return;
      }
      await this.load();
    });
    if (result || this.mode === "verifyEmail")
      this.message =
        this.mode === "verifyEmail"
          ? this.label("verificationSent", "Verification email sent.")
          : this.label("signedIn", "Signed in.");
  }

  private async requestPasswordReset(event: SubmitEvent) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget as HTMLFormElement).get("email") || "").trim();
    await this.action(
      () =>
        this.request("/api/auth/request-password-reset", {
          method: "POST",
          body: JSON.stringify({ email, redirectTo: "/account/reset-password" }),
        }),
      this.label("resetEmailSent", "Reset email sent."),
    );
  }

  private async resendVerification() {
    const input = this.querySelector<HTMLInputElement>('input[name="verification-email"]');
    const email = input?.value.trim() || "";
    await this.action(
      () =>
        this.request("/api/v1/account/register", {
          method: "POST",
          headers: this.captchaHeaders(),
          body: JSON.stringify({ email }),
        }),
      this.label("verificationSent", "Verification email sent."),
    );
  }

  private async social(provider: string) {
    const data = await this.action(() =>
      this.request("/api/auth/sign-in/social", {
        method: "POST",
        headers: this.captchaHeaders(),
        body: JSON.stringify({ provider, callbackURL: this.nextPath() }),
      }),
    );
    if (data?.url) location.assign(String(data.url));
  }

  private async signOut() {
    await this.action(
      async () => {
        await this.request("/api/auth/sign-out", { method: "POST", body: "{}" });
        this.clearSession();
      },
      this.label("signedOut", "Signed out."),
    );
  }

  private async updateProfile(event: SubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const result = await this.action(
      () =>
        this.request("/api/v1/account/profile", {
          method: "PATCH",
          body: JSON.stringify({
            displayName: String(data.get("displayName") || "").trim(),
            handle: String(data.get("handle") || "").trim() || null,
            bio: String(data.get("bio") || "").trim() || null,
            version: this.profile?.version,
          }),
        }),
      this.label("profileUpdated", "Profile updated."),
    );
    if (result?.profile) this.profile = result.profile as Value;
  }

  private selectAvatar(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.clearMessages();
    if (!AVATAR_TYPES.has(file.type)) {
      this.error = this.label("avatarUnsupported", "Choose a JPEG, PNG, or WebP image.");
      return;
    }
    if (!file.size || file.size > AVATAR_MAX_BYTES) {
      this.error = this.label("avatarTooLarge", "The avatar must be 2 MB or smaller.");
      return;
    }
    if (this.avatarPreview) URL.revokeObjectURL(this.avatarPreview);
    this.avatarFile = file;
    this.avatarPreview = URL.createObjectURL(file);
  }

  private cancelAvatar() {
    if (this.avatarPreview) URL.revokeObjectURL(this.avatarPreview);
    this.avatarFile = null;
    this.avatarPreview = "";
  }
  private async uploadAvatar() {
    const file = this.avatarFile;
    if (!file) return;
    await this.action(
      () =>
        this.request("/api/v1/account/avatar", {
          method: "PUT",
          headers: { "content-type": file.type, "x-file-name": encodeURIComponent(file.name) },
          body: file,
        }),
      this.label("avatarPending", "Your avatar is being reviewed."),
      async () => {
        this.cancelAvatar();
        await this.loadProfile();
      },
    );
  }
  private async deleteAvatar() {
    await this.action(
      () => this.request("/api/v1/account/avatar", { method: "DELETE" }),
      this.label("avatarDeleted", "Avatar deleted."),
      () => this.loadProfile(),
    );
  }

  private async submitAppeal(
    entityKind: "profile-name" | "attachment" = "profile-name",
    entityId = String(this.user()?.id || ""),
  ) {
    const statement = this.querySelector<HTMLTextAreaElement>('textarea[name="statement"]')?.value.trim() || "";
    const result = await this.action(
      () =>
        this.request("/api/v1/community/appeals", {
          method: "POST",
          body: JSON.stringify({
            entityKind,
            entityId,
            statement,
            ...(entityKind === "profile-name" ? { entityRevision: this.profile?.displayNameRevision } : {}),
          }),
        }),
      this.label("appealSubmitted", "Appeal submitted."),
      () => this.loadProfile(),
    );
    if (result) this.appealOpen = false;
  }

  private async changeEmail(event: SubmitEvent) {
    event.preventDefault();
    const newEmail = String(new FormData(event.currentTarget as HTMLFormElement).get("newEmail") || "").trim();
    await this.action(
      () =>
        this.request("/api/auth/change-email", {
          method: "POST",
          body: JSON.stringify({ newEmail, callbackURL: "/account?verified=1" }),
        }),
      this.label("emailChangeSent", "Check your new inbox."),
    );
  }
  private async changePassword(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") || "");
    const newPassword = String(data.get("newPassword") || "");
    const confirm = String(data.get("confirmPassword") || "");
    if (newPassword !== confirm) {
      this.error = this.label("passwordMismatch", "The passwords do not match.");
      return;
    }
    await this.action(
      () =>
        this.request("/api/auth/change-password", {
          method: "POST",
          body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
        }),
      this.label("passwordChanged", "Password changed."),
      async () => {
        form.reset();
        await this.loadSecurity();
      },
    );
  }
  private ownerHeaders() {
    return { "X-Haneoka-Expected-User": String(this.user()?.id ?? "") };
  }
  private async createApiToken(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const fields = new FormData(form);
    const data = await this.action(() =>
      this.request("/api/v1/account/api-tokens", {
        method: "POST",
        headers: this.ownerHeaders(),
        body: JSON.stringify({
          name: String(fields.get("name")),
          days: Number(fields.get("days")),
          scopes: fields.getAll("scopes").map(String),
        }),
      }),
    );
    if (!data) return;
    this.apiTokens = data.tokens as Value[];
    this.apiTokenValue = String(data.token);
    form.reset();
  }
  private async revokeApiToken() {
    const id = this.apiTokenRevoking?.id;
    if (!id) return;
    const data = await this.action(
      () => this.request(`/api/v1/account/api-tokens/${id}`, { method: "DELETE", headers: this.ownerHeaders() }),
      this.label("apiTokenRevoked", "Token revoked."),
    );
    if (data) this.apiTokens = data.tokens as Value[];
    this.apiTokenRevoking = null;
  }
  private async copyApiToken() {
    await navigator.clipboard.writeText(this.apiTokenValue);
    snackbar(this.label("apiTokenCopied", "Token copied."));
  }
  private apiScopeLabel(scope: string) {
    return this.label(`apiScope_${scope.replace(":", "_")}`, scope);
  }
  private renderApiTokens() {
    const revoking = this.apiTokenRevoking;
    return html`
      <article class="surface account-block">
        ${this.heading("key", this.label("apiTokens", "API tokens"), this.apiTokens.length)}
        <div class="provider-list">
          ${this.apiTokens.map(
            (token) => html`
              <div class="provider-row">
                <span class="provider-mark">${icon("key", 20)}</span>
                <span>
                  <strong>${String(token.name)}</strong>
                  <small>
                    ${(token.scopes as string[]).map((scope) => this.apiScopeLabel(scope)).join(" · ")}
                    <br />
                    ${this.label("apiTokenExpires", "Expires")} ${this.date(token.expiresAt)}
                    · ${this.label("apiTokenUsed", "Last used")}
                    ${token.lastUsedAt ? this.date(token.lastUsedAt) : this.label("apiTokenNeverUsed", "Never")}
                  </small>
                </span>
                <button class="button button--text" ?disabled=${this.busy} @click=${() => (this.apiTokenRevoking = token)}>
                  ${this.label("revoke", "Revoke")}
                </button>
              </div>
            `,
          )}
        </div>
        ${
          this.apiTokenEvents.length
            ? html`
                <div class="provider-list" aria-label=${this.label("apiTokenEvents", "Recent changes")}>
                  ${this.apiTokenEvents.map(
                    (entry) => html`
                      <div class="provider-row">
                        <span class="provider-mark">${icon("history", 20)}</span>
                        <span>
                          <strong>${String(entry.tokenName)}</strong>
                          <small>
                            ${this.label("apiTokenEventChanged", "Box entries changed")}: ${Number(entry.changed).toLocaleString(preferredLocale())}
                            · ${String(entry.server).toUpperCase()} · ${this.date(entry.createdAt)}
                          </small>
                        </span>
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing
        }
        <form class="account-inline-form" @submit=${this.createApiToken}>
          <label>
            <span>${this.label("apiTokenName", "Token name")}</span>
            <span class="field"><input name="name" maxlength="64" required /></span>
          </label>
          <label>
            <span>${this.label("apiTokenLifetime", "Valid for")}</span>
            <span class="field">
              <select name="days">
                ${[30, 90, 365].map(
                  (days) => html`<option value=${days} ?selected=${days === 90}>${this.label(`apiTokenDays${days}`, `${days} days`)}</option>`,
                )}
              </select>
            </span>
          </label>
          <fieldset class="account-api-scopes">
            <legend>${this.label("apiTokenScopes", "Permissions")}</legend>
            ${API_SCOPES.map(
              (scope) => html`
                <label class="account-api-scope">
                  <input type="checkbox" name="scopes" value=${scope} ?checked=${scope === "team:read"} />
                  <span>${this.apiScopeLabel(scope)}</span>
                </label>
              `,
            )}
          </fieldset>
          <button class="button" ?disabled=${this.busy}>${this.label("apiTokenCreate", "Create token")}</button>
        </form>
      </article>
      ${
        this.apiTokenValue
          ? html`
              <dialog class="dialog" ${modal(() => (this.apiTokenValue = ""))}>
                <div class="dialog__surface">
                  <header class="dialog__header"><h2>${this.label("apiTokenShown", "Copy this token now")}</h2></header>
                  <div class="dialog__body"><code class="account-api-token">${this.apiTokenValue}</code></div>
                  <footer class="dialog__actions">
                    <button class="button button--text" type="button" @click=${() => (this.apiTokenValue = "")}>${this.label("close", "Close")}</button>
                    <button class="button" type="button" @click=${this.copyApiToken}>${this.label("apiTokenCopy", "Copy")}</button>
                  </footer>
                </div>
              </dialog>
            `
          : nothing
      }
      ${
        revoking
          ? html`
              <dialog class="dialog" ${modal(() => (this.apiTokenRevoking = null))}>
                <div class="dialog__surface">
                  <header class="dialog__header"><h2>${this.label("apiTokenRevokeTitle", "Revoke this token?")}</h2></header>
                  <div class="dialog__body">${String(revoking.name)}</div>
                  <footer class="dialog__actions">
                    <button class="button button--text" type="button" @click=${() => (this.apiTokenRevoking = null)}>${this.label("close", "Close")}</button>
                    <button class="button button--danger" type="button" ?disabled=${this.busy} @click=${this.revokeApiToken}>${this.label("revoke", "Revoke")}</button>
                  </footer>
                </div>
              </dialog>
            `
          : nothing
      }
    `;
  }
  private async revokeSession(token: unknown) {
    await this.action(
      () => this.request("/api/auth/revoke-session", { method: "POST", body: JSON.stringify({ token }) }),
      this.label("sessionRevoked", "Session revoked."),
      () => this.loadSecurity(),
    );
  }
  private async revokeOthers() {
    await this.action(
      () => this.request("/api/auth/revoke-other-sessions", { method: "POST", body: "{}" }),
      this.label("sessionRevoked", "Sessions revoked."),
      () => this.loadSecurity(),
    );
  }
  private async revokeAll() {
    await this.action(
      () => this.request("/api/auth/revoke-sessions", { method: "POST", body: "{}" }),
      this.label("sessionRevoked", "Sessions revoked."),
      () => this.load(),
    );
  }
  private async linkAccount(provider: string) {
    const data = await this.action(() =>
      this.request("/api/auth/link-social", {
        method: "POST",
        body: JSON.stringify({ provider, callbackURL: "/account?linked=1" }),
      }),
    );
    if (data?.url) location.assign(String(data.url));
  }
  private async unlinkAccount(account: Value) {
    await this.action(
      () =>
        this.request("/api/auth/unlink-account", {
          method: "POST",
          body: JSON.stringify({ providerId: account.providerId, accountId: account.accountId }),
        }),
      this.label("accountUnlinked", "Account unlinked."),
      () => this.loadSecurity(),
    );
  }
  private async deleteAccount(event: SubmitEvent) {
    event.preventDefault();
    const confirmation = String(new FormData(event.currentTarget as HTMLFormElement).get("confirmation") || "");
    const result = await this.action(
      () => this.request("/api/v1/account/profile", { method: "DELETE", body: JSON.stringify({ confirmation }) }),
      this.label("accountDeleted", "Account deleted."),
    );
    if (result) {
      this.clearSession();
      history.replaceState(history.state, "", "/account?deleted=1");
    }
  }
  private async copyUid() {
    const uid = this.profile?.publicUid;
    if (uid == null) return;
    try {
      await navigator.clipboard.writeText(String(uid));
      this.message = this.label("uidCopied", "UID copied.");
    } catch {
      this.error = this.label("uidCopyFailed", "The UID could not be copied.");
    }
  }

  private resetTurnstile() {
    const widget = (window as unknown as { turnstile?: { reset: (id: string | number) => void } }).turnstile;
    if (widget && this.turnstileId != null) widget.reset(this.turnstileId);
    this.captchaToken = "";
  }
  private removeTurnstile() {
    const widget = (window as unknown as { turnstile?: { remove: (id: string | number) => void } }).turnstile;
    if (widget && this.turnstileId != null) widget.remove(this.turnstileId);
    this.turnstileId = null;
    this.turnstileContainer = null;
    this.captchaToken = "";
  }
  private retryTurnstile() {
    const container = this.querySelector<HTMLElement>("[data-turnstile]");
    if (container) delete container.dataset.mounted;
    this.removeTurnstile();
    this.clearMessages();
    this.captchaFailed = false;
    void this.mountTurnstile();
  }
  private async mountTurnstile() {
    const sitekey = String(this.config.turnstileSiteKey || "");
    const container = this.querySelector<HTMLElement>("[data-turnstile]");
    const action = this.mode === "signIn" ? "account_sign_in" : "account_register";
    if (this.turnstileContainer && (container !== this.turnstileContainer || container?.dataset.action !== action))
      this.removeTurnstile();
    if (!sitekey || !container || (container.dataset.mounted && container.dataset.action === action)) return;
    container.dataset.mounted = "true";
    container.dataset.action = action;
    this.captchaFailed = false;
    type TurnstileApi = { render: (target: HTMLElement, options: Value) => string | number };
    try {
      const api = await new Promise<TurnstileApi>((resolve, reject) => {
        const existing = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
        if (existing) {
          resolve(existing);
          return;
        }
        const script = document.createElement("script");
        const finish = () => {
          clearTimeout(timer);
          script.onload = null;
          script.onerror = null;
        };
        const fail = () => {
          finish();
          script.remove();
          reject(new Error(this.label("challengeUnavailable", "Verification could not be loaded. Try again.")));
        };
        const timer = setTimeout(fail, 15_000);
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.onerror = fail;
        script.onload = () => {
          const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
          if (!api) {
            fail();
            return;
          }
          finish();
          resolve(api);
        };
        document.head.append(script);
      });
      if (!this.isConnected || !container.isConnected || container.dataset.action !== action) return;
      this.turnstileContainer = container;
      this.turnstileId = api.render(container, {
        sitekey,
        action,
        size: container.clientWidth < 300 ? "compact" : "flexible",
        callback: (token: string) => {
          this.captchaToken = token;
          this.captchaFailed = false;
        },
        "expired-callback": () => {
          this.captchaToken = "";
        },
        "error-callback": () => {
          this.captchaToken = "";
          this.captchaFailed = true;
          this.error = this.label("challengeUnavailable", "Verification could not be loaded. Try again.");
        },
      });
    } catch (error) {
      if (!this.isConnected || !container.isConnected || container.dataset.action !== action) return;
      this.captchaFailed = true;
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private renderChallenge() {
    return html`
      <div data-turnstile></div>
      ${
        this.captchaFailed
          ? html`
              <button class="button button--text" type="button" @click=${this.retryTurnstile}>
                ${this.label("retry", "Retry")}
              </button>
            `
          : nothing
      }
    `;
  }

  render() {
    if (this.phase === "loading")
      return html`
        ${loadingState(this.label("loading", "Loading"))}
      `;
    return html`
      <section class="page page--compact account-page">
${
          this.phase === "error"
            ? html`
                <section class="account-state surface surface--outlined">
                  <h2>${this.label("loadFailed", "Account information could not be loaded")}</h2>
                  <button class="button" @click=${this.load}>${this.label("retry", "Retry")}</button>
                </section>
              `
            : this.session
              ? this.renderAccount()
              : this.renderAuth()
        }
      </section>
    `;
  }

  private renderAuth() {
    const providers = Array.isArray(this.config.providers) ? this.config.providers.map(String) : [];
    if (this.config.available === false)
      return html`
        <section class="account-state surface surface--outlined">
          ${icon("cloud_off", 36)}
          <h2>${this.label("unavailableTitle", "Accounts are unavailable")}</h2>
          <p>${this.label("unavailableBody", "The account service is temporarily unavailable.")}</p>
          <button class="button" @click=${this.load}>${this.label("retry", "Retry")}</button>
        </section>
      `;
    if (this.mode === "forgotPassword")
      return html`
        <section class="auth-layout">
          <article class="auth-panel surface surface--outlined">
            <header class="auth-panel__heading">
              <span>${icon("key", 24)}</span>
              <h2>${this.label("forgotPasswordTitle", "Reset your password")}</h2>
            </header>
            <form class="form-stack account-auth-form" @submit=${this.requestPasswordReset}>
              <p>${this.label("forgotPasswordBody", "Enter your email address and we'll send you a reset link.")}</p>
              <label>
                <span>${this.label("email", "Email")}</span>
                <span class="field"><input name="email" type="email" autocomplete="email" required /></span>
              </label>
              <button class="button" ?disabled=${this.busy}>${this.label("sendResetLink", "Send reset link")}</button>
              <button class="button button--text" type="button" @click=${() => (this.mode = "signIn")}>
                ${this.label("backToSignIn", "Back to sign in")}
              </button>
            </form>
          </article>
        </section>
      `;
    if (this.mode === "verifyEmail")
      return html`
        <section class="auth-layout">
          <article class="verification-panel surface surface--outlined">
            ${icon("mark_email_read", 42)}
            <h2>${this.label("verifyEmailTitle", "Check your email")}</h2>
            <p>${this.label("verifyEmailBody", "Open the latest setup email to finish registration.")}</p>
            <label>
              <span>${this.label("email", "Email")}</span>
              <span class="field"><input name="verification-email" type="email" autocomplete="email" required /></span>
            </label>
            ${this.renderChallenge()}
            <button
              class="button"
              ?disabled=${this.busy || Boolean(this.config.turnstileSiteKey && !this.captchaToken)}
              @click=${this.resendVerification}
            >
              ${this.label("resendVerification", "Resend setup email")}
            </button>
            <button class="button button--text" @click=${() => (this.mode = "signIn")}>
              ${this.label("backToSignIn", "Back to sign in")}
            </button>
          </article>
        </section>
      `;
    return html`
      <section class="auth-layout">
        <article class="auth-panel surface surface--outlined">
          <header class="auth-panel__heading">
            <span>${this.mode === "signUp" ? icon("person_add", 24) : icon("lock_person", 24)}</span>
            <h2>
              ${this.mode === "signUp" ? this.label("signUp", "Create account") : this.label("signIn", "Sign in")}
            </h2>
          </header>
          <form class="form-stack account-auth-form" @submit=${this.submitAuth}>
            <div class="segmented auth-modes">
              <button type="button" aria-pressed=${this.mode === "signIn"} @click=${() => (this.mode = "signIn")}>
                ${icon("login", 18)}${this.label("signIn", "Sign in")}
              </button>
              ${
                this.config.emailSignUpEnabled !== false
                  ? html`
                      <button
                        type="button"
                        aria-pressed=${this.mode === "signUp"}
                        @click=${() => (this.mode = "signUp")}
                      >
                        ${icon("person_add", 18)}${this.label("signUp", "Create account")}
                      </button>
                    `
                  : nothing
              }
            </div>
            <label>
              <span>${this.label("email", "Email")}</span>
              <span class="field">
                <input name="email" type="email" autocomplete="email" maxlength="254" required />
              </span>
              ${
                this.mode === "signUp"
                  ? html`
                      <small>${this.label("emailOnlySignupHint", "We'll email a secure setup link.")}</small>
                    `
                  : nothing
              }
            </label>
            ${
              this.mode === "signIn"
                ? html`
                    <label>
                      <span>${this.label("password", "Password")}</span>
                      <span class="field">
                        <input
                          name="password"
                          type="password"
                          autocomplete="current-password"
                          minlength="12"
                          maxlength="128"
                          required
                        />
                      </span>
                    </label>
                  `
                : nothing
            }
            ${this.renderChallenge()}
            <button class="button" ?disabled=${this.busy}>
              ${this.mode === "signUp" ? icon("mark_email_read", 18) : icon("login", 18)}${this.busy ? this.label("working", "Working…") : this.mode === "signUp" ? this.label("signUp", "Create account") : this.label("signIn", "Sign in")}
            </button>
            ${
              this.mode === "signIn" && this.config.emailSignUpEnabled !== false
                ? html`
                    <button
                      class="button button--outlined"
                      type="button"
                      @click=${() => (this.mode = "forgotPassword")}
                    >
                      ${this.label("forgotPassword", "Forgot password?")}
                    </button>
                  `
                : nothing
            }
          </form>
          ${
            providers.length
              ? html`
                  <div class="account-divider"><span>${this.label("orContinueWith", "Or continue with")}</span></div>
                  <div class="oauth-grid">
                    ${providers.map(
                      (provider) => html`
                        <button
                          class="button button--tonal"
                          ?disabled=${this.busy}
                          @click=${() => this.social(provider)}
                        >
                          ${oauthIcon(provider)}${provider}
                        </button>
                      `,
                    )}
                  </div>
                `
              : nothing
          }
          <nav class="account-legal md-body-small">
            <a href="/privacy">${this.label("privacy", "Privacy Policy")}</a>
            <a href="/terms">${this.label("terms", "Terms of Use")}</a>
          </nav>
        </article>
      </section>
    `;
  }

  private sectionButton(id: Section, iconName: string, label: string, count = 0) {
    return html`
      <button
        role="tab"
        aria-selected=${this.section === id}
        class=${this.section === id ? "selected" : ""}
        @click=${() => (this.section = id)}
      >
        ${icon(iconName)}
        <span>${label}</span>
        ${count ? html`<small>${count}</small>` : nothing}
      </button>
    `;
  }
  private heading(iconName: string, label: string, count?: number) {
    return html`
      <h3 class="detail-section-title">
        <span class="detail-section-title__icon" aria-hidden="true">${icon(iconName, 18)}</span>
        <span class="detail-section-title__label">${label}</span>
        ${count ? html`<span class="detail-section-title__count">${count}</span>` : nothing}
      </h3>
    `;
  }
  private avatarOf(image: unknown, name: string) {
    return html`
      <span class="account-avatar" aria-hidden="true">
        ${image ? html`<img src=${String(image)} alt="" width="40" height="40" loading="lazy" />` : name.slice(0, 1)}
      </span>
    `;
  }
  private renderSummary() {
    const user = this.user() || {};
    const profile = this.profile || {};
    const identity = String(profile.displayName || profile.accountName || user.name || user.email || "?");
    const uid = profile.publicUid;
    const role = String(profile.role || "member");
    const status = String(profile.profileStatus || "active");
    const chip = (glyph: string, label: string) => html`<span class="chip chip--static">${icon(glyph, 18)}<span class="chip__label">${label}</span></span>`;
    return html`
      <section class="surface account-summary">
        <div class="account-summary__identity">
          ${this.avatarOf(this.avatarPreview || profile.avatarUrl, identity)}
          <div>
            <h2 class="md-title-large">${identity}</h2>
            ${profile.handle ? html`<p class="md-body-medium">@${String(profile.handle)}</p>` : nothing}
            <p class="md-body-small">${String(user.email || "")}</p>
          </div>
        </div>
        <div class="chip-set">
          ${chip("person", this.label(`role${role[0]?.toUpperCase()}${role.slice(1)}`, role))}
          ${chip(user.emailVerified ? "check_circle" : "alternate_email", user.emailVerified ? this.label("verified", "Verified") : this.label("unverified", "Not verified"))}
          ${status === "active" ? nothing : chip("verified_user", this.label(`status${status[0]?.toUpperCase()}${status.slice(1)}`, status))}
        </div>
        ${specList([
          {
            label: this.label("publicUid", "UID"),
            value: html`<button class="button button--text account-uid" ?disabled=${uid == null} title=${this.label("copyUid", "Copy UID")} @click=${this.copyUid}>${uid ?? "—"}${icon("content_copy", 16)}</button>`,
          },
          profile.createdAt ? { label: this.label("joined", "Joined"), value: formatDate(preferredLocale(), String(profile.createdAt)) } : null,
        ])}
        <div class="account-summary__actions">
          ${
            Number.isSafeInteger(uid)
              ? html`
                  <a class="button button--tonal" href=${`/community/users/${uid}`}>
                    ${icon("open_in_new", 18)}${this.label("publicProfile", "Public profile")}
                  </a>
                `
              : nothing
          }
          ${
            hasUserCapability(role, "community.moderate")
              ? html`
                  <a class="icon-button icon-button--tonal" href=${role === "moderator" ? "/admin/appeals" : "/admin"} title=${this.label("adminConsole", "Admin console")} aria-label=${this.label("adminConsole", "Admin console")}>
                    ${icon("admin_panel_settings", 22)}
                  </a>
                `
              : nothing
          }
          <button class="icon-button" ?disabled=${this.busy} title=${this.label("signOut", "Sign out")} aria-label=${this.label("signOut", "Sign out")} @click=${this.signOut}>
            ${icon("logout", 22)}
          </button>
        </div>
      </section>
    `;
  }
  private renderAccount() {
    const restrictions = Array.isArray(this.profile?.restrictions) ? this.profile.restrictions.length : 0;
    const sections: Record<Section, () => unknown> = {
      profile: () => this.renderProfile(),
      games: () => this.renderGames(),
      security: () => this.renderSecurity(),
      sessions: () => this.renderSessions(),
      relationships: () => this.renderRelationships(),
      moderation: () => this.renderModeration(),
      management: () => this.renderManagement(),
    };
    return html`
      <div class="account-workspace">
        <aside class="account-aside">
          ${this.renderSummary()}
          <nav class="account-navigation" role="tablist">
            ${this.sectionButton("profile", "person", this.label("profile", "Profile"))}
            ${this.sectionButton("games", "sports_esports", this.label("gameAccounts", "Game accounts"), this.games.length)}
            ${this.sectionButton("security", "verified_user", this.label("security", "Sign-in & security"))}
            ${this.sectionButton("sessions", "devices", this.label("sessions", "Sessions"), this.sessions.length)}
            ${this.sectionButton("relationships", "block", this.label("relationships", "Blocks & mutes"), this.relationships.length)}
            ${this.sectionButton("moderation", "policy", this.label("moderation", "Restrictions & appeals"), restrictions + this.appeals.length)}
            ${this.sectionButton("management", "settings", this.label("accountManagement", "Account management"))}
          </nav>
        </aside>
        <main class="account-content">${sections[this.section]()}</main>
      </div>
    `;
  }

  private renderGames() {
    const locale = preferredLocale();
    const number = (value: unknown) => new Intl.NumberFormat(locale).format(Number(value));
    const removing = this.removing;
    return html`
      <section class="surface account-block">
        ${this.heading("sports_esports", this.label("gameAccounts", "Game accounts"), this.games.length)}
        ${
          this.games.length
            ? html`
                <ul class="detail-object-list" role="list">
                  ${this.games.map((account) => {
                    const summary = (account.summary || {}) as Value;
                    const region = String(account.region);
                    return html`
                      <li class="account-object">
                        <a class="detail-object" href=${`/${locale}/player-profile/?region=${gameAccountRegion(region, locale, String(account.playerUid))}&profileId=${account.playerUid}`}>
                          <span class="account-avatar" aria-hidden="true">${icon("sports_esports", 20)}</span>
                          <span>
                            ${String(account.displayName || account.playerUid)}
                            <small class="md-body-small">
                              ${[
                                GAME_REGION_NAMES[gameAccountRegion(region, locale, String(account.playerUid))],
                                String(account.playerUid),
                                typeof summary.rank === "number" ? clientText(locale, "account.page.gameRank", "Rank {value}", { value: number(summary.rank) }) : "",
                                typeof summary.rating === "number" ? clientText(locale, "account.page.gameRating", "Rating {value}", { value: number(summary.rating) }) : "",
                              ].filter(Boolean).join(" · ")}
                            </small>
                          </span>
                        </a>
                        <span class="chip chip--static"><span class="chip__label">${account.visibility === "public" ? this.label("visibilityPublic", "Public") : this.label("visibilityPrivate", "Private")}</span></span>
                        <button class="icon-button" type="button" title=${this.label("remove", "Remove")} aria-label=${this.label("remove", "Remove")} ?disabled=${this.busy} @click=${() => (this.removing = account)}>
                          ${icon("delete", 20)}
                        </button>
                      </li>
                    `;
                  })}
                </ul>
              `
            : html`<a class="button button--tonal" href=${`/${locale}/player-profile/`}>${icon("person_search", 18)}${this.label("findPlayer", "Find a player")}</a>`
        }
      </section>
      ${
        removing
          ? html`
              <dialog class="dialog" ${modal(() => (this.removing = null))}>
                <div class="dialog__surface">
                  <header class="dialog__header"><h2>${this.label("removeGameAccount", "Remove this game account?")}</h2></header>
                  <div class="dialog__body">${String(removing.displayName || removing.playerUid)}</div>
                  <footer class="dialog__actions">
                    <button class="button button--text" type="button" @click=${() => (this.removing = null)}>${this.label("close", "Close")}</button>
                    <button class="button button--danger" type="button" ?disabled=${this.busy} @click=${this.removeGame}>${this.label("remove", "Remove")}</button>
                  </footer>
                </div>
              </dialog>
            `
          : nothing
      }
    `;
  }
  private async removeGame() {
    const account = this.removing;
    if (!account) return;
    await this.action(
      async () => {
        const data = await this.request(`/api/v1/account/game-accounts/${account.region}/${account.playerUid}`, { method: "DELETE" });
        this.games = Array.isArray(data.accounts) ? (data.accounts as Value[]) : [];
      },
      this.label("gameAccountRemoved", "Game account removed."),
    );
    this.removing = null;
  }
  private async setRelationship(row: Value) {
    await this.action(
      () =>
        this.request(`/api/v1/community/users/${row.uid}/${row.kind}`, {
          method: "PUT",
          body: JSON.stringify({ active: false }),
        }),
      undefined,
      () => this.loadSecurity(),
    );
  }
  private renderRelationships() {
    const list = (kind: string, glyph: string, title: string, action: string) => {
      const rows = this.relationships.filter((row) => row.kind === kind);
      return html`
        <section class="surface account-block">
          ${this.heading(glyph, title, rows.length)}
          ${
            rows.length
              ? html`
                  <ul class="detail-object-list" role="list">
                    ${rows.map((row) => {
                      const name = String(row.name || row.uid);
                      return html`
                        <li class="account-object">
                          <a class="detail-object" href=${`/community/users/${row.uid}`}>
                            ${this.avatarOf(row.avatarUrl, name)}
                            <span>${name}<small class="md-body-small">${row.handle ? `@${row.handle} · ` : ""}${this.date(row.createdAt)}</small></span>
                          </a>
                          <button class="button button--text" type="button" ?disabled=${this.busy} @click=${() => this.setRelationship(row)}>${action}</button>
                        </li>
                      `;
                    })}
                  </ul>
                `
              : html`<p class="md-body-medium account-empty">${this.label("listEmpty", "None")}</p>`
          }
        </section>
      `;
    };
    return html`
      ${list("block", "block", this.label("blockedUsers", "Blocked users"), this.label("unblockUser", "Unblock"))}
      ${list("mute", "volume_off", this.label("mutedUsers", "Muted users"), this.label("unmute", "Unmute"))}
    `;
  }
  private renderModeration() {
    const restrictions = (Array.isArray(this.profile?.restrictions) ? this.profile.restrictions : []) as Value[];
    const kinds: Record<string, string> = {
      write: this.label("restrictionWrite", "Posting"),
      upload: this.label("restrictionUpload", "Uploads"),
      sign_in: this.label("restrictionSignIn", "Sign-in"),
    };
    return html`
      <section class="surface account-block">
        ${this.heading("policy", this.label("restrictions", "Restrictions"), restrictions.length)}
        ${
          restrictions.length
            ? specList(
                restrictions.map((row) => ({
                  label: kinds[String(row.kind)] ?? String(row.kind),
                  value: row.expiresAt ? this.date(row.expiresAt) : this.label("restrictionPermanent", "Permanent"),
                })),
              )
            : html`<p class="md-body-medium account-empty">${this.label("listEmpty", "None")}</p>`
        }
      </section>
      <section class="surface account-block">
        ${this.heading("gavel", this.label("appealsTitle", "Your appeals"), this.appeals.length)}
        ${
          this.appeals.length
            ? specList(
                this.appeals.map((appeal) => ({
                  label: appeal.entityKind === "profile-name" ? this.label("displayName", "Display name") : appeal.entityKind === "attachment" ? this.label("avatar", "Avatar") : this.label("appeal", "Appeal"),
                  value: `${this.label(`appealStatus.${appeal.status}`, String(appeal.status))} · ${this.date(appeal.updatedAt)}`,
                })),
              )
            : html`<p class="md-body-medium account-empty">${this.label("listEmpty", "None")}</p>`
        }
      </section>
    `;
  }

  private renderProfile() {
    const p = this.profile || {};
    const u = this.user() || {};
    const avatar = this.avatarPreview || String(p.avatarUrl || "");
    const avatarReview = p.avatarReview as Value | undefined;
    return html`
      <section class="account-section">
        ${this.renderPreview(avatar)}
        ${
          !this.permission("write")
            ? html`
                <p class="profile-review-status">
                  ${this.label("profileRestricted", "Profile changes are restricted for this account.")}
                </p>
              `
            : nothing
        }
        <div class="account-ledger">
          <div class="account-setting-row account-setting-row--avatar">
            <span class="account-setting-row__label">${this.label("avatar", "Avatar")}</span>
            <div class="account-avatar-control">
              ${
                avatar
                  ? html`
                      <img class="account-avatar-preview" src=${avatar} alt="" />
                    `
                  : nothing
              }
              <label class="button button--tonal">
                ${icon("photo_library", 18)}${this.label("chooseAvatar", "Choose avatar")}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  ?disabled=${this.busy || !this.permission("upload")}
                  @change=${this.selectAvatar}
                />
              </label>
            </div>
            <div class="account-row-actions">
              ${
                this.avatarFile
                  ? html`
                      <button
                        class="button"
                        ?disabled=${this.busy || !this.permission("upload")}
                        @click=${this.uploadAvatar}
                      >
                        ${this.label("uploadAvatar", "Upload")}
                      </button>
                      <button class="button button--text" ?disabled=${this.busy} @click=${this.cancelAvatar}>
                        ${this.label("cancelAvatar", "Cancel")}
                      </button>
                    `
                  : nothing
              }${
                p.avatarUrl || avatarReview
                  ? html`
                      <button
                        class="button button--danger"
                        ?disabled=${this.busy || !this.permission("deleteAvatar")}
                        @click=${this.deleteAvatar}
                      >
                        ${this.label("deleteAvatar", "Delete avatar")}
                      </button>
                    `
                  : nothing
              }
            </div>
          </div>
          ${
            avatarReview && avatarReview.status !== "ready"
              ? html`
                  <div class="profile-review-status" role="status">
                    <span>
                      ${
                        avatarReview.moderationStatus === "block"
                          ? this.label("avatarBlocked", "The new avatar did not pass review.")
                          : this.label("avatarPending", "Your avatar is being reviewed.")
                      }
                    </span>
                    ${
                      avatarReview.moderationStatus === "block"
                        ? html`
                            <button class="button button--tonal" @click=${() => (this.appealOpen = !this.appealOpen)}>
                              ${this.label("appeal", "Appeal")}
                            </button>
                          `
                        : nothing
                    }
                  </div>
                `
              : nothing
          }
          <form
            class="account-profile-form"
            @submit=${this.updateProfile}
            @input=${(event: Event) => {
              const form = new FormData(event.currentTarget as HTMLFormElement);
              this.draft = { name: String(form.get("displayName")), handle: String(form.get("handle")), bio: String(form.get("bio")) };
            }}
          >
            <label class="account-setting-row">
              <span class="account-setting-row__label">${this.label("displayName", "Display name")}</span>
              <span class="field">
                <input
                  name="displayName"
                  .value=${String(p.candidateDisplayName || p.accountName || u.name || "")}
                  maxlength="160"
                  required
                />
              </span>
            </label>
            <label class="account-setting-row">
              <span class="account-setting-row__label">${this.label("handle", "Username")}</span>
              <span class="field"><input name="handle" .value=${String(p.handle || "")} maxlength="32" /></span>
            </label>
            <label class="account-setting-row account-setting-row--bio">
              <span class="account-setting-row__label">${this.label("bio", "Bio")}</span>
              <textarea class="text-area" name="bio" maxlength="500">${String(p.bio || "")}</textarea>
            </label>
            ${
              p.displayNameStatus === "pending"
                ? html`
                    <p class="profile-review-status">
                      ${this.label("profileNamePending", "The new public name is being reviewed.")}
                    </p>
                  `
                : nothing
            }${
              p.displayNameStatus === "block"
                ? html`
                    <div class="profile-review-status blocked">
                      <span>${this.label("profileNameBlocked", "The new public name did not pass review.")}</span>
                      <button
                        class="button button--tonal"
                        type="button"
                        @click=${() => (this.appealOpen = !this.appealOpen)}
                      >
                        ${this.label("appeal", "Appeal")}
                      </button>
                    </div>
                  `
                : nothing
            }
            <div class="account-profile-form__actions">
              <button class="button" ?disabled=${this.busy || !this.permission("write")}>
                ${this.label("saveProfile", "Save profile")}
              </button>
            </div>
          </form>
          ${
            this.appealOpen
              ? html`
                  <form
                    class="profile-appeal-form"
                    @submit=${(event: SubmitEvent) => {
                      event.preventDefault();
                      const target = String(
                        new FormData(event.currentTarget as HTMLFormElement).get("target") || "profile-name",
                      );
                      void this.submitAppeal(
                        target === "attachment" ? "attachment" : "profile-name",
                        target === "attachment" ? String(avatarReview?.id || "") : String(this.user()?.id || ""),
                      );
                    }}
                  >
                    ${
                      p.displayNameStatus === "block"
                        ? html`
                            <label class="check-row">
                              <input name="target" type="radio" value="profile-name" checked required />
                              ${this.label("displayName", "Display name")}
                            </label>
                          `
                        : nothing
                    }
                    ${
                      avatarReview?.moderationStatus === "block"
                        ? html`
                            <label class="check-row">
                              <input
                                name="target"
                                type="radio"
                                value="attachment"
                                ?checked=${p.displayNameStatus !== "block"}
                                required
                              />
                              ${this.label("avatar", "Avatar")}
                            </label>
                          `
                        : nothing
                    }
                    <textarea
                      class="text-area"
                      name="statement"
                      maxlength="2000"
                      required
                      placeholder=${this.label("appealStatement", "Appeal statement")}
                    ></textarea>
                    <button class="button" ?disabled=${this.busy}>
                      ${this.label("submitAppeal", "Submit appeal")}
                    </button>
                  </form>
                `
              : nothing
          }
        </div>
      </section>
    `;
  }
  private renderPreview(avatar: string) {
    const p = this.profile || {};
    const name = this.draft.name ?? String(p.candidateDisplayName || p.displayName || p.accountName || "");
    const handle = this.draft.handle ?? String(p.handle || "");
    const bio = this.draft.bio ?? String(p.bio || "");
    return html`
      <aside class="surface account-preview" aria-label=${this.label("preview", "Preview")}>
        ${this.heading("visibility", this.label("preview", "Preview"))}
        <div class="account-summary__identity">
          ${this.avatarOf(avatar, name || "?")}
          <div>
            <strong class="md-title-medium">${name}</strong>
            ${handle ? html`<p class="md-body-small">@${handle}</p>` : nothing}
          </div>
        </div>
        ${bio ? html`<p class="md-body-medium">${bio}</p>` : nothing}
      </aside>
    `;
  }

  private renderSecurity() {
    const user = this.user() || {};
    const providers = Array.isArray(this.config.providers) ? this.config.providers.map(String) : [];
    const linked = new Set(this.accounts.map((account) => String(account.providerId)));
    return html`
      <section class="account-section">
        <article class="surface account-block">
          ${this.heading("alternate_email", this.label("emailSettings", "Email address"))}
          <div class="account-setting-row">
            <span class="account-setting-row__label">${this.label("currentEmail", "Current email address")}</span>
            <strong>${String(user.email || "")}</strong>
          </div>
          <form class="account-inline-form" @submit=${this.changeEmail}>
            <label>
              <span>${this.label("newEmail", "New email address")}</span>
              <span class="field"><input name="newEmail" type="email" autocomplete="email" required /></span>
            </label>
            <button class="button" ?disabled=${this.busy}>${this.label("changeEmail", "Change email")}</button>
          </form>
        </article>
        ${
          linked.has("credential")
            ? html`
                <article class="surface account-block">
                  ${this.heading("password", this.label("changePassword", "Change password"))}
                  <form class="account-password-form" @submit=${this.changePassword}>
                    <input
                      type="email"
                      name="username"
                      autocomplete="username"
                      .value=${String(user.email || "")}
                      hidden
                    />
                    <label>
                      <span>${this.label("currentPassword", "Current password")}</span>
                      <span class="field">
                        <input
                          name="currentPassword"
                          type="password"
                          autocomplete="current-password"
                          minlength="12"
                          required
                        />
                      </span>
                    </label>
                    <label>
                      <span>${this.label("newPassword", "New password")}</span>
                      <span class="field">
                        <input name="newPassword" type="password" autocomplete="new-password" minlength="12" required />
                      </span>
                    </label>
                    <label>
                      <span>${this.label("confirmPassword", "Confirm new password")}</span>
                      <span class="field">
                        <input
                          name="confirmPassword"
                          type="password"
                          autocomplete="new-password"
                          minlength="12"
                          required
                        />
                      </span>
                    </label>
                    <button class="button" ?disabled=${this.busy}>
                      ${this.label("changePassword", "Change password")}
                    </button>
                  </form>
                </article>
              `
            : nothing
        }
        <article class="surface account-block">
          ${this.heading("link", this.label("connectedAccounts", "Connected accounts"), this.accounts.length)}
          <div class="provider-list">
            ${this.accounts.map(
              (account) => html`
                <div class="provider-row">
                  <span class="provider-mark">
                    ${
                      account.providerId === "credential" ? icon("password", 20) : oauthIcon(String(account.providerId))
                    }
                  </span>
                  <span>
                    <strong>${account.providerId === "credential" ? this.label("emailPassword", "Email & password") : String(account.providerId || "")}</strong>
                    <small>${this.label("linked", "Linked")} ${this.date(account.createdAt)}</small>
                  </span>
                  ${
                    account.providerId !== "credential" && this.accounts.length > 1
                      ? html`
                          <button
                            class="button button--text"
                            ?disabled=${this.busy}
                            @click=${() => this.unlinkAccount(account)}
                          >
                            ${this.label("unlink", "Unlink")}
                          </button>
                        `
                      : nothing
                  }
                </div>
              `,
            )}${providers
              .filter((provider) => !linked.has(provider))
              .map(
                (provider) => html`
                  <button
                    class="provider-row provider-row--link"
                    ?disabled=${this.busy}
                    @click=${() => this.linkAccount(provider)}
                  >
                    <span class="provider-mark">${oauthIcon(provider)}</span>
                    <span>
                      <strong>${provider}</strong>
                      <small>${this.label("link", "Link")}</small>
                    </span>
                  </button>
                `,
              )}
          </div>
        </article>
        ${this.renderApiTokens()}
      </section>
    `;
  }

  private renderSessions() {
    const current = String((this.session?.session as Value | undefined)?.token || "");
    const newestFirst = [...this.sessions].sort(
      (a, b) => Number(b.token === current) - Number(a.token === current) || Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)),
    );
    return html`
      <section class="account-section">
        <article class="surface account-block">
          ${this.heading("devices", this.label("sessions", "Sessions"), this.sessions.length)}
          <div class="session-list">
            ${newestFirst.map(
              (session) => html`
                <div class="session-item">
                  <span class=${`session-item__icon${session.token === current ? " current" : ""}`}>
                    ${icon(session.token === current ? "devices" : "phonelink", 20)}
                  </span>
                  <div>
                    <strong title=${String(session.userAgent || "")}>${deviceLabel(session.userAgent) || this.label("sessionUnknown", "Unknown device")}</strong>
                    <small>
                      ${session.token === current ? `${this.label("currentSession", "Current session")} · ` : ""}${String(session.ipAddress || "—")}
                      · ${this.date(session.createdAt)}
                    </small>
                  </div>
                  ${
                    session.token !== current
                      ? html`
                          <button
                            class="button button--text"
                            ?disabled=${this.busy}
                            @click=${() => this.revokeSession(session.token)}
                          >
                            ${this.label("revoke", "Revoke")}
                          </button>
                        `
                      : nothing
                  }
                </div>
              `,
            )}
          </div>
          <div class="session-actions">
            <button
              class="button button--tonal"
              ?disabled=${this.busy || this.sessions.length < 2}
              @click=${this.revokeOthers}
            >
              ${this.label("revokeOthers", "Revoke other sessions")}
            </button>
            <button class="button button--danger" ?disabled=${this.busy} @click=${this.revokeAll}>
              ${this.label("revokeAllSessions", "Revoke all sessions")}
            </button>
          </div>
        </article>
      </section>
    `;
  }

  private renderManagement() {
    const user = this.user() || {};
    return html`
      <section class="account-section">
        <article class="account-danger">
          <header>
            <span>${icon("warning", 22)}</span>
            <div>
              <h3>${this.label("dangerZone", "Danger zone")}</h3>
              <p>${this.label("deleteAccountDescription", "Disable sign-in and hide your community content.")}</p>
            </div>
          </header>
          <form class="account-danger-form" @submit=${this.deleteAccount}>
            <label>
              <span>${this.label("confirmDeleteHint", "Enter your email address to confirm this action.")}</span>
              <span class="field">
                <input
                  name="confirmation"
                  autocomplete="off"
                  required
                  pattern=${String(user.email || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}
                />
              </span>
            </label>
            <button class="button button--danger" ?disabled=${this.busy}>
              ${this.label("requestDeletion", "Delete account")}
            </button>
          </form>
        </article>
      </section>
    `;
  }
}

customElements.define("account-workspace", AccountWorkspace);
