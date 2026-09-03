import { LitElement, html, nothing } from "lit";
import { svg as discordSvg } from "@thesvg/icons/discord";
import { svg as githubSvg } from "@thesvg/icons/github";
import { svg as googleSvg } from "@thesvg/icons/google";
import { svg as xSvg } from "@thesvg/icons/x";
import { preferredLocale } from "./shared/catalog";

type Value = Record<string, unknown>;
type AuthMode = "signIn" | "signUp" | "forgotPassword" | "verifyEmail";
type Section = "profile" | "security" | "sessions" | "management";

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
    labels: { type: String },
    phase: { state: true },
    config: { state: true },
    session: { state: true },
    profile: { state: true },
    sessions: { state: true },
    accounts: { state: true },
    mode: { state: true },
    section: { state: true },
    busy: { state: true },
    message: { state: true },
    error: { state: true },
    avatarFile: { state: true },
    avatarPreview: { state: true },
    appealOpen: { state: true },
    captchaToken: { state: true },
  };
  declare labels: string;
  declare phase: "loading" | "ready";
  declare config: Value;
  declare session: Value | null;
  declare profile: Value | null;
  declare sessions: Value[];
  declare accounts: Value[];
  declare mode: AuthMode;
  declare section: Section;
  declare busy: boolean;
  declare message: string;
  declare error: string;
  declare avatarFile: File | null;
  declare avatarPreview: string;
  declare appealOpen: boolean;
  declare captchaToken: string;
  private copy: Record<string, string> = {};
  private turnstileId: string | number | null = null;

  constructor() {
    super();
    this.labels = "{}";
    this.phase = "loading";
    this.config = {};
    this.session = null;
    this.profile = null;
    this.sessions = [];
    this.accounts = [];
    this.mode = "signIn";
    this.section = "profile";
    this.busy = false;
    this.message = "";
    this.error = "";
    this.avatarFile = null;
    this.avatarPreview = "";
    this.appealOpen = false;
    this.captchaToken = "";
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    const values = JSON.parse(this.labels || "{}") as Record<string, Record<string, string>>;
    this.copy = values[preferredLocale()] || values.ja || {};
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

  disconnectedCallback() {
    if (this.avatarPreview) URL.revokeObjectURL(this.avatarPreview);
    super.disconnectedCallback();
  }

  protected updated() {
    void this.mountTurnstile();
  }

  private label(key: string, fallback: string) {
    return this.copy[key] || fallback;
  }
  private user() {
    return (this.session?.user as Value | undefined) || null;
  }
  private clearMessages() {
    this.error = "";
    this.message = "";
  }
  private nextPath() {
    const value = new URLSearchParams(location.search).get("next") || "";
    return value.startsWith("/") && !value.startsWith("//") ? value : "/account";
  }
  private date(value: unknown) {
    const date = new Date(String(value || ""));
    return Number.isFinite(date.valueOf())
      ? new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium", timeStyle: "short" }).format(date)
      : "—";
  }

  private async request(url: string, init: RequestInit = {}) {
    const headers = new Headers({ accept: "application/json" });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init, headers });
    const data = (await response.json().catch(() => ({}))) as Value;
    if (!response.ok)
      throw new Error(String((data.error as Value | undefined)?.message || data.message || `HTTP ${response.status}`));
    return data;
  }

  private captchaHeaders(): Record<string, string> {
    return this.captchaToken ? { "x-captcha-response": this.captchaToken } : {};
  }
  private async action(work: () => Promise<unknown>, success?: string): Promise<Value | null> {
    if (this.busy) return null;
    this.busy = true;
    this.clearMessages();
    try {
      const result = await work();
      if (success) this.message = success;
      return result && typeof result === "object" && !Array.isArray(result) ? (result as Value) : {};
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return null;
    } finally {
      this.busy = false;
      this.resetTurnstile();
    }
  }

  private async load() {
    this.phase = "loading";
    try {
      this.config = await this.request("/api/v1/account/config").catch(() => ({ available: false }));
      const session: Value = (await this.request("/api/auth/get-session").catch(() => null)) || ({} as Value);
      this.session = session.user ? session : null;
      if (this.session) await Promise.all([this.loadProfile(), this.loadSecurity()]);
    } finally {
      this.phase = "ready";
    }
  }

  private async loadProfile() {
    const value = await this.request("/api/v1/account/profile");
    this.profile = (value.profile as Value) || null;
  }

  private async loadSecurity() {
    const [sessions, accounts] = await Promise.all([
      this.request("/api/auth/list-sessions"),
      this.request("/api/auth/list-accounts"),
    ]);
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

  private async submitAuth(event: SubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const legal = Boolean(data.get("legal"));
    if (!legal) {
      this.error = this.label("legalAgreementRequired", "Accept the policies before continuing.");
      return;
    }
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
        this.session = null;
        this.profile = null;
        this.sessions = [];
        this.accounts = [];
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
    const result = await this.action(
      () =>
        this.request("/api/v1/account/avatar", {
          method: "PUT",
          headers: { "content-type": file.type, "x-file-name": encodeURIComponent(file.name) },
          body: file,
        }),
      this.label("avatarPending", "Your avatar is being reviewed."),
    );
    if (result) {
      this.cancelAvatar();
      await this.loadProfile();
    }
  }
  private async deleteAvatar() {
    const result = await this.action(
      () => this.request("/api/v1/account/avatar", { method: "DELETE" }),
      this.label("avatarDeleted", "Avatar deleted."),
    );
    if (result) await this.loadProfile();
  }

  private async submitAppeal() {
    const statement = this.querySelector<HTMLTextAreaElement>('textarea[name="statement"]')?.value.trim() || "";
    const userId = String(this.user()?.id || "");
    const result = await this.action(
      () =>
        this.request("/api/v1/community/appeals", {
          method: "POST",
          body: JSON.stringify({ entityKind: "profile-name", entityId: userId, statement }),
        }),
      this.label("appealSubmitted", "Appeal submitted."),
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
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const currentPassword = String(data.get("currentPassword") || "");
    const newPassword = String(data.get("newPassword") || "");
    const confirm = String(data.get("confirmPassword") || "");
    if (newPassword !== confirm) {
      this.error = this.label("passwordMismatch", "The passwords do not match.");
      return;
    }
    const result = await this.action(
      () =>
        this.request("/api/auth/change-password", {
          method: "POST",
          body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
        }),
      this.label("passwordChanged", "Password changed."),
    );
    if (result) {
      (event.currentTarget as HTMLFormElement).reset();
      await this.loadSecurity();
    }
  }
  private async revokeSession(token: unknown) {
    const result = await this.action(
      () => this.request("/api/auth/revoke-session", { method: "POST", body: JSON.stringify({ token }) }),
      this.label("sessionRevoked", "Session revoked."),
    );
    if (result) await this.loadSecurity();
  }
  private async revokeOthers() {
    const result = await this.action(
      () => this.request("/api/auth/revoke-other-sessions", { method: "POST", body: "{}" }),
      this.label("sessionRevoked", "Sessions revoked."),
    );
    if (result) await this.loadSecurity();
  }
  private async revokeAll() {
    const result = await this.action(
      () => this.request("/api/auth/revoke-sessions", { method: "POST", body: "{}" }),
      this.label("sessionRevoked", "Sessions revoked."),
    );
    if (result) await this.load();
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
    const result = await this.action(
      () =>
        this.request("/api/auth/unlink-account", {
          method: "POST",
          body: JSON.stringify({ providerId: account.providerId, accountId: account.accountId }),
        }),
      this.label("accountUnlinked", "Account unlinked."),
    );
    if (result) await this.loadSecurity();
  }
  private async deleteAccount(event: SubmitEvent) {
    event.preventDefault();
    const confirmation = String(new FormData(event.currentTarget as HTMLFormElement).get("confirmation") || "");
    const result = await this.action(
      () => this.request("/api/v1/account/profile", { method: "DELETE", body: JSON.stringify({ confirmation }) }),
      this.label("accountDeleted", "Account deleted."),
    );
    if (result) {
      this.session = null;
      this.profile = null;
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
  private async mountTurnstile() {
    const sitekey = String(this.config.turnstileSiteKey || "");
    const container = this.querySelector<HTMLElement>("[data-turnstile]");
    if (!sitekey || !container || container.dataset.mounted) return;
    container.dataset.mounted = "true";
    const api = await new Promise<{ render: (target: HTMLElement, options: Value) => string | number }>((resolve) => {
      const existing = (
        window as unknown as { turnstile?: { render: (target: HTMLElement, options: Value) => string | number } }
      ).turnstile;
      if (existing) {
        resolve(existing);
        return;
      }
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = () =>
        resolve(
          (window as unknown as { turnstile: { render: (target: HTMLElement, options: Value) => string | number } })
            .turnstile,
        );
      document.head.append(script);
    });
    this.turnstileId = api.render(container, {
      sitekey,
      callback: (token: string) => {
        this.captchaToken = token;
      },
      "expired-callback": () => {
        this.captchaToken = "";
      },
    });
  }

  render() {
    if (this.phase === "loading")
      return html`
        <div class="catalog-state"><md-circular-progress indeterminate></md-circular-progress></div>
      `;
    return html`
      <section class="page page--compact account-page">
        ${
          this.error
            ? html`
                <div class="inline-message error" role="alert">
                  ${this.error}
                  <button class="icon-button" aria-label=${this.label("close", "Close")} @click=${this.clearMessages}>
                    ${icon("close", 18)}
                  </button>
                </div>
              `
            : nothing
        }${
          this.message
            ? html`
                <div class="inline-message" role="status">
                  ${this.message}
                  <button class="icon-button" aria-label=${this.label("close", "Close")} @click=${this.clearMessages}>
                    ${icon("close", 18)}
                  </button>
                </div>
              `
            : nothing
        }${this.session ? this.renderAccount() : this.renderAuth()}
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
            <div data-turnstile></div>
            <button class="button" ?disabled=${this.busy} @click=${this.resendVerification}>
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
            <div data-turnstile></div>
            <label class="check-row">
              <input name="legal" type="checkbox" required />
              <span>
                ${this.label("legalAgreementPrefix", "I agree to the")}
                <a href="/privacy" target="_blank">${this.label("privacy", "Privacy Policy")}</a>
                ${this.label("legalAgreementJoiner", "and")}
                <a href="/terms" target="_blank">${this.label("terms", "Terms of Use")}</a>
                ${this.label("legalAgreementSuffix", ".")}
              </span>
            </label>
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
        </article>
      </section>
    `;
  }

  private sectionButton(id: Section, iconName: string, label: string) {
    return html`
      <button
        role="tab"
        aria-selected=${this.section === id}
        class=${this.section === id ? "selected" : ""}
        @click=${() => (this.section = id)}
      >
        ${icon(iconName)}
        <span>${label}</span>
      </button>
    `;
  }
  private renderAccount() {
    const user = this.user() || {};
    const profile = this.profile || {};
    const identity = String(profile.displayName || profile.accountName || user.name || user.email || "?");
    const avatar = this.avatarPreview || String(profile.avatarUrl || user.image || "");
    const uid = profile.publicUid;
    const role = String(profile.role || "member");
    const status = String(profile.profileStatus || "active");
    return html`
      <div class="account-workspace">
        <header class="account-identity">
          <div class="account-avatar-picker">
            ${
              avatar
                ? html`
                    <img src=${avatar} alt="" />
                  `
                : html`
                    <span>${identity.slice(0, 1)}</span>
                  `
            }
            <label
              class="icon-button account-avatar-picker__action"
              aria-label=${this.label("chooseAvatar", "Choose avatar")}
            >
              ${icon("photo_camera", 18)}
              <input type="file" accept="image/jpeg,image/png,image/webp" @change=${this.selectAvatar} />
            </label>
          </div>
          <div class="account-identity__copy">
            <h2>${identity}</h2>
            <p>${String(user.email || "")}</p>
            <button class="button button--tonal account-uid" ?disabled=${uid == null} @click=${this.copyUid}>
              ${icon("content_copy", 17)} ${this.label("publicUid", "UID")}
              <strong>${uid ?? "—"}</strong>
            </button>
          </div>
          <div class="account-identity__status">
            <span>${icon("person", 17)}${this.label(`role${role[0]?.toUpperCase()}${role.slice(1)}`, role)}</span>
            <span class=${user.emailVerified ? "verified" : ""}>
              ${icon(user.emailVerified ? "check_circle" : "alternate_email", 17)}${user.emailVerified ? this.label("verified", "Verified") : this.label("unverified", "Not verified")}
            </span>
            <span>
              ${icon("verified_user", 17)}${this.label(`status${status[0]?.toUpperCase()}${status.slice(1)}`, status)}
            </span>
          </div>
          <div class="account-identity__actions">
            ${
              Number.isSafeInteger(uid)
                ? html`
                    <a class="button button--tonal" href=${`/community/users/${uid}`}>
                      ${icon("open_in_new", 18)}${this.label("publicProfile", "Public profile")}
                    </a>
                  `
                : nothing
            }${
              role === "admin"
                ? html`
                    <a class="button button--tonal" href="/admin">
                      ${icon("admin_panel_settings", 18)}${this.label("adminConsole", "Admin console")}
                    </a>
                  `
                : nothing
            }
            <button class="button button--danger" ?disabled=${this.busy} @click=${this.signOut}>
              ${icon("logout", 18)}${this.label("signOut", "Sign out")}
            </button>
          </div>
        </header>
        <div class="account-main">
          <nav class="account-navigation" role="tablist">
            ${this.sectionButton("profile", "person", this.label("profile", "Profile"))}${this.sectionButton("security", "verified_user", this.label("security", "Sign-in & security"))}${this.sectionButton("sessions", "devices", this.label("sessions", "Sessions"))}${this.sectionButton("management", "settings", this.label("accountManagement", "Account management"))}
          </nav>
          <main class="account-content">
            ${this.section === "profile" ? this.renderProfile() : this.section === "security" ? this.renderSecurity() : this.section === "sessions" ? this.renderSessions() : this.renderManagement()}
          </main>
        </div>
      </div>
    `;
  }

  private renderProfile() {
    const p = this.profile || {};
    const u = this.user() || {};
    const avatar = this.avatarPreview || String(p.avatarUrl || u.image || "");
    return html`
      <section class="account-section">
        <header class="account-section__title">
          ${icon("person")}
          <h2>${this.label("profile", "Profile")}</h2>
        </header>
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
                <input type="file" accept="image/jpeg,image/png,image/webp" @change=${this.selectAvatar} />
              </label>
            </div>
            <div class="account-row-actions">
              ${
                this.avatarFile
                  ? html`
                      <button class="button" ?disabled=${this.busy} @click=${this.uploadAvatar}>
                        ${this.label("uploadAvatar", "Upload")}
                      </button>
                      <button class="button button--text" @click=${this.cancelAvatar}>
                        ${this.label("cancelAvatar", "Cancel")}
                      </button>
                    `
                  : nothing
              }${
                p.avatarUrl || u.image
                  ? html`
                      <button class="button button--danger" ?disabled=${this.busy} @click=${this.deleteAvatar}>
                        ${this.label("deleteAvatar", "Delete avatar")}
                      </button>
                    `
                  : nothing
              }
            </div>
          </div>
          <form class="account-profile-form" @submit=${this.updateProfile}>
            <label class="account-setting-row">
              <span class="account-setting-row__label">${this.label("displayName", "Display name")}</span>
              <span class="field">
                <input
                  name="displayName"
                  .value=${String(p.candidateDisplayName || p.accountName || u.name || "")}
                  maxlength="64"
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
              <button class="button" ?disabled=${this.busy}>${this.label("saveProfile", "Save profile")}</button>
            </div>
          </form>
          ${
            this.appealOpen
              ? html`
                  <div class="profile-appeal-form">
                    <textarea
                      class="text-area"
                      name="statement"
                      maxlength="2000"
                      required
                      placeholder=${this.label("appealStatement", "Appeal statement")}
                    ></textarea>
                    <button class="button" type="button" ?disabled=${this.busy} @click=${this.submitAppeal}>
                      ${this.label("submitAppeal", "Submit appeal")}
                    </button>
                  </div>
                `
              : nothing
          }
        </div>
      </section>
    `;
  }

  private renderSecurity() {
    const user = this.user() || {};
    const providers = Array.isArray(this.config.providers) ? this.config.providers.map(String) : [];
    const linked = new Set(this.accounts.map((account) => String(account.providerId)));
    return html`
      <section class="account-section">
        <header class="account-section__title">
          ${icon("verified_user")}
          <h2>${this.label("security", "Sign-in & security")}</h2>
        </header>
        <article class="account-block">
          <h3>${this.label("emailSettings", "Email address")}</h3>
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
                <article class="account-block">
                  <h3>${this.label("changePassword", "Change password")}</h3>
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
        <article class="account-block">
          <h3>${this.label("connectedAccounts", "Connected accounts")}</h3>
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
                    <strong>${String(account.providerId || "")}</strong>
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
      </section>
    `;
  }

  private renderSessions() {
    const current = String((this.session?.session as Value | undefined)?.token || "");
    return html`
      <section class="account-section">
        <header class="account-section__title">
          ${icon("devices")}
          <h2>${this.label("sessions", "Sessions")}</h2>
          <button
            class="button button--text"
            ?disabled=${this.busy}
            @click=${() => this.action(() => this.loadSecurity())}
          >
            ${icon("refresh", 18)}${this.label("refresh", "Refresh")}
          </button>
        </header>
        <article class="account-block">
          <div class="session-list">
            ${this.sessions.map(
              (session) => html`
                <div class="session-item">
                  <span class=${`session-item__icon${session.token === current ? " current" : ""}`}>
                    ${icon(session.token === current ? "devices" : "phonelink", 20)}
                  </span>
                  <div>
                    <strong>${String(session.userAgent || this.label("sessionUnknown", "Unknown device"))}</strong>
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
        <header class="account-section__title">
          ${icon("settings")}
          <h2>${this.label("accountManagement", "Account management")}</h2>
        </header>
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
