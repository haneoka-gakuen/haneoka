// L3 — GEB
// Input: Current Box growth, the editor's opening values and release-bound skill descriptions.
// Output: Live card stats, growth deltas and skill effects beside the existing editing controls.
// Pos: [Map](../L2-2.md); detail preview for member and Snapshot editors.
// Effects/Dependencies: Loads the shared growth catalogue on demand; comparison state stays in the dialog session.
import { html, nothing, type TemplateResult } from "lit";
import { memberStat, snapshotPercent } from "../../lib/card-growth";
import type { GrowthPageData } from "../../lib/growth-catalog";
import type { GrowthState } from "../../lib/growth-comparison";
import type { OwnedMember, OwnedSnap } from "../../lib/team-builder/sync/box-view";
import { accordion } from "../ui/accordion";
import type { TeamBuilder } from "../team-builder";
import type { Catalog } from "./catalog";
import { stripSkillDescriptionMarkup } from "../shared/skill-text";
import { skillDisplay } from "../shared/skill-text";
import { resolveLocalizedText } from "../../lib/localized-text";

interface Resource {
  data?: GrowthPageData;
  error: boolean;
}
interface Session {
  editing: NonNullable<TeamBuilder["editing"]>;
  catalog: Catalog;
  owner: string | null | undefined;
  before: GrowthState;
  expanded: Set<string>;
}
const sessions = new WeakMap<TeamBuilder, Session>();
const resources = new WeakMap<Catalog, Map<string, Resource>>();
const growth = (kind: "members" | "snaps", row: OwnedMember | OwnedSnap | undefined): GrowthState =>
  kind === "members"
    ? {
        level: row?.level ?? null,
        training: (row as OwnedMember)?.awake ?? null,
        awakening: row?.rank ?? null,
        live: (row as OwnedMember)?.skill ?? null,
        gekisou: (row as OwnedMember)?.gekisoSkill ?? null,
      }
    : { level: row?.level ?? null, break: row?.rank ?? null };

function descriptions(host: TeamBuilder): Resource {
  const { kind, cardId } = host.editing!;
  const catalog = host.catalog!;
  const server =
    host.data!.crossServer?.owners[kind === "members" ? "members" : "snapshots"]?.[String(cardId)] ??
    host.data!.identity.server;
  const identity = host.data!.crossServer?.identities[server] ?? host.data!.identity;
  let cache = resources.get(catalog);
  if (!cache) resources.set(catalog, (cache = new Map()));
  const key = JSON.stringify([identity, host.locale]);
  const cached = cache.get(key);
  if (cached) return cached;
  const entry: Resource = { error: false };
  cache.set(key, entry);
  const locale = host.locale;
  void fetch(`/${server}/${locale}/growth-data.json`)
    .then(async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const data: GrowthPageData = await response.json();
      if (
        data.schema !== "haneoka-growth-page-v1" ||
        data.locale !== locale ||
        data.identity.server !== identity.server ||
        data.identity.releaseId !== identity.releaseId ||
        data.identity.sourceId !== identity.sourceId
      )
        throw new Error("growth-data-release");
      entry.data = data;
    })
    .catch(() => {
      entry.error = true;
    })
    .finally(() => {
      if (host.catalog === catalog) host.requestUpdate();
    });
  return entry;
}

export function cardEditorPreview(host: TeamBuilder) {
  const editing = host.editing!;
  const { kind, cardId } = editing;
  const catalog = host.catalog!;
  const master = host.master!;
  const owned = kind === "members" ? host.view!.members.get(cardId) : host.view!.snaps.get(cardId);
  const current = growth(kind, owned);
  let session = sessions.get(host);
  if (
    !session ||
    session.editing !== editing ||
    session.catalog !== catalog ||
    session.owner !== host.snapshot?.owner
  ) {
    session = { editing, catalog, owner: host.snapshot?.owner, before: current, expanded: new Set() };
    sessions.set(host, session);
  }
  const before = session.before;
  const state = session;
  const planning=host.planner.cardById(cardId);
  const resource:Resource = planning?{error:false}:descriptions(host);
  const detail = resource.data?.cards.find(
    (card) => card.id === cardId && card.kind === (kind === "members" ? "member" : "support"),
  );
  const fmt = (value: number, percent = false) =>
    `${new Intl.NumberFormat(host.locale, { maximumFractionDigits: percent ? 2 : 0 }).format(percent ? value / 100 : value)}${percent ? "%" : ""}`;
  const stats = (value: GrowthState): number[] | null => {
    if (kind === "snaps") {
      const card = master.snaps.get(cardId)!;
      const level = value.level == null ? undefined : master.snapLevels.get(card.levelGroup)?.get(value.level);
      return level ? card.statMax.map((max, index) => snapshotPercent(max, level[index]!)) : null;
    }
    const card = master.members.get(cardId)!;
    const level = value.level == null ? undefined : master.memberLevels.get(card.levelGroup)?.get(value.level);
    const training = value.training == null ? undefined : master.memberAwake.get(card.awakeGroup)?.get(value.training);
    const rank = value.awakening == null ? undefined : master.memberRanks.get(card.rankGroup)?.get(value.awakening);
    return level && training && rank
      ? card.statMax.map((max, index) => memberStat(max, level[index]!, training[index]!, rank.rates[index]!))
      : null;
  };
  const priorStats = stats(before),
    currentStats = stats(current);
  const metric = (label: string, previous: number | null, value: number | null, percent = false) => {
    const delta = previous === null || value === null ? null : value - previous;
    return html`
      <div class="tb-editor-stat">
        <dt>${label}</dt>
        <dd class="tb-editor-stat__value">${value === null ? "—" : fmt(value, percent)}</dd>
        <dd class="tb-editor-stat__comparison">
          <span>${host.t("editorPreview.before", "Before")} ${previous === null ? "—" : fmt(previous, percent)}</span>
          <span class=${`tb-editor-stat__delta${delta ? " is-changed" : ""}`}>
            ${delta === null ? "—" : `${delta > 0 ? "+" : ""}${fmt(delta, percent)}`}
          </span>
        </dd>
      </div>
    `;
  };
  const bonus = (value: GrowthState, field: "musicTypeRate" | "musicTagRate" | "typeLinkRate") => {
    if (kind === "members") {
      const card = master.members.get(cardId)!;
      const rank = value.awakening == null ? undefined : master.memberRanks.get(card.rankGroup)?.get(value.awakening);
      return field === "typeLinkRate" ? null : (rank?.[field] ?? null);
    }
    const card = master.snaps.get(cardId)!;
    const rank = value.break == null ? undefined : master.snapRanks.get(card.rankGroup)?.get(value.break);
    return rank?.typeLinkRate ?? null;
  };
  const statistics = html`
    <section class="tb-editor__statistics" aria-labelledby="tb-editor-stats-title">
      <div class="tb-editor__section-heading">
        <h3 id="tb-editor-stats-title" class="detail-section-title">
          ${host.t(kind === "members" ? "editorPreview.stats" : "editorPreview.statBonus", "Parameter")}
        </h3>
      </div>
      <dl class="tb-editor__stat-grid">
        ${kind === "members" ? metric(host.t("editorPreview.total", "Total Power"), priorStats?.reduce((a, b) => a + b, 0) ?? null, currentStats?.reduce((a, b) => a + b, 0) ?? null) : nothing}
        ${["performance", "technique", "visual"].map((key, index) => metric(host.t(`editorPreview.terms.${key}`, ({ performance: "Performance", technique: "Technique", visual: "Visual" } as Record<string, string>)[key]), priorStats?.[index] ?? null, currentStats?.[index] ?? null, kind === "snaps"))}
        ${kind === "snaps" ? metric(host.t("editorPreview.typeLink", "Type Link"), bonus(before, "typeLinkRate"), bonus(current, "typeLinkRate"), true) : nothing}
      </dl>
    </section>
  `;
  const skill = (
    group: "leader" | "live" | "gekisou" | "support" | "gekisouSupport",
    slot = 0,
    controls?: TemplateResult,
  ) => {
    const member = master.members.get(cardId),
      snap = master.snaps.get(cardId);
    const id =
      kind === "members"
        ? group === "leader"
          ? member!.leaderSkillId
          : group === "live"
            ? member!.liveSkillId
            : member!.gekisoSkillId
        : group === "support"
          ? snap!.supportSkillIds[slot]
          : snap!.gekisoSupportSkillIds[slot];
    if (!id) return nothing;
    const sourceGroup = group === "gekisou" ? "gekiso" : group === "gekisouSupport" ? "gekisoSupport" : group;
    const source = catalog.data.skills[sourceGroup]?.[String(id)];
    if(planning){const definition=planning.skills[kind==="members"?(group==="leader"?0:group==="live"?1:2):(group==="support"?slot:slot+2)];if(definition)host.planner.describeSkill(definition);}
    const local=planning&&source?skillDisplay({resolvedSkills:{[group]:source}},catalog.data.skillReference)[0]:undefined;
    const data = detail?.skills.find((skill) => skill.group === group && skill.slot === slot) ?? (local?{name:catalog.text(source?.skillName),levels:(local.levels as {level:number;description:unknown}[]).map(row=>({level:row.level,description:resolveLocalizedText(row.description,host.locale).text}))}:undefined);
    const level = (value: GrowthState) => {
      if (group === "live") return value.live ?? null;
      if (group === "gekisou") return value.gekisou ?? null;
      if (kind === "members")
        return value.awakening == null
          ? null
          : (master.memberRanks.get(member!.rankGroup)?.get(value.awakening)?.leaderSkillLevel ?? null);
      const rank = value.break == null ? undefined : master.snapRanks.get(snap!.rankGroup)?.get(value.break);
      return (group === "support" ? rank?.skillLevels : rank?.gekisoSkillLevels)?.[slot] ?? null;
    };
    const previous = level(before),
      value = level(current),
      key = `${group}-${slot}`;
    const effect = (selected: number | null) =>
      selected === null
        ? host.t("growthUnset", "Not entered")
        : selected === 0
          ? host.t("editorPreview.locked", "Locked")
          : data?.levels.find((level) => level.level === selected)?.description !== undefined
            ? stripSkillDescriptionMarkup(data.levels.find((level) => level.level === selected)!.description)
            : resource.error
              ? "—"
              : host.t("editorPreview.skillsLoading", "Loading skill effects…");
    const changedEffect = () => {
      const text = effect(value),
        prior = effect(previous);
      if (!data || value === previous || previous === null || value === null || text === prior) return text;
      let start = 0,
        end = text.length,
        priorEnd = prior.length;
      while (start < end && start < priorEnd && text[start] === prior[start]) start++;
      while (end > start && priorEnd > start && text[end - 1] === prior[priorEnd - 1]) {
        end--;
        priorEnd--;
      }
      while (start > 0 && /[\d.,%]/u.test(text[start - 1])) start--;
      while (end < text.length && /[\d.,%]/u.test(text[end])) end++;
      // prettier-ignore
      const marked = html`<mark>${text.slice(start, end)}</mark>`;
      return [text.slice(0, start), marked, text.slice(end)];
    };
    const levelLabel = (value: number | null) =>
      value === null ? "—" : value === 0 ? host.t("editorPreview.locked", "Locked") : `Lv.${value}`;
    const label = host.t(
      `editorPreview.terms.${group === "gekisou" ? "gekisouSkill" : group === "gekisouSupport" ? "gekisouSupportSkill" : group === "support" ? "supportSkill" : group === "leader" ? "leaderSkill" : "liveSkill"}`,
      {
        leader: "Leader Skill",
        live: "LIVE Skill",
        gekisou: "GEKISO Skill",
        support: "Support Skill",
        gekisouSupport: "GEKISO Support Skill",
      }[group],
    );
    const currentEffect =
      resource.error && (group === "leader" || (group === "support" && slot === 0)) ? skillsStatus : changedEffect();
    return html`
      <section class="tb-editor-skill">
        <div class="tb-editor-skill__header">
          ${
            source?.icon
              ? html`
                  <img src=${source.icon} alt="" width="32" height="32" />
                `
              : nothing
          }
          <div>
            <span class="tb-editor-skill__kind">${label}</span>
            <h3>${data?.name ?? catalog.text(source?.skillName)}</h3>
          </div>
        </div>
        ${controls ?? nothing}
        <p class="tb-editor-skill__effect tb-editor-skill__effect--current">
          ${data?.levels.map(
            (level) => html`
              <span
                class="tb-editor-skill__measure"
                aria-hidden="true"
                .textContent=${stripSkillDescriptionMarkup(level.description)}
              ></span>
            `,
          )}
          <span class=${resource.error ? "tb-editor-skill__error" : nothing}>${currentEffect}</span>
        </p>
        ${accordion({
          id: `tb-editor-before-${key}`,
          className: "tb-editor-skill__comparison",
          label: html`
            <span class="sr-only">${host.t("editorPreview.originalEffect", "Before this edit")}</span>
            <span class="tb-editor-skill__level">
              ${previous !== value ? `${previous === null ? "—" : `Lv.${previous}`} → ` : ""}${previous !== value && value ? value : levelLabel(value)}
            </span>
          `,
          expanded: state.expanded.has(key),
          onExpandedChange: (expanded) => {
            if (expanded) state.expanded.add(key);
            else state.expanded.delete(key);
            host.requestUpdate();
          },
          content: html`
            <div class="row tb-editor-skill__kind">
              <span>${host.t("editorPreview.originalEffect", "Before this edit")}</span>
              <span>${levelLabel(previous)}</span>
            </div>
            <p class="tb-editor-skill__effect">${effect(previous)}</p>
          `,
        })}
      </section>
    `;
  };
  const bonuses =
    kind === "members"
      ? html`
          <dl class="spec-list tb-editor__bonuses">
            ${(
              [
                ["musicTypeRate", "editorPreview.attributeBonus", "Type Bonus"],
                ["musicTagRate", "editorPreview.tagBonus", "Favorite Song Bonus"],
              ] as const
            ).map(
              ([key, label, fallback]) => html`
                <div>
                  <dt>${host.t(label, fallback)}</dt>
                  <dd>
                    ${bonus(before, key) === null ? "—" : fmt(bonus(before, key)!, true)}
                    <span aria-hidden="true">→</span>
                    <strong>${bonus(current, key) === null ? "—" : fmt(bonus(current, key)!, true)}</strong>
                  </dd>
                </div>
              `,
            )}
          </dl>
        `
      : nothing;
  const skillsStatus = resource.error
    ? html`
        <span class="row">
          <span>${host.t("editorPreview.skillsError", "Could not load skill effects")}</span>
          <button
            class="button button--text"
            type="button"
            @click=${() => {
              const cache = resources.get(catalog);
              for (const [key, entry] of cache ?? []) if (entry === resource) cache!.delete(key);
              host.requestUpdate();
            }}
          >
            ${host.common("common.actions.retry", "Retry")}
          </button>
        </span>
      `
    : nothing;
  return { statistics, skill, bonuses };
}
