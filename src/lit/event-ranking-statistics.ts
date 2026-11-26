// L3 — GEB
// Input: Selected regional event, available leaderboard boards and optional player score.
// Output: Cutoffs, score distribution, observed 24-hour changes and comparable challenge boards.
// Pos: [Map](L2-2.md); data statistics inside event tracking.
// Effects/Dependencies: Reads existing public snapshots lazily, cancels obsolete requests and exposes aggregates to the view.
import { LitElement } from "lit";
import { clientText } from "../i18n/client";
import { navigationDocumentUrl } from "../lib/document-url";
import { RequestScope } from "../lib/request-scope";
import { fetchEventRankingResponse, loadEventMilestoneWindow } from "../lib/event-rank-history-data";
import { analyzeEventCards, type EventCardAnalysis, type EventCardKind } from "../lib/event-card-analysis";
import type { EventRankingDto, GameRecordsRegion, RankingCardCatalog } from "../lib/game-records";
import { resolveLocalizedText } from "../lib/localized-text";
import { cardRarityName } from "../lib/card-rarity";
import { resourcePath } from "../lib/resource-route";
import type { Locale } from "../i18n/locales";
import { localizedAssetUrl } from "./ui/lazy-images";
import {
  eventScorePosition, parseStatsScore, summarizeEventBoard, summarizeEventTrend,
  type EventBoardComparison, type EventBoardStatistics, type EventRankingTrend, type EventSongSurge,
} from "../lib/event-ranking-statistics";
import { renderEventRankingStatistics } from "./views/event-ranking-statistics";

export type EventStatisticsBoard = { value: string; label: string };
type Phase = "loading" | "ready" | "error";
type OptionalPhase = "idle" | Phase;

const DAY = 86_400_000;
const SNAPSHOT_TTL = 30_000;
const SNAPSHOT_TIMEOUT = 20_000;

export class EventRankingStatistics extends LitElement {
  static properties = {
    locale: {}, region: {}, eventId: {}, endAtMs: {}, boards: { attribute: false }, onHistory: { attribute: false }, cardCatalog: { attribute: false },
    board: { state: true }, phase: { state: true }, data: { state: true }, goal: { state: true },
    trendData: { state: true }, trendPhase: { state: true }, surges: { state: true }, surgePhase: { state: true },
    comparison: { state: true }, comparePhase: { state: true },
    expanded: { state: true }, cardAnalysis: { state: true }, cardPhase: { state: true },
  };

  declare locale: string;
  declare region: GameRecordsRegion;
  declare eventId: string;
  declare endAtMs?: number | null;
  declare boards: EventStatisticsBoard[];
  declare onHistory: (board: string) => void;
  declare cardCatalog?: RankingCardCatalog;
  declare private board: string;
  declare private phase: Phase;
  declare private data?: EventBoardStatistics;
  declare private goal: string;
  declare private trendData?: EventRankingTrend;
  declare private trendPhase: OptionalPhase;
  declare private surges: EventSongSurge[];
  declare private surgePhase: OptionalPhase;
  declare private comparison: EventBoardComparison[];
  declare private comparePhase: OptionalPhase;
  declare private expanded: ReadonlySet<string>;
  declare private cardAnalysis?: EventCardAnalysis;
  declare private cardPhase: OptionalPhase;
  private snapshot?: EventRankingDto;
  private lifetime?: AbortController;
  private readonly snapshots = new Map<string, { at: number; promise: Promise<EventRankingDto> }>();
  private readonly primary = new RequestScope();
  private readonly trend = new RequestScope();
  private readonly surge = new RequestScope();
  private readonly compare = new RequestScope();
  private readonly cards = new RequestScope();

  constructor() {
    super();
    this.locale = "en";
    this.boards = [];
    this.board = "";
    this.phase = "loading";
    this.goal = "";
    this.trendPhase = "idle";
    this.surges = [];
    this.surgePhase = "idle";
    this.comparison = [];
    this.comparePhase = "idle";
    this.expanded = new Set();
    this.cardPhase = "idle";
  }

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this.lifetime = new AbortController();
    this.board = navigationDocumentUrl().searchParams.get("statsBoard") ?? "";
    queueMicrotask(() => { if (this.isConnected) void this.refresh(false); });
  }

  disconnectedCallback() {
    this.primary.cancel();
    this.trend.cancel();
    this.surge.cancel();
    this.compare.cancel();
    this.cards.cancel();
    this.lifetime?.abort();
    this.snapshots.clear();
    super.disconnectedCallback();
  }

  private selectedBoard() {
    return this.boards.find((item) => item.value === this.board) ?? this.boards[0];
  }

  private label = (key: string, fallback: string) => clientText(this.locale, `tools.eventTracker.stats.${key}`, fallback);
  private basePath() { return `/api/v2/game/records/${this.region}/events/${this.eventId}`; }

  private readBoard(board: string) {
    const cached = this.snapshots.get(board);
    if (cached && Date.now() - cached.at < SNAPSHOT_TTL) return cached.promise;
    const path = board === "points" ? "latest" : `${board}/latest`;
    const request = new RequestScope();
    const signal = request.begin(this.lifetime?.signal);
    const timeout = window.setTimeout(() => request.cancel(), SNAPSHOT_TIMEOUT);
    const promise = fetchEventRankingResponse(`${this.basePath()}/${path}`, signal)
      .then(async (response) => {
        if (!response.ok) throw new Error(`event-statistics:${response.status}`);
        return await response.json() as EventRankingDto;
      }).catch((error: unknown) => {
        if (this.snapshots.get(board)?.promise === promise) this.snapshots.delete(board);
        throw error;
      }).finally(() => {
        window.clearTimeout(timeout);
        request.cancel();
      });
    this.snapshots.set(board, { at: Date.now(), promise });
    return promise;
  }

  private select(value: string) {
    if (this.selectedBoard()?.value === value) return;
    this.board = value;
    this.goal = "";
    const url = new URL(location.href);
    url.searchParams.set("statsBoard", value);
    history.replaceState(history.state, "", url);
    void this.refresh(false);
  }

  async refresh(force = true) {
    const board = this.selectedBoard();
    if (!board) return;
    if (force) this.snapshots.clear();
    const signal = this.primary.begin();
    this.trend.cancel();
    this.surge.cancel();
    this.compare.cancel();
    this.cards.cancel();
    this.trendPhase = "idle";
    this.comparePhase = "idle";
    this.trendData = undefined;
    this.surges = [];
    this.surgePhase = "idle";
    this.comparison = [];
    this.expanded = new Set();
    this.cardAnalysis = undefined;
    this.cardPhase = "idle";
    this.snapshot = undefined;
    this.data = undefined;
    this.phase = "loading";
    try {
      const snapshot = await this.readBoard(board.value);
      if (!this.primary.current(signal)) return;
      this.snapshot = snapshot;
      this.data = summarizeEventBoard(snapshot);
      this.phase = "ready";
    } catch {
      if (this.primary.current(signal)) this.phase = "error";
    }
  }

  private async readTrend(board: string, data: EventBoardStatistics, signal: AbortSignal) {
    const observed = data.observedAtMs;
    if (!observed) return;
    const closed = this.endAtMs != null && this.endAtMs <= Date.now();
    const target = (closed ? Math.min(this.endAtMs!, observed) : observed) - DAY;
    const observations = await loadEventMilestoneWindow(`${this.basePath()}/${board}/timeline`, target, observed, signal);
    return summarizeEventTrend(data, observations, closed);
  }

  private async loadTrend() {
    const board = this.selectedBoard(), data = this.data;
    if (!board || !data || this.trendPhase === "loading") return;
    const signal = this.trend.begin();
    this.trendPhase = "loading";
    try {
      const trend = await this.readTrend(board.value, data, signal);
      if (!this.trend.current(signal)) return;
      this.trendData = trend;
      this.trendPhase = "ready";
    } catch {
      if (this.trend.current(signal)) this.trendPhase = "error";
    }
  }

  private compareChoices() {
    const selected = this.selectedBoard()?.value ?? "";
    return selected.startsWith("challenges/") ? this.boards.filter((item) => item.value !== selected && item.value.startsWith("challenges/")) : [];
  }

  private async loadSurges() {
    const primary = this.selectedBoard(), data = this.data, trend = this.trendData;
    if (!primary || !data || !trend || this.surgePhase === "loading") return;
    const choices = this.compareChoices(), signal = this.surge.begin();
    this.surgePhase = "loading";
    const project = (label: string, board: EventBoardStatistics, result?: EventRankingTrend): EventSongSurge => ({
      label, cutoff: board.cuts.find(({ rank }) => rank === 100)?.score ?? null,
      change: result?.changes.find(({ rank }) => rank === 100),
      periodHours: result ? (result.toAtMs - result.fromAtMs) / 3_600_000 : undefined,
    });
    const results = await Promise.allSettled(choices.map(async ({ label, value }) => {
      const board = summarizeEventBoard(await this.readBoard(value));
      if (!this.surge.current(signal)) return;
      return project(label, board, await this.readTrend(value, board, signal).catch(() => undefined));
    }));
    if (!this.surge.current(signal)) return;
    this.surges = [project(primary.label, data, trend), ...results.flatMap((entry, index) =>
      entry.status === "fulfilled" && entry.value ? [entry.value] : [{ label: choices[index]!.label, cutoff: null }])];
    this.surgePhase = "ready";
  }

  private async loadCompare() {
    if (this.comparePhase === "loading") return;
    const choices = this.compareChoices(), signal = this.compare.begin();
    this.comparePhase = "loading";
    const results = await Promise.allSettled(choices.map(async (item) => {
      const { observedAtMs, scores, cuts } = summarizeEventBoard(await this.readBoard(item.value));
      return { label: item.label, observedAtMs, scores, cuts };
    }));
    if (!this.compare.current(signal)) return;
    this.comparison = results.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
    this.comparePhase = !this.comparison.length && results.some((entry) => entry.status === "rejected") ? "error" : "ready";
  }

  private async loadCards() {
    const selected = this.selectedBoard(), snapshot = this.snapshot;
    if (!selected?.value.startsWith("challenges/") || !snapshot || this.cardPhase === "loading") return;
    const choices = this.compareChoices(), signal = this.cards.begin();
    this.cardPhase = "loading";
    try {
      this.cardAnalysis = analyzeEventCards({ ...selected, snapshot }, [], []);
      const results = await Promise.allSettled(choices.map(async (item) => ({ ...item, snapshot: await this.readBoard(item.value) })));
      if (!this.cards.current(signal)) return;
      const boards = results.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
      const unavailable = results.flatMap((item, index) => item.status === "rejected" ? [choices[index]!.label] : []);
      this.cardAnalysis = analyzeEventCards({ ...selected, snapshot }, boards, unavailable);
      this.cardPhase = "ready";
    } catch {
      if (this.cards.current(signal)) this.cardPhase = "error";
    }
  }

  private cardInfo = (kind: EventCardKind, id: number) => {
    const card = this.cardCatalog?.[kind][id];
    if (!card) return { label: `#${id}` };
    const name = resolveLocalizedText(card.name, this.locale);
    const color = ["", "red", "blue", "green", "yellow", "purple"][card.cardType ?? 0];
    const characters = (card.characterIds ?? []).flatMap(id => {
      const character = this.cardCatalog?.characters?.[id];
      return character ? [{ id, ...character }] : [];
    });
    return {
      label: name.text || `#${id}`, titleLanguage: name.locale,
      image: card.image ? localizedAssetUrl(card.image, this.locale) : undefined,
      characters, cardType: card.cardType, rarity: card.rarity,
      attributeLabel: color ? clientText(this.locale, `catalog.songs.liveTypes.${color}`, color) : "",
      attributeIcon: card.attributeIcon, rarityIcon: card.rarityIcon, rarityLabel: cardRarityName(card.rarity),
      href: resourcePath({ server: card.server, locale: this.locale as Locale,
        kind: kind === "member" ? "member-cards" : "support-cards", id: String(id) }),
    };
  };

  render() {
    const board = this.selectedBoard()?.value ?? "";
    const score = parseStatsScore(this.goal);
    return renderEventRankingStatistics({
      t: this.label, locale: this.locale, boards: this.boards, board, onBoard: (id) => this.select(id),
      expanded: this.expanded,
      onExpand: (id, open) => {
        const expanded = new Set(this.expanded);
        if (open) expanded.add(id);
        else expanded.delete(id);
        this.expanded = expanded;
      },
      cardPhase: this.cardPhase, cardAnalysis: this.cardAnalysis, cardInfo: this.cardInfo, onLoadCards: () => void this.loadCards(),
      phase: this.phase, data: this.data, goal: this.goal,
      place: this.snapshot && score !== null ? eventScorePosition(this.snapshot, score) : null,
      onGoal: (value) => { this.goal = value; },
      changes: this.trendData?.changes ?? [], trendPhase: this.trendPhase, trendAtMs: this.trendData?.fromAtMs,
      onTrend: () => void this.loadTrend(),
      trend: this.trendData, surges: this.surges, surgePhase: this.surgePhase, onSurges: () => void this.loadSurges(),
      showComparison: this.compareChoices().length > 0, comparePhase: this.comparePhase, comparison: this.comparison,
      onCompare: () => void this.loadCompare(), onRetry: () => void this.refresh(),
      onHistory: () => this.onHistory(board),
    });
  }
}

if (!customElements.get("event-ranking-statistics"))
  customElements.define("event-ranking-statistics", EventRankingStatistics);
