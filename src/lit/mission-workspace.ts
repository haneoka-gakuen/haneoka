/**
 * Missions — group overview, then one group's list.
 *
 * The overview is a grid of mission groups (limited and beginner windows,
 * then the standing categories: daily, unlocks, story, performance, growth,
 * hidden), each with its count, time window and reward totals. Opening a
 * group shows its one-line conditions with rewards; the group is in the URL
 * (`?group=`), so Back returns to the overview. A segmented all/regular/
 * limited switch stays in the app bar. Game data is rendered as authored.
 */

import { LitElement, html, nothing } from "lit";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import { syncEntityNavigation, updateEntityHeading } from "../lib/detail-navigation";
import { beginLoading, type LoadingReporter } from "../lib/loading-progress";
import { entityHref, parseResourceRoute, type ReleaseServer } from "../lib/resource-route";
import { segmented } from "./ui/controls";
import { errorState, loadingState } from "./ui/state";
import {
  catalogUrl,
  currentReleaseServer,
  fetchJson,
  localizedText,
  preferredLocale,
  recordValues,
  type JsonRecord,
  uiText,
} from "./shared/catalog";
import { icon } from "./ui/icon";
import { clientText } from "../i18n/client";
import type { Locale } from "@haneoka/i18n";
import "../styles/mission.css";

type Mode = "all" | "regular" | "limited";
type Category = "limited" | "daily" | "unlocks" | "story" | "performance" | "growth" | "hidden";
interface Group {
  key: string;
  title: string;
  category: Category;
  window: { start: number; end: number };
  rows: Mission[];
}
const CATEGORY_ICONS: Record<Category, string> = {
  limited: "schedule",
  daily: "event_repeat",
  unlocks: "lock_open",
  story: "menu_book",
  performance: "mic",
  growth: "trending_up",
  hidden: "visibility_off",
};
const CATEGORY_LABELS: Record<Exclude<Category, "limited">, [string, string]> = {
  daily: ["missionDaily", "Daily missions"],
  unlocks: ["missionUnlocks", "Song & scene unlocks"],
  story: ["missionStory", "Story reading"],
  performance: ["missionPerformance", "Performance challenges"],
  growth: ["missionGrowth", "Growth"],
  hidden: ["missionHidden", "Hidden missions"],
};
const CATEGORY_ORDER: Category[] = ["limited", "daily", "unlocks", "story", "performance", "growth", "hidden"];
interface Mission extends JsonRecord {
  id: string;
  kind?: string;
  description?: unknown;
  image?: string;
  imageVariants?: JsonRecord;
  rewards?: JsonRecord[];
}

const timestamp = (value: unknown) =>
  Array.isArray(value) ? Math.max(0, ...value.map(Number).filter((entry) => Number(entry) > 0)) : Number(value) || 0;

export class MissionWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    entityId: { state: true },
    phase: { state: true },
    missions: { state: true },
    mode: { state: true },
    groupKey: { state: true },
  };
  declare groupKey: string;
  declare locale: string;
  declare entityId: string;
  declare phase: "loading" | "ready" | "error";
  declare missions: Mission[];
  declare mode: Mode;
  private server: ReleaseServer = "intl";
  private error = "";
  private request?: AbortController;
  private loading?: LoadingReporter;
  private localeListener = () => {
    this.locale = preferredLocale(this.locale);
    this.syncEntityHeading();
  };
  constructor() {
    super();
    this.locale = "ja";
    this.entityId = "";
    this.phase = "loading";
    this.missions = [];
    this.mode = "all";
    this.groupKey = "";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    const route = parseResourceRoute(location.pathname);
    this.entityId = route?.kind === "missions" ? route.id || "" : "";
    this.server = route?.kind === "missions" ? route.server : (currentReleaseServer() as ReleaseServer);
    addEventListener("haneoka:locale-ready", this.localeListener);
    void import("@material/web/progress/circular-progress.js");
    const params = new URLSearchParams(location.search);
    this.mode =
      params.get("mode") === "regular" || params.get("mode") === "limited" ? (params.get("mode") as Mode) : "all";
    this.groupKey = params.get("group") || "";
    addEventListener("popstate", this.popState);
    syncEntityNavigation();
    void this.load();
  }
  private popState = () => {
    this.groupKey = new URLSearchParams(location.search).get("group") || "";
    if (!this.groupKey) this.openedInPlace = false;
  };
  disconnectedCallback() {
    this.request?.abort();
    this.request = undefined;
    this.loading?.cancel();
    clearAppBarActions("missions");
    removeEventListener("popstate", this.popState);
    removeEventListener("haneoka:locale-ready", this.localeListener);
    super.disconnectedCallback();
  }
  private text(key: string, fallback: string, params?: Record<string, string | number>) {
    return clientText(this.locale, `system.${key}`, fallback, params);
  }
  private name(value: unknown, locale = this.locale) {
    return localizedText(value, locale);
  }
  private image(value: JsonRecord) {
    const source = String(value.image || "");
    const variants = value.imageVariants;
    if (!source || !variants || typeof variants !== "object") return source;
    const localized = (variants as JsonRecord)[source];
    if (!localized || typeof localized !== "object") return source;
    const key = ({ "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" } as Record<string, string>)[this.locale] || this.locale;
    return typeof (localized as JsonRecord)[key] === "string" ? String((localized as JsonRecord)[key]) : source;
  }
  private entityLink(id: string) {
    return entityHref({
      server: this.server,
      locale: this.locale as Locale,
      kind: "missions",
      id,
    });
  }
  private syncEntityHeading() {
    if (!this.entityId || !this.missions[0]) return;
    const title = this.name(this.missions[0].title) || this.entityId;
    updateEntityHeading(this, title, this.locale);
    syncEntityNavigation();
  }
  private async load() {
    this.request?.abort();
    this.loading?.cancel();
    const controller = new AbortController();
    const progress = beginLoading(uiText(this.locale, "loading"), { scope: "owner", signal: controller.signal });
    this.request = controller;
    this.loading = progress;
    this.phase = "loading";
    this.error = "";
    try {
      const document = this.entityId
        ? await fetchJson<JsonRecord>(catalogUrl("missions", this.entityId, this.server), { signal: controller.signal })
        : await fetchJson<JsonRecord>(catalogUrl("missions", "", this.server), { signal: controller.signal });
      if (this.request !== controller || controller.signal.aborted) {
        progress.cancel();
        return;
      }
      if (this.entityId) {
        if (String(document.id || "") !== this.entityId) throw new Error(uiText(this.locale, "unavailable"));
        this.missions = [document as Mission];
      } else {
        this.missions = recordValues(document.entries) as Mission[];
      }
      this.phase = "ready";
      this.syncEntityHeading();
      progress.finish();
    } catch (error) {
      if (controller.signal.aborted || this.request !== controller) {
        progress.cancel();
        return;
      }
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
      progress.fail(error);
    } finally {
      if (this.request === controller && this.phase !== "error") {
        this.request = undefined;
        this.loading = undefined;
      }
    }
  }
  private sync() {
    const params = new URLSearchParams(location.search);
    params.delete("mode");
    if (this.mode !== "all") params.set("mode", this.mode);
    params.delete("group");
    if (this.groupKey) params.set("group", this.groupKey);
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  /**
   * Standing missions carry their MasterMission category in the id
   * (`regular-mission-<category><sequence>`, e.g. 100000001, 1500000001): 10 daily, 15/16 song and scene
   * unlocks, 40 the standing list, 90/95 hidden. The standing list splits by
   * mission type into story, performance and growth.
   */
  private category(mission: Mission): Category {
    if (mission.kind === "limited-mission") return "limited";
    // The category is the id's two leading digits (sequence widths differ).
    const prefix = Number(/(\d+)$/u.exec(String(mission.id))?.[1]?.slice(0, 2) || 0);
    if (prefix === 10) return "daily";
    if (prefix === 15 || prefix === 16) return "unlocks";
    if (prefix === 90 || prefix === 95) return "hidden";
    const type = Number(mission.missionType || 0);
    if (type === 104 || type === 105) return "story";
    if (type === 122 || type === 124) return "performance";
    return "growth";
  }
  /** Limited groups first (newest window first), then the standing categories in game order. */
  private groups(): Group[] {
    const filtered = this.missions.filter(
      (mission) =>
        this.mode === "all" ||
        (this.mode === "limited" && mission.kind === "limited-mission") ||
        (this.mode === "regular" && mission.kind !== "limited-mission"),
    );
    const buckets = new Map<string, { title: string; category: Category; rows: Mission[] }>();
    for (const mission of filtered) {
      const category = this.category(mission);
      const title =
        category === "limited"
          ? this.name(mission.group) || this.text("limitedMission", "Limited mission")
          : this.text(...CATEGORY_LABELS[category]);
      const key = category === "limited" ? `limited-${this.name(mission.group, "ja") || title}` : category;
      const bucket = buckets.get(key);
      if (bucket) bucket.rows.push(mission);
      else buckets.set(key, { title, category, rows: [mission] });
    }
    const byStart = (a: Mission, b: Mission) => timestamp(b.startAt) - timestamp(a.startAt);
    return [...buckets.entries()]
      .map(([key, bucket]) => ({
        key,
        ...bucket,
        window:
          bucket.category === "limited"
            ? {
                start: Math.max(...bucket.rows.map((row) => timestamp(row.startAt) || 0)),
                end: Math.max(...bucket.rows.map((row) => timestamp(row.endAt) || 0)),
              }
            : { start: 0, end: 0 },
        rows: bucket.category === "limited" ? [...bucket.rows].sort(byStart) : bucket.rows,
      }))
      .sort(
        (a, b) =>
          CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || b.window.start - a.window.start,
      );
  }
  /** Rewards summed across a group's missions, in first-seen order. */
  private rewardTotals(rows: Mission[]) {
    const totals = new Map<string, JsonRecord>();
    for (const mission of rows)
      for (const reward of Array.isArray(mission.rewards) ? (mission.rewards as JsonRecord[]) : []) {
        // Rows show only named rewards; the totals follow them.
        if (!this.name(reward.name)) continue;
        const key = `${String(reward.kind || "")}:${String(reward.resourceType ?? "")}:${String(reward.resourceId ?? this.name(reward.name))}`;
        const entry = totals.get(key);
        if (entry) entry.count = Number(entry.count || 0) + Number(reward.count || 1);
        else totals.set(key, { ...reward, count: Number(reward.count || 1), href: "" });
      }
    return [...totals.values()];
  }
  private windowText(group: Group) {
    if (group.category === "daily") return this.text("missionDailyReset", "Resets daily");
    const { start, end } = group.window;
    if (!start && !end) return this.text("missionNoEnd", "No end date");
    return start && end ? `${this.date(start)} – ${this.date(end)}` : this.date(start || end);
  }
  private openGroup(event: MouseEvent, key: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    this.groupKey = key;
    this.openedInPlace = true;
    const params = new URLSearchParams(location.search);
    params.set("group", key);
    history.pushState(history.state, "", `${location.pathname}?${params}`);
    this.closest<HTMLElement>("#main-content")?.scrollTo({ top: 0 });
  }
  /** True while the open group was pushed from the overview, so Back can simply pop it. */
  private openedInPlace = false;
  private closeGroup() {
    if (this.openedInPlace) {
      this.openedInPlace = false;
      history.back();
      return;
    }
    this.groupKey = "";
    this.sync();
  }
  private groupHref(key: string) {
    const params = new URLSearchParams(location.search);
    params.set("group", key);
    return `${location.pathname}?${params}`;
  }
  private groupCard(group: Group) {
    const totals = this.rewardTotals(group.rows);
    const shown = totals.slice(0, 4);
    return html`
      <li>
        <a
          class="mission-card"
          data-category=${group.category}
          href=${this.groupHref(group.key)}
          @click=${(event: MouseEvent) => this.openGroup(event, group.key)}
        >
          <span class="mission-card__head">
            <span class="mission-card__icon">${icon(CATEGORY_ICONS[group.category], 24)}</span>
            <span class="mission-card__count tabular">
              ${this.text("missionCount", "{count} missions", { count: group.rows.length.toLocaleString(this.locale) })}
            </span>
          </span>
          <strong class="mission-card__title">${group.title}</strong>
          <span class="mission-card__window">${icon("schedule", 16)}<span>${this.windowText(group)}</span></span>
          ${
            shown.length
              ? html`
                  <span class="mission-card__rewards" aria-label=${this.text("missionRewardTotal", "Total rewards")}>
                    ${shown.map((reward) => this.reward(reward))}
                    ${
                      totals.length > shown.length
                        ? html`
                            <span class="mission-card__more tabular">+${totals.length - shown.length}</span>
                          `
                        : nothing
                    }
                  </span>
                `
              : nothing
          }
        </a>
      </li>
    `;
  }
  private groupView(group: Group) {
    return html`
      <section class="mission-group">
        <header class="mission-group__header">
          <button class="icon-button" type="button" @click=${() => this.closeGroup()} aria-label=${uiText(this.locale, "back")}>
            ${icon("arrow_back", 24)}
          </button>
          <span class="mission-group__icon">${icon(CATEGORY_ICONS[group.category], 20)}</span>
          <span class="mission-group__heading">
            <h2>${group.title}</h2>
            <small class="mission-group__window">${this.windowText(group)}</small>
          </span>
          <span class="mission-group__count tabular">${group.rows.length}</span>
        </header>
        <ul class="mission-list" role="list">
          ${group.rows.map(
            (mission) => html`
              <li class="mission-row">
                <a class="mission-row__condition" href=${this.entityLink(mission.id)}>
                  ${this.name(mission.title) || "—"}
                </a>
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
    `;
  }
  private date(value: number) {
    return value && Number.isFinite(value)
      ? new Intl.DateTimeFormat(this.locale, { dateStyle: "medium" }).format(new Date(value))
      : "";
  }
  private reward(reward: JsonRecord) {
    const title = this.name(reward.name);
    if (!title) return nothing;
    const image = this.image(reward);
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
  private entityView(mission: Mission) {
    const title = this.name(mission.title) || mission.id;
    const kind =
      mission.kind === "limited-mission"
        ? this.text("limitedMission", "Limited mission")
        : this.text("regularMission", "Mission");
    const start = timestamp(mission.startAt);
    const end = timestamp(mission.endAt);
    const window =
      start || end
        ? start && end
          ? `${this.date(start)} – ${this.date(end)}`
          : this.date(start || end)
        : "";
    const description = this.name(mission.description);
    const goal = Number(mission.goal || 0);
    return html`
      <section class="mission-group mission-group--entity">
        <header class="mission-group__header">
          <h2>${title}</h2>
          <span>${kind}</span>
          ${window ? html`<small class="mission-group__window">${window}</small>` : nothing}
        </header>
        <ul class="mission-list" role="list">
          <li class="mission-row">
            <span class="mission-row__condition">
              ${description ? html`<small>${description}</small>` : nothing}
              ${goal > 0 ? html`<b>${this.text("goal", "Goal")} · ${goal.toLocaleString(this.locale)}</b>` : nothing}
            </span>
            <span class="mission-row__rewards">
              ${(Array.isArray(mission.rewards) ? mission.rewards : []).map((reward) => this.reward(reward as JsonRecord))}
            </span>
          </li>
        </ul>
      </section>
    `;
  }
  render() {
    if (this.entityId) {
      clearAppBarActions("missions");
    } else {
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
    }
    const groups = this.groups();
    const selected = this.groupKey ? groups.find((group) => group.key === this.groupKey) : undefined;
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
                  ${
                    this.entityId && this.missions[0]
                      ? this.entityView(this.missions[0])
                      : selected
                        ? this.groupView(selected)
                        : html`
                            <ul class="mission-cards" role="list">
                              ${groups.map((group) => this.groupCard(group))}
                            </ul>
                          `
                  }
                `
        }
      </section>
    `;
  }
}
if (!customElements.get("mission-workspace")) customElements.define("mission-workspace", MissionWorkspace);
