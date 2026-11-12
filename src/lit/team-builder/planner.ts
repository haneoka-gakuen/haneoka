// L3 — GEB
// Input: Public catalogue, local scenario definitions and explicit editor actions.
// Output: Versioned custom cards/events, private preferences and a projected calculation catalogue.
// Pos: [Map](../L2-2.md); local planning controller for the team workspace.
// Effects/Dependencies: Device storage and user-selected JSON files; never syncs fictional ownership.
import type { TeamBuilder } from "../team-builder";
import { dataRows, objectRow } from "../../lib/team-builder/data";
import {
  emptyPlanner,
  nextPlannerId,
  plannerCardFromTemplate,
  plannerEventFromTemplate,
  plannerReferences,
  plannerSkillId,
  plannerSkillOrigin,
  plannerEffectKey,
  rewritePlannerReferences,
  PLANNER_ID_START,
  PLANNER_MAX_SKILL_SECONDS,
  type PlannerCard,
  type PlannerDocument,
  type PlannerEvent,
  type PlannerSkill,
} from "../../lib/team-builder/planner-data";
import { BoxClock, validEntry, type BoxEntry, type BoxValue } from "../../lib/team-builder/sync/box-doc";
import { ownMemberChanges, ownSnapChanges } from "../../lib/team-builder/sync/box-view";
import { maxMemberGrowth, maxSnapGrowth, memberGrowth, snapGrowth } from "../../lib/team-builder/engine/box";
import { downloadBlob } from "../../lib/canvas-capture";

const whole = (value: unknown, min = 0, max = 0x7fffffff): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const statKeys = ["performance", "technique", "visual"] as const;
const families = {
  members: ["leader", "live", "gekiso"],
  snaps: ["support", "support", "gekisoSupport", "gekisoSupport"],
} as const;

export class Planner {
  document = emptyPlanner();
  dialog: "library" | "card" | "event" | null = null;
  libraryScope: "cards" | "events" = "cards";
  eventTab: "basic" | "bonuses" | "rewards" = "basic";
  eventRank = 7;
  card: PlannerCard | null = null;
  event: PlannerEvent | null = null;
  previousId: number | null = null;
  submitted = false;
  error = "";
  expanded = new Set<string>();
  visited = new Set<string>();
  levels = new Map<number, number>();
  private key = "";
  private clock = new BoxClock();
  private skillReads = new Map<string, Promise<Record<string, unknown>>>();
  private skillAttempts = new WeakSet<PlannerSkill>();
  private skillController = new AbortController();
  constructor(readonly host: TeamBuilder) {}
  get source() {
    return this.host.publicData!;
  }
  get cards() {
    return this.document.cards.filter((card) => card.active);
  }
  get events() {
    return this.document.events.filter((event) => event.active);
  }
  get hasDefinitions() {
    return this.document.cards.length > 0 || this.document.events.length > 0;
  }
  cardById(id: number) {
    return this.document.cards.find((card) => card.id === id);
  }
  dispose() {
    this.skillController.abort();
    this.skillController = new AbortController();
    this.skillReads.clear();
    this.skillAttempts = new WeakSet();
  }
  describeSkill(skill: PlannerSkill) {
    if (!skill.templateId || skill.description !== undefined || this.skillAttempts.has(skill)) return;
    this.skillAttempts.add(skill);
    const family = skill.family,
      role = family.replace("gekiso", "gekisou");
    const source = this.source,
      ownerKey = this.key;
    let server = this.source.identity.server,
      originalId = skill.templateId;
    const slotFields = { leader: "leaderSkillId", live: "liveSkillId", gekiso: "gekisoSkillId" } as const;
    for (const [kind, rows] of [
      ["members", this.source.members],
      ["snapshots", this.source.snapshots],
    ] as const) {
      const card = Object.values(rows).find((row) =>
        family in slotFields
          ? "leaderSkillId" in row && row[slotFields[family as keyof typeof slotFields]] === skill.templateId
          : "supportSkillIds" in row &&
            (family === "support" ? row.supportSkillIds : row.gekisoSupportSkillIds).includes(skill.templateId),
      );
      if (!card) continue;
      server = this.source.crossServer?.owners[kind]?.[String(card.id)] ?? server;
      const values = objectRow(card.catalogMetadata?.resolvedSkills)[role];
      const resolved = dataRows(Array.isArray(values) ? values : [values]);
      const slot =
        family in slotFields
          ? 0
          : (family === "support"
              ? (card as import("../../lib/team-builder/data").SnapshotCatalog).supportSkillIds
              : (card as import("../../lib/team-builder/data").SnapshotCatalog).gekisoSupportSkillIds
            ).indexOf(skill.templateId);
      originalId = Number(resolved[slot]?.id ?? originalId);
      break;
    }
    const identity = this.source.crossServer?.identities[server] ?? this.source.identity;
    const resources = {
      leader: "leader-skills",
      live: "skills",
      gekiso: "gekisou-skills",
      support: "support-skills",
      gekisoSupport: "gekisou-support-skills",
    };
    const key = `${server}:${identity.releaseId}:${family}`;
    let pending = this.skillReads.get(key);
    if (!pending) {
      pending = fetch(
        `/api/v1/servers/${server}/${resources[family]}?release=${encodeURIComponent(identity.releaseId)}`,
        { signal: this.skillController.signal },
      ).then(async (response) => {
        if (!response.ok) throw new Error("planner-skill-description");
        return objectRow(await response.json());
      });
      this.skillReads.set(key, pending);
    }
    void pending
      .then((rows) => {
        if (this.source !== source || this.key !== ownerKey) return;
        const row = objectRow(rows[String(originalId)]);
        if (this.card?.skills.includes(skill)) {
          skill.description = row.description ?? [];
        }
        let persisted = false;
        for (const card of this.document.cards)
          card.skills.forEach((definition, slot) => {
            if (
              definition.family !== family ||
              definition.templateId !== skill.templateId ||
              definition.description !== undefined
            )
              return;
            definition.description = row.description ?? [];
            persisted = true;
            const projected = this.host.data?.skills[family]?.[String(card.id + slot)];
            if (projected) projected.description = definition.description;
          });
        if (persisted) this.persist();
        this.changed();
      })
      .catch(() => {
        if (this.card?.skills.includes(skill)) {
          skill.description = [];
          this.changed();
        }
      });
  }
  private changed() {
    this.host.requestUpdate();
  }
  restore(owner: string | null | undefined) {
    const key = `haneoka.planner.v1.${this.host.server}.${owner || "local"}`;
    if (this.key === key) return;
    this.key = key;
    this.close();
    this.document = emptyPlanner();
    try {
      const text = localStorage.getItem(key);
      if (text) this.document = this.parse(JSON.parse(text));
    } catch {
      this.error = this.host.t("planner.loadFailed", "Planning data could not be loaded");
    }
    this.host.applyPlanningData();
    this.restoreCards();
  }
  private persist(document = this.document) {
    try {
      localStorage.setItem(this.key, JSON.stringify(document));
      return true;
    } catch {
      this.error = this.host.t("planner.saveFailed", "Planning data could not be saved");
      this.changed();
      return false;
    }
  }
  merge(entries: Readonly<Record<string, BoxEntry>>) {
    return { ...entries, ...this.document.entries };
  }
  owns(key: string, value: BoxValue) {
    return (
      Object.hasOwn(this.document.entries, key) ||
      (/^(?:pref\.|team\.)/u.test(key) &&
        plannerReferences(value, new Set([...this.document.cards, ...this.document.events].map((row) => row.id))))
    );
  }
  write(changes: { key: string; value: BoxValue }[]) {
    if (!changes.length) return true;
    const next = { ...this.document, entries: { ...this.document.entries } };
    for (const { key, value } of changes) next.entries[key] = { v: value, t: this.clock.next(), c: "planner", r: 0 };
    if (!this.persist(next)) return false;
    this.document = next;
    return true;
  }
  saveGrowth(kind: PlannerCard["kind"], id: number) {
    const card = this.cardById(id);
    if (!card || !this.host.temporary.has(kind, id)) return;
    const entries = this.host.temporary.changes(kind, id);
    const at = (field: string) =>
      entries.find((row) => row.key.endsWith(`.${field}`))?.value as number | null | undefined;
    card.growth = {
      level: at("lvl"),
      rank: at("rnk"),
      ...(kind === "members" ? { awake: at("awk"), liveSkillLevel: at("sk"), gekisoSkillLevel: at("gsk") } : {}),
    };
    this.persist();
  }
  restoreCards(cards = this.cards) {
    const { host } = this;
    if (!host.master) return;
    for (const card of cards) {
      const id = card.id;
      if (host.temporary.has(card.kind, id)) continue;
      if (card.kind === "members") {
        const member = host.master.members.get(id)!;
        const growth = memberGrowth(
          host.master,
          member,
          { ...maxMemberGrowth(host.master, member), ...card.growth, key: `m${id}`, cardId: id },
          "max",
        );
        host.temporary.add(
          "members",
          id,
          ownMemberChanges(id, {
            use: true,
            lock: false,
            level: growth.level!,
            rank: growth.rank!,
            awake: growth.awake!,
            skill: growth.liveSkillLevel!,
            gekisoSkill: growth.gekisoSkillLevel!,
          }),
        );
      } else {
        const snap = host.master.snaps.get(id)!;
        const growth = snapGrowth(
          host.master,
          snap,
          { ...maxSnapGrowth(host.master, snap), ...card.growth, key: `s${id}`, cardId: id },
          "max",
        );
        host.temporary.add(
          "snaps",
          id,
          ownSnapChanges(id, { use: true, lock: false, level: growth.level!, rank: growth.rank! }),
        );
      }
    }
    host.refreshTemporaryView();
  }
  open(scope: "cards" | "events" = "cards") {
    if (scope === "events" && !["build", "pt"].includes(this.host.tab)) this.host.setTab("build");
    this.libraryScope = scope;
    this.dialog = "library";
    this.card = null;
    this.event = null;
    this.submitted = false;
    this.error = "";
    this.changed();
  }
  close() {
    this.dialog = null;
    this.card = null;
    this.event = null;
    this.submitted = false;
    this.expanded.clear();
    this.visited.clear();
    this.changed();
  }
  editCard(kind: PlannerCard["kind"], id?: number) {
    this.event = null;
    this.previousId = id ?? null;
    const existing = id === undefined ? undefined : this.cardById(id);
    const template = Object.keys(kind === "members" ? this.source.members : this.source.snapshots).map(Number)[0]!;
    this.card = existing
      ? structuredClone(existing)
      : plannerCardFromTemplate(this.source, this.document, kind, template, "");
    this.dialog = "card";
    this.submitted = false;
    this.error = "";
    this.levels.clear();
    this.expanded.clear();
    this.visited.clear();
    this.changed();
  }
  editEvent(id?: number, templateId: number | null = null) {
    if (!["build", "pt"].includes(this.host.tab)) this.host.setTab("build");
    this.eventTab = "basic";
    this.card = null;
    this.previousId = id ?? null;
    const existing = this.document.events.find((event) => event.id === (id ?? templateId));
    this.event = existing
      ? structuredClone(existing)
      : plannerEventFromTemplate(this.source, this.host.master!, this.document, templateId, "");
    this.dialog = "event";
    this.submitted = false;
    this.error = "";
    this.expanded.clear();
    this.visited.clear();
    this.changed();
  }
  issues(): string[] {
    if (this.card) {
      const c = this.card;
      return [
        !c.name.trim() && "name",
        !c.characterIds.length && "characters",
        !statKeys.every((key) => whole(c.stats[key])) && "stats",
        c.skills.some((skill) =>
          Object.values(skill.effects).some(
            (effect) =>
              (effect.value !== undefined && !whole(effect.value, -0x80000000)) ||
              (effect.maximum !== undefined && !whole(effect.maximum, -0x80000000)) ||
              (effect.seconds !== undefined &&
                (!finite(effect.seconds) || effect.seconds < 0 || effect.seconds > PLANNER_MAX_SKILL_SECONDS)),
          ),
        ) && "skills",
      ].filter((key): key is string => !!key);
    }
    if (this.event) {
      const e = this.event;
      const ranks = [...e.rules.normalRanks, ...e.rules.challengeRanks];
      return [
        !e.name.trim() && "name",
        ((e.startAt !== null && !whole(e.startAt, 0, Number.MAX_SAFE_INTEGER)) ||
          (e.endAt !== null && !whole(e.endAt, 0, Number.MAX_SAFE_INTEGER)) ||
          (e.startAt !== null && e.endAt !== null && e.endAt <= e.startAt)) &&
          "dates",
        ![...e.livePoints, ...e.challengePoints, ...e.rules.liveChallengePoints].every((row) => whole(row.value)) &&
          "rewards",
        ![...e.liveRewards, ...e.challengeRewards].every(
          (row) =>
            whole(row.count) &&
            whole(row.resourceType, 1) &&
            whole(row.resourceId, 1) &&
            whole(row.group) &&
            whole(row.probability, 0, 10000),
        ) && "rewards",
        ![...e.rules.boosts, ...e.rules.challengeBoosts].every(
          (row) => whole(row.consumed) && whole(row.eventPointRate, 1) && whole(row.rewardRate, 1),
        ) && "boosts",
        !ranks.every((row) => whole(row.required) && whole(row.battleRequired)) && "ranks",
        e.effects.some((row) => row.perRank.some((value) => !whole(value))) && "bonuses",
      ].filter((key): key is string => !!key);
    }
    return [];
  }
  save() {
    this.submitted = true;
    if (this.issues().length) {
      this.changed();
      return;
    }
    const oldId = this.previousId,
      id = nextPlannerId(this.document);
    const references = new Map<number, number>();
    const previous = oldId === null ? undefined : this.cardById(oldId);
    if (previous && this.host.temporary.has(previous.kind, oldId!)) this.saveGrowth(previous.kind, previous.id);
    const next = structuredClone(this.document);
    if (this.card) {
      const old = next.cards.find((card) => card.id === oldId);
      if (old) old.active = false;
      next.cards.push({ ...structuredClone(this.card), id, growth: old?.growth ?? this.card.growth, active: true });
      if (oldId !== null) {
        references.set(oldId, id);
        for (const original of [...next.events].filter(
          (event) =>
            event.active && event.effects.some((row) => row.memberCardId === oldId || row.supportCardId === oldId),
        )) {
          const eventId = nextPlannerId(next),
            event = rewritePlannerReferences(
              structuredClone(original),
              new Map([
                [oldId, id],
                [original.id, eventId],
              ]),
            );
          original.active = false;
          event.id = eventId;
          event.active = true;
          next.events.push(event);
          references.set(original.id, eventId);
        }
        for (const [key, entry] of Object.entries(next.entries))
          if (key.startsWith("pref.")) entry.v = rewritePlannerReferences(entry.v, references);
      }
    }
    if (this.event) {
      const old = next.events.find((event) => event.id === oldId);
      if (old) old.active = false;
      if (oldId !== null) references.set(oldId, id);
      const event = { ...structuredClone(this.event), id, active: true };
      for (const row of [...event.liveRewards, ...event.challengeRewards])
        if (row.resourceType === 1 && [this.event.id, oldId].includes(row.resourceId)) row.resourceId = id;
      if (event.itemId === oldId) event.itemId = 0;
      next.events.push(event);
    }
    if (!this.persist(next)) return;
    this.document = next;
    if (oldId !== null) for (const kind of ["members", "snaps"] as const) this.host.temporary.remove(kind, oldId);
    this.host.applyPlanningData();
    this.restoreCards();
    if (references.size) this.replaceReferences(references);
    if (this.event) {
      if (!["build", "pt"].includes(this.host.tab)) this.host.setTab("build");
      this.host.updateSettings({ eventId: id, manualEventEnabled: false });
    }
    this.close();
  }
  private replaceReferences(ids: ReadonlyMap<number, number>) {
    const replace = <T>(value: T): T => rewritePlannerReferences(value, ids);
    const { host } = this;
    host.manual = replace(host.manual);
    const settings = replace(host.settings);
    if (JSON.stringify(settings) !== JSON.stringify(host.settings)) {
      host.settings = settings;
      const { required: _required, ...stored } = settings;
      host.write([{ key: "pref.build", value: stored as unknown as BoxValue }]);
    }
    const arena = replace(host.arena.draft.build);
    if (JSON.stringify(arena) !== JSON.stringify(host.arena.draft.build)) host.arena.updateBuild(arena);
  }
  deactivate(kind: "card" | "event", id: number) {
    if (kind === "card") {
      this.disableCards([id]);
      return;
    }
    const next = structuredClone(this.document);
    const row = next.events.find((row) => row.id === id)!;
    row.active = false;
    if (!this.persist(next)) return;
    this.document = next;
    this.host.applyPlanningData();
    this.host.refreshTemporaryView();
    if (kind === "event" && this.host.settings.eventId === id) this.host.updateSettings({ eventId: null });
    this.changed();
  }
  disableCards(ids: number[]) {
    const removed = new Set(ids),
      next = structuredClone(this.document);
    for (const card of next.cards) if (removed.has(card.id)) card.active = false;
    if (!this.persist(next)) return false;
    this.document = next;
    for (const id of removed) {
      const card = this.cardById(id);
      if (card) this.host.temporary.remove(card.kind, id);
    }
    this.host.applyPlanningData();
    this.host.refreshTemporaryView();
    const s = this.host.searchSettings;
    this.host.updateSettings({
      leader: s.leader !== null && removed.has(s.leader) ? null : s.leader,
      bindings: s.bindings.filter(([member, snap]) => !removed.has(member) && !(snap !== null && removed.has(snap))),
      required: {
        members: s.required.members.filter((id) => !removed.has(id)),
        snaps: s.required.snaps.filter((id) => !removed.has(id)),
      },
    });
    return true;
  }
  async export() {
    await downloadBlob(
      new Blob([JSON.stringify(this.document, null, 2)], { type: "application/json" }),
      "haneoka-planner.json",
    );
  }
  import() {
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "application/json,.json";
    file.onchange = async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      try {
        if (selected.size > 8 * 1024 * 1024) throw new Error("planner-size");
        const imported = this.parse(JSON.parse(await selected.text()));
        const next = structuredClone(this.document),
          mapping = new Map<number, number>();
        let id = nextPlannerId(next);
        for (const row of [...imported.cards, ...imported.events]) {
          mapping.set(row.id, id);
          id += 1000;
        }
        const incoming = rewritePlannerReferences(imported, mapping);
        incoming.cards.forEach((card, index) => (card.id = mapping.get(imported.cards[index]!.id)!));
        incoming.events.forEach((event, index) => (event.id = mapping.get(imported.events[index]!.id)!));
        for (const card of next.cards) card.active = false;
        for (const event of next.events) event.active = false;
        next.cards.push(...incoming.cards);
        next.events.push(...incoming.events);
        for (const [key, entry] of Object.entries(incoming.entries)) next.entries[key] = entry;
        if (!this.persist(next)) return;
        for (const card of this.cards) this.host.temporary.remove(card.kind, card.id);
        this.document = next;
        this.host.applyPlanningData();
        this.restoreCards();
        this.host.restorePlanningPreferences();
        this.error = "";
        this.changed();
      } catch {
        this.error = this.host.t("planner.invalidFile", "Invalid planning data");
        this.changed();
      }
    };
    file.click();
  }
  private parse(value: unknown): PlannerDocument {
    const doc = objectRow(value);
    if (doc.schema !== "haneoka-planner-v1" || !Array.isArray(doc.cards) || !Array.isArray(doc.events))
      throw new Error("planner-document");
    const ids = new Set<number>();
    for (const entry of [...doc.cards, ...doc.events]) {
      const id = entry?.id;
      if (!whole(id, PLANNER_ID_START, 2_147_482_000) || id % 1000 || ids.has(id)) throw new Error("planner-id");
      ids.add(id);
    }
    for (const card of doc.cards as PlannerCard[]) {
      if (
        !["members", "snaps"].includes(card.kind) ||
        typeof card.name !== "string" ||
        typeof card.active !== "boolean" ||
        ![1, 2, 3, 4, 5].includes(card.attribute) ||
        ![2, 3, 4, 10, 20].includes(card.rarity) ||
        !statKeys.every((key) => whole(card.stats?.[key])) ||
        !Array.isArray(card.characterIds) ||
        card.characterIds.length < 1 ||
        card.characterIds.length > (card.kind === "members" ? 1 : 5) ||
        card.characterIds.some((id) => !this.source.characters[id])
      )
        throw new Error("planner-card");
      const rows = card.kind === "members" ? this.source.members : this.source.snapshots;
      if (
        !rows[card.templateId] ||
        !rows[card.materialTemplateId] ||
        !Array.isArray(card.skills) ||
        card.skills.length !== (card.kind === "members" ? 3 : 4)
      )
        throw new Error("planner-template");
      for (const [slot, skill] of card.skills.entries()) {
        if (!skill || skill.family !== families[card.kind][slot]) throw new Error("planner-skill-family");
        if (
          skill.origin &&
          (skill.origin.kind !== card.kind ||
            !whole(skill.origin.cardId, 1) ||
            !whole(skill.origin.slot, 0, card.kind === "members" ? 0 : 1))
        )
          throw new Error("planner-skill-origin");
        skill.templateId = plannerSkillId(this.source, skill);
        skill.origin ??= plannerSkillOrigin(this.source, skill.family, skill.templateId);
        if (
          !whole(skill.templateId) ||
          (skill.templateId && !this.source.skills[skill.family]?.[skill.templateId]) ||
          typeof skill.name !== "string" ||
          !skill.effects ||
          Array.isArray(skill.effects)
        )
          throw new Error("planner-skill");
        const allowed = new Set(
          dataRows(this.source.skills[skill.family]?.[skill.templateId]?.effects).map(plannerEffectKey),
        );
        for (const [key, effect] of Object.entries(skill.effects))
          if (
            !allowed.has(key) ||
            !effect ||
            (effect.value !== undefined && !whole(effect.value, -0x80000000)) ||
            (effect.maximum !== undefined && !whole(effect.maximum, -0x80000000)) ||
            (effect.seconds !== undefined &&
              (!finite(effect.seconds) || effect.seconds < 0 || effect.seconds > PLANNER_MAX_SKILL_SECONDS))
          )
            throw new Error("planner-effect");
      }
    }
    const current = this.event;
    try {
      for (const event of doc.events as PlannerEvent[]) {
        if (
          typeof event.name !== "string" ||
          typeof event.active !== "boolean" ||
          !whole(event.eventType) ||
          !whole(event.itemId) ||
          !Array.isArray(event.challenges) ||
          event.challenges.some((row) => !this.source.songs[row.songId] || ![1, 2, 3, 4, 5, 99].includes(row.attribute))
        )
          throw new Error("planner-event");
        for (const key of ["effects", "livePoints", "challengePoints", "liveRewards", "challengeRewards"] as const)
          if (!Array.isArray(event[key])) throw new Error("planner-event-table");
        if (
          !event.rules ||
          !["normalSongs", "liveChallengePoints", "boosts", "challengeBoosts", "normalRanks", "challengeRanks"].every(
            (key) => Array.isArray(event.rules[key as keyof typeof event.rules]),
          )
        )
          throw new Error("planner-event-rules");
        this.event = event;
        if (this.issues().length) throw new Error("planner-event-value");
      }
    } finally {
      this.event = current;
    }
    const entries = objectRow(doc.entries) as Record<string, BoxEntry>;
    for (const [key, entry] of Object.entries(entries))
      if (
        !/^(pref\.|team\.)/u.test(key) ||
        !entry ||
        !whole(entry.t, 0, Number.MAX_SAFE_INTEGER) ||
        typeof entry.c !== "string" ||
        !whole(entry.r) ||
        !validEntry(key, entry.v)
      )
        throw new Error("planner-entry");
    return {
      schema: "haneoka-planner-v1",
      cards: doc.cards as PlannerCard[],
      events: doc.events as PlannerEvent[],
      entries,
    };
  }
}
