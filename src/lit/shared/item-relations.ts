import { html, nothing, type TemplateResult } from "lit";
import { clientText } from "../../i18n/client";
import { resourceKindForCollection, type ResourceKind } from "../../lib/resource-route";
import type { ItemRelations, ItemRelation, ItemOccurrence } from "../../server/item-relations";
import { renderDetailSectionHeading } from "./detail-section-heading";
import { accordion } from "../ui/accordion";
import { icon } from "../ui/icon";
import "../../styles/item-relations.css";

/**
 * An item's place in the economy: where it comes from and what consumes it.
 *
 * Sources are grouped by kind (missions, shop, …) in the detail pane's
 * folds. Each source is a detail-object row — artwork, linked name, its
 * conditions as supporting text, the quantity trailing — so a mission
 * reward reads exactly like a reward on the mission itself. Upgrade costs
 * are tables shared by many cards; each distinct table is shown once,
 * followed by the cards that use it.
 */
export interface ItemRelationsController {
  settings: { locale: string };
  localized(value: unknown): string;
  release(value: unknown): string;
  relatedEntityHref(kind: ResourceKind, id: string): string;
  requestUpdate(): void;
  dataServer(): string;
  itemKey(item: Record<string, unknown>): string;
  selected?: Record<string, unknown> | null;
  itemRelationFoldState?: { scope: string; expanded: Map<string, boolean> };
}

const SOURCE_LABELS: Record<string, string> = {
  missions: "navigation.missions",
  events: "navigation.events",
  "login-campaigns": "navigation.loginCampaigns",
  passes: "navigation.systemNavPasses",
  shop: "navigation.shop",
  exchange: "navigation.exchange",
  circle: "navigation.circle",
  songs: "navigation.songs",
  cards: "navigation.memberCards",
  "support-cards": "navigation.supportCards",
  "band-items": "navigation.bandItems",
};
const SOURCE_ORDER = Object.keys(SOURCE_LABELS);
const PURPOSE_LABELS: Record<string, string> = {
  training: "catalog.cards.fields.training",
  awakening: "catalog.cards.fields.rankUp",
  live: "catalog.cards.fields.liveSkill",
  gekisou: "catalog.cards.fields.gekisouSkill",
  level: "navigation.bandItems",
  exchange: "navigation.exchange",
};
const PURPOSE_ORDER = Object.keys(PURPOSE_LABELS);
const RULE_LABELS: Record<string, string> = {
  MasterLiveFreeReward: "catalog.items.ruleSolo",
  MasterBattleLiveReward: "catalog.items.ruleMulti",
  MasterGekisouLiveRankReward: "catalog.items.ruleGekisou",
  MasterLiveStamp: "catalog.items.ruleStamp",
  MasterInvitationReward: "catalog.items.ruleInvite",
};
const SCORE_RANKS = ["", "E", "D", "C", "B", "A", "S", "SS"];
const DIFFICULTIES = ["EASY", "NORMAL", "HARD", "EXPERT"];

function sourceIcon(resource: string): TemplateResult {
  switch (resource) {
    case "missions":
      return icon("fact_check", 24);
    case "events":
      return icon("event", 24);
    case "login-campaigns":
      return icon("event_available", 24);
    case "passes":
      return icon("workspace_premium", 24);
    case "shop":
      return icon("storefront", 24);
    case "exchange":
      return icon("swap_horiz", 24);
    case "circle":
      return icon("groups", 24);
    case "songs":
      return icon("music_note", 24);
    default:
      return icon("redeem", 24);
  }
}

export function renderItemRelations(c: ItemRelationsController, data: ItemRelations) {
  const locale = c.settings.locale;
  const t = (key: string, fallback: string, params?: Record<string, string | number>) =>
    clientText(locale, key, fallback, params);
  const sourceLabel = (resource: string) =>
    SOURCE_LABELS[resource] ? t(SOURCE_LABELS[resource]!, resource) : resource;
  const number = (value: number) => value.toLocaleString(locale);
  const quantity = (count: number | null) =>
    count === null ? t("common.states.unavailable", "Unavailable") : `×${number(count)}`;
  const firstTimestamp = (raw: unknown) => {
    const value = Number(Array.isArray(raw) ? raw.find((entry) => Number(entry) > 0) : raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };

  /** The conditions that distinguish one occurrence, as reader-facing phrases. */
  const conditions = (row: ItemOccurrence): string[] => {
    const value = row.conditions;
    const phrases: string[] = [];
    // A window is only worth stating when it closes; every permanent source
    // opened at launch, so a bare start date is noise.
    if (firstTimestamp(value.endAt)) {
      const start = c.release(value.startAt);
      const end = c.release(value.endAt);
      phrases.push(start ? `${start} – ${end}` : `${t("catalog.systems.common.ends", "Ends")} ${end}`);
    }
    if (value.day !== undefined) phrases.push(t("catalog.items.day", "Day {0}", { 0: String(value.day) }));
    if (value.level !== undefined) phrases.push(t("catalog.items.level", "Level {0}", { 0: String(value.level) }));
    if (value.rank !== undefined && value.minRank === undefined)
      phrases.push(t("catalog.items.level", "Level {0}", { 0: String(value.rank) }));
    if (value.minRank !== undefined || value.maxRank !== undefined)
      phrases.push(
        t("catalog.items.rankRange", "Rank {0}–{1}", {
          0: String(value.minRank ?? value.rank ?? ""),
          1: String(value.maxRank ?? value.minRank ?? ""),
        }),
      );
    const points = value.points ?? value.point;
    if (points !== undefined && points !== null)
      phrases.push(t("catalog.systems.common.points", "{points} points", { points: number(Number(points)) }));
    if (value.premium === true) phrases.push(t("catalog.items.premium", "Premium"));
    if (value.difficulty !== undefined) {
      const raw = value.difficulty;
      phrases.push(typeof raw === "number" ? DIFFICULTIES[raw] || String(raw) : String(raw).toUpperCase());
    }
    if (value.scoreRank !== undefined)
      phrases.push(
        t("catalog.items.scoreRank", "Score rank {0}", {
          0: SCORE_RANKS[Number(value.scoreRank)] || String(value.scoreRank),
        }),
      );
    if (value.probabilityBp !== undefined)
      phrases.push(
        t("catalog.items.chance", "Chance {0}%", {
          0: (Number(value.probabilityBp) / 100).toLocaleString(locale, { maximumFractionDigits: 2 }),
        }),
      );
    if (value.comboRateType !== undefined)
      phrases.push(`Combo ${[25, 50, 75, 100][Number(value.comboRateType)] ?? value.comboRateType}%`);
    if (value.currency !== undefined && value.cost !== undefined)
      phrases.push(`${c.localized(value.currency)} ×${number(Number(value.cost))}`);
    if (value.reward !== undefined) {
      const reward = c.localized(value.reward);
      if (reward) phrases.push(reward);
    }
    if (typeof value.limit === "number" && value.limit > 0)
      phrases.push(t("catalog.items.limit", "Limit {0}", { 0: number(value.limit) }));
    return phrases;
  };

  const scope = JSON.stringify([c.dataServer(), "item-relations", c.itemKey(c.selected || {})]);
  const state =
    c.itemRelationFoldState?.scope === scope
      ? c.itemRelationFoldState
      : { scope, expanded: new Map<string, boolean>() };
  c.itemRelationFoldState = state;
  const group = (key: string, title: string, count: number, content: unknown, open: boolean) =>
    accordion({
      id: `item-relations-${encodeURIComponent(scope)}-${key}`,
      label: title,
      metadata: html`
        <span class="detail-section-title__count">${number(count)}</span>
      `,
      expanded: state.expanded.get(key) ?? open,
      onExpandedChange: (expanded) => {
        state.expanded.set(key, expanded);
        c.requestUpdate();
      },
      headingLevel: 3,
      className: "detail-fold",
      content: html`
        <div class="detail-fold__body">${content}</div>
      `,
    });

  const entityTitle = (entry: ItemRelation) =>
    c.localized(entry.entity.name) || `${sourceLabel(entry.entity.resource)} ${entry.entity.id}`;
  const entityHref = (entry: ItemRelation) => {
    const kind = resourceKindForCollection(entry.entity.resource);
    return kind ? c.relatedEntityHref(kind, entry.entity.id) : "";
  };
  const artwork = (entry: ItemRelation) => {
    const image = typeof entry.entity.image === "string" ? entry.entity.image : "";
    return image
      ? html`
          <img src=${image} alt="" loading="lazy" decoding="async" />
        `
      : html`
          <span class="item-relation__icon">${sourceIcon(entry.entity.resource)}</span>
        `;
  };

  /** One source: a reward row, or one row per alternative when it has several. */
  const sourceRow = (entry: ItemRelation) => {
    const occurrences = entry.occurrences;
    const single = occurrences.length === 1 ? occurrences[0]! : undefined;
    const supporting = single ? conditions(single).join(" · ") : "";
    const body = html`
      ${artwork(entry)}
      <span>
        ${entityTitle(entry)}
        ${
          supporting
            ? html`
                <small class="detail-copy">${supporting}</small>
              `
            : nothing
        }
        ${
          single
            ? nothing
            : html`
                <span class="item-relation__alternatives">
                  ${occurrences.map(
                  (row) => html`
                    <span class="item-relation__alternative">
                      <span>${conditions(row).join(" · ") || "—"}</span>
                      <strong>${quantity(row.count)}</strong>
                    </span>
                  `,
                )}
                </span>
              `
        }
      </span>
      ${
        single
          ? html`
              <strong>${quantity(single.count)}</strong>
            `
          : nothing
      }
    `;
    const href = entityHref(entry);
    return html`
      <li>
        ${
        href
          ? html`
              <a class="detail-object" href=${href}>${body}</a>
            `
          : html`
              <div class="detail-object">${body}</div>
            `
      }
      </li>
    `;
  };

  /** Upgrade costs: each distinct step table once, then every entity using it. */
  const costTables = (entries: ItemRelation[]) => {
    const tables = new Map<string, { steps: ItemOccurrence[]; entries: ItemRelation[] }>();
    for (const entry of entries) {
      const steps = [...entry.occurrences].sort((a, b) => Number(a.conditions.to) - Number(b.conditions.to));
      const key = JSON.stringify(steps.map((step) => [step.count, step.conditions.from, step.conditions.to]));
      const table = tables.get(key) ?? { steps, entries: [] };
      table.entries.push(entry);
      tables.set(key, table);
    }
    return html`
      ${[...tables.values()].map(({ steps, entries: users }) => {
        const known = steps.every((step) => step.count !== null);
        const total = steps.reduce((sum, step) => sum + (step.count ?? 0), 0);
        return html`
          <div class="item-cost-table">
            <ol class="item-cost-table__steps" role="list">
              ${steps.map(
              (step) => html`
                <li>
                  <span>${String(step.conditions.from)} → ${String(step.conditions.to)}</span>
                  <strong>${quantity(step.count)}</strong>
                </li>
              `,
            )}
            </ol>
            ${
            steps.length > 1 && known
              ? html`
                  <p class="item-cost-table__total">
                    ${t("common.fields.total", "Total")}
                    <strong>×${number(total)}</strong>
                  </p>
                `
              : nothing
          }
            <ul class="item-cost-table__users" role="list" aria-label=${t("navigation.cards", "Cards")}>
              ${users.map((entry) => {
              const href = entityHref(entry);
              const image = typeof entry.entity.image === "string" ? entry.entity.image : "";
              const content = html`
                ${
                  image
                    ? html`
                        <img src=${image} alt="" loading="lazy" decoding="async" />
                      `
                    : nothing
                }${entityTitle(entry)}
              `;
              return html`
                <li>
                  ${
                    href
                      ? html`
                          <a href=${href}>${content}</a>
                        `
                      : html`
                          <span>${content}</span>
                        `
                  }
                </li>
              `;
            })}
            </ul>
          </div>
        `;
      })}
    `;
  };

  const byKey = <T>(rows: T[], key: (row: T) => string, order: string[]) => {
    const groups = new Map<string, T[]>();
    for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
    return [...groups].sort(
      ([left], [right]) =>
        (order.indexOf(left) + 1 || order.length + 1) - (order.indexOf(right) + 1 || order.length + 1),
    );
  };
  const acquisitionGroups = byKey(data.acquisitions, (entry) => entry.entity.resource, SOURCE_ORDER);
  const useGroups = byKey(data.uses, (entry) => entry.purpose, PURPOSE_ORDER);
  // Short pages open every group; long ones keep the outline readable.
  const openAll = acquisitionGroups.length + useGroups.length + data.rules.length <= 3;
  const unavailable = data.coverage.filter((source) => !source.available);
  return html`
    ${
      data.acquisitions.length || data.rules.length
        ? html`
            <section class="detail-section item-relations">
              ${renderDetailSectionHeading(t("catalog.items.acquisition", "Acquisition"), "rewards", {
              count: data.acquisitions.length,
            })}
              ${acquisitionGroups.map(([resource, entries], index) =>
              group(
                `acquisition-${resource}`,
                sourceLabel(resource),
                entries.length,
                html`
                  <ul class="detail-object-list" role="list">
                    ${entries.map(sourceRow)}
                  </ul>
                `,
                openAll || index === 0 || entries.length <= 5,
              ),
            )}
              ${data.rules.map((rule) =>
              group(
                `rule-${rule.source}`,
                RULE_LABELS[rule.source] ? t(RULE_LABELS[rule.source]!, rule.source) : rule.source,
                rule.occurrences.length,
                html`
                  <p class="detail-copy">
                    ${t("catalog.items.baseRewardsHint", "Base quantities; performance multipliers and game bonuses determine the final reward.")}
                  </p>
                  <div class="table-scroll">
                    <table class="data-table item-rule-table">
                      <thead>
                        <tr>
                          <th scope="col">${t("catalog.items.conditionRewardGroup", "Reward group")}</th>
                          <th scope="col">${t("catalog.fields.conditions", "Conditions")}</th>
                          <th scope="col" class="is-numeric">${t("common.fields.value", "Value")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${rule.occurrences.map((row) => {
                          const { group: rewardGroup, ...rest } = row.conditions;
                          return html`
                            <tr>
                              <td>${rewardGroup === undefined ? "—" : String(rewardGroup)}</td>
                              <td>${conditions({ ...row, conditions: rest }).join(" · ") || "—"}</td>
                              <td class="is-numeric">${quantity(row.count)}</td>
                            </tr>
                          `;
                        })}
                      </tbody>
                    </table>
                  </div>
                `,
                openAll,
              ),
            )}
            </section>
          `
        : nothing
    }
    ${
      data.uses.length
        ? html`
            <section class="detail-section item-relations">
              ${renderDetailSectionHeading(t("catalog.items.usage", "Uses"), "effects", { count: data.uses.length })}
              ${useGroups.map(([purpose, entries], index) =>
              group(
                `use-${purpose}`,
                PURPOSE_LABELS[purpose] ? t(PURPOSE_LABELS[purpose]!, purpose) : purpose,
                entries.length,
                purpose === "exchange"
                  ? html`
                      <ul class="detail-object-list" role="list">
                        ${entries.map(sourceRow)}
                      </ul>
                    `
                  : costTables(entries),
                openAll || index === 0 || entries.length <= 5,
              ),
            )}
            </section>
          `
        : nothing
    }
    ${
      unavailable.length
        ? html`
            <p class="detail-section detail-copy">
              ${t("common.states.unavailable", "Unavailable")}:
              ${unavailable.map((source) => sourceLabel(source.resource)).join(", ")}
            </p>
          `
        : nothing
    }
  `;
}
