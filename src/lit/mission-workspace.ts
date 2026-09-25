/**
 * Missions — a help-style page, not a collection.
 *
 * Missions are conditions, not artwork: a segmented regular/limited switch
 * in the app bar, then grouped lists (limited mission groups with their
 * windows, then the standing missions) of one-line conditions with their
 * rewards. The game data is rendered exactly as authored.
 */

import { LitElement, html, nothing } from "lit";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import { segmented } from "./ui/controls";
import { errorState, loadingState } from "./ui/state";
import {
  catalogUrl,
  fetchJson,
  localizedText,
  preferredLocale,
  recordValues,
  type JsonRecord,
  uiText,
} from "./shared/catalog";
import { icon } from "./ui/icon";
import "../styles/mission.css";

type Mode = "all" | "regular" | "limited";
interface Mission extends JsonRecord {
  id: string;
  kind?: string;
  rewards?: JsonRecord[];
}

const timestamp = (value: unknown) =>
  Array.isArray(value) ? Math.max(0, ...value.map(Number).filter((entry) => Number(entry) > 0)) : Number(value) || 0;

export class MissionWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    labels: { type: String },
    phase: { state: true },
    missions: { state: true },
    mode: { state: true },
  };
  declare locale: string;
  declare labels: string;
  declare phase: "loading" | "ready" | "error";
  declare missions: Mission[];
  declare mode: Mode;
  private copies: Record<string, Record<string, string>> = {};
  private error = "";
  private localeListener = () => {
    this.locale = preferredLocale(this.locale);
  };
  constructor() {
    super();
    this.locale = "ja";
    this.labels = "{}";
    this.phase = "loading";
    this.missions = [];
    this.mode = "all";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    this.copies = JSON.parse(this.labels || "{}");
    addEventListener("haneoka:locale-ready", this.localeListener);
    void import("@material/web/progress/circular-progress.js");
    const params = new URLSearchParams(location.search);
    this.mode =
      params.get("mode") === "regular" || params.get("mode") === "limited" ? (params.get("mode") as Mode) : "all";
    void this.load();
  }
  disconnectedCallback() {
    clearAppBarActions("missions");
    removeEventListener("haneoka:locale-ready", this.localeListener);
    super.disconnectedCallback();
  }
  private text(key: string, fallback: string) {
    return (this.copies[this.locale] || this.copies.ja || {})[key] || fallback;
  }
  private name(value: unknown) {
    return localizedText(value, this.locale);
  }
  private async load() {
    this.phase = "loading";
    try {
      const document = await fetchJson<JsonRecord>(catalogUrl("missions"));
      this.missions = recordValues(document.entries) as Mission[];
      this.phase = "ready";
    } catch (error) {
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private sync() {
    const params = new URLSearchParams();
    if (this.mode !== "all") params.set("mode", this.mode);
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  /** Limited groups first (with their window), then standing missions. */
  private groups(): Array<{ key: string; title: string; window?: { start: number; end: number }; rows: Mission[] }> {
    const filtered = this.missions.filter(
      (mission) =>
        this.mode === "all" ||
        (this.mode === "limited" && mission.kind === "limited-mission") ||
        (this.mode === "regular" && mission.kind !== "limited-mission"),
    );
    const limited = new Map<string, Mission[]>();
    const regular: Mission[] = [];
    for (const mission of filtered) {
      if (mission.kind === "limited-mission") {
        const key = this.name(mission.group) || "—";
        limited.set(key, [...(limited.get(key) || []), mission]);
      } else regular.push(mission);
    }
    // Newest window first, and within every group the latest missions first.
    const byStart = (a: Mission, b: Mission) => timestamp(b.startAt) - timestamp(a.startAt);
    const groups = [...limited.entries()]
      .map(([title, rows]) => ({
        key: `limited-${title}`,
        title,
        window: {
          start: Math.max(...rows.map((row) => timestamp(row.startAt) || 0)),
          end: Math.max(...rows.map((row) => timestamp(row.endAt) || 0)),
        },
        rows: [...rows].sort(byStart),
      }))
      .sort((a, b) => b.window.start - a.window.start);
    if (regular.length || !groups.length)
      groups.push({
        key: "regular",
        title: this.text("regularMission", "Mission"),
        window: { start: 0, end: 0 },
        rows: [...regular].sort(byStart),
      });
    return groups;
  }
  private date(value: number) {
    return value && Number.isFinite(value)
      ? new Intl.DateTimeFormat(this.locale, { dateStyle: "medium" }).format(new Date(value))
      : "";
  }
  private reward(reward: JsonRecord) {
    const title = this.name(reward.name);
    if (!title) return nothing;
    const image = String(reward.image || "");
    const count = Number(reward.count || 0);
    const href = String(reward.href || "");
    const body = html`
      ${
        image
          ? html`
              <img src=${image} alt="" loading="lazy" decoding="async" />
            `
          : icon("redeem", 18)
      }
      <span>${title}</span>
      ${
        count > 1
          ? html`
              <b class="tabular">×${count.toLocaleString(this.locale)}</b>
            `
          : nothing
      }
    `;
    return href
      ? html`
          <a class="mission-chip state-layer" href=${href}>${body}</a>
        `
      : html`
          <span class="mission-chip">${body}</span>
        `;
  }
  render() {
    setAppBarActions(
      "missions",
      segmented({
        label: uiText(this.locale, "view"),
        value: this.mode,
        options: [
          { value: "all" as const, label: uiText(this.locale, "all"), icon: "apps" },
          { value: "regular" as const, label: this.text("regularMission", "Mission"), icon: "fact_check" },
          { value: "limited" as const, label: this.text("limitedMission", "Limited mission"), icon: "schedule" },
        ],
        onSelect: (mode) => {
          this.mode = mode;
          this.sync();
        },
      }),
    );
    const groups = this.groups();
    return html`
      <section class="mission-workspace">
        ${
          this.phase === "loading"
            ? loadingState(uiText(this.locale, "loading"))
            : this.phase === "error"
              ? errorState(
                  uiText(this.locale, "unavailable"),
                  uiText(this.locale, "retry"),
                  () => void this.load(),
                  this.error,
                )
              : html`
                  ${groups.map(
                    (group) => html`
                      <section class="mission-group">
                        <header class="mission-group__header">
                          <h2>${group.title}</h2>
                          ${
                            group.rows.length
                              ? html`
                                  <span class="tabular">${group.rows.length}</span>
                                `
                              : nothing
                          }
                          ${
                            group.window && (group.window.start || group.window.end)
                              ? html`
                                  <small class="mission-group__window">
                                    ${
                                      group.window.start && group.window.end
                                        ? `${this.date(group.window.start)} – ${this.date(group.window.end)}`
                                        : this.date(group.window.start || group.window.end)
                                    }
                                  </small>
                                `
                              : nothing
                          }
                        </header>
                        <ul class="mission-list" role="list">
                          ${group.rows.map(
                            (mission) => html`
                              <li class="mission-row">
                                <span class="mission-row__condition">${this.name(mission.title) || "—"}</span>
                                <span class="mission-row__rewards">
                                  ${(Array.isArray(mission.rewards) ? mission.rewards : []).map((reward) =>
                                    this.reward(reward as JsonRecord),
                                  )}
                                </span>
                              </li>
                            `,
                          )}
                        </ul>
                      </section>
                    `,
                  )}
                `
        }
      </section>
    `;
  }
}
if (!customElements.get("mission-workspace")) customElements.define("mission-workspace", MissionWorkspace);
