import { html, nothing } from "lit";
import { resourceKindForCollection, type ResourceKind } from "../../lib/resource-route";
import type { ItemRelations, ItemRelation, ItemOccurrence } from "../../server/item-relations";
import { renderDetailSectionHeading } from "./detail-section-heading";

export interface ItemRelationsController {
  settings: { locale: string };
  label(key: string, fallback: string): string;
  localized(value: unknown): string;
  release(value: unknown): string;
  relatedEntityHref(kind: ResourceKind, id: string): string;
}
const resourceLabels: Record<string, string> = {
  cards: "memberCards",
  "support-cards": "supportCards",
  "band-items": "bandItems",
  missions: "missions",
  shop: "shop",
  exchange: "exchange",
  events: "events",
  "login-campaigns": "loginCampaigns",
  passes: "systemNavPasses",
  circle: "circle",
  songs: "songs",
};
const purposeLabels: Record<string, string> = {
  reward: "rewards",
  training: "training",
  awakening: "awakening",
  live: "liveSkill",
  gekisou: "gekisouSkill",
  level: "level",
  exchange: "exchange",
};
const ruleLabels: Record<string, string> = {
  MasterLiveFreeReward: "itemRuleSolo",
  MasterBattleLiveReward: "itemRuleMulti",
  MasterGekisouLiveRankReward: "itemRuleGekisou",
  MasterLiveStamp: "itemRuleStamp",
  MasterInvitationReward: "itemRuleInvite",
};

export function renderItemRelations(c: ItemRelationsController, data: ItemRelations) {
  const condition = (value: ItemOccurrence) =>
    Object.entries(value.conditions)
      .flatMap(([key, raw]) => {
        if (raw === undefined || raw === null) return [];
        if (key === "startAt" || key === "endAt") {
          const text = c.release(raw);
          return text
            ? [
                `${c.label(key === "startAt" ? "itemConditionStart" : "itemConditionEnd", key === "startAt" ? "Starts" : "Ends")}: ${text}`,
              ]
            : [];
        }
        if (key === "currency" || key === "reward") {
          const text = c.localized(raw);
          return text ? [`${c.label(key === "currency" ? "currency" : "rewards", key)}: ${text}`] : [];
        }
        if (key === "scoreRank")
          return [
            `${c.label("scoreRank", "Score rank")}: ${["", "E", "D", "C", "B", "A", "S", "SS"][Number(raw)] || String(raw)}`,
          ];
        if (key === "comboRateType")
          return [`${c.label("combo", "Combo")}: ${[25, 50, 75, 100][Number(raw)] ?? String(raw)}%`];
        if (key === "probabilityBp")
          return [
            `${c.label("probability", "Probability")}: ${(Number(raw) / 100).toLocaleString(c.settings.locale)}%`,
          ];
        if (key === "from") return [];
        if (key === "to") return [`${String(value.conditions.from)} → ${String(raw)}`];
        if (key === "premium") return raw === true ? [c.label("premium", "Premium")] : [];
        if (key === "difficulty") {
          const names = ["easy", "normal", "hard", "expert"];
          const name =
            typeof raw === "number"
              ? names[raw]
              : typeof raw === "string" && names.includes(raw.toLowerCase())
                ? raw.toLowerCase()
                : undefined;
          return [`${c.label("difficulty", "Difficulty")}: ${name ? c.label(name, name.toUpperCase()) : String(raw)}`];
        }
        if (key === "group") return [`${c.label("itemConditionRewardGroup", "Reward group")}: ${String(raw)}`];
        if (Array.isArray(raw) || typeof raw === "object") return [];
        return [`${c.label(key, key)}: ${String(raw)}`];
      })
      .join(" · ");
  const relation = (entry: ItemRelation) => {
    const kind = resourceKindForCollection(entry.entity.resource);
    const title =
      c.localized(entry.entity.name) ||
      `${c.label(resourceLabels[entry.entity.resource] || entry.entity.resource, entry.entity.resource)} ${entry.entity.id}`;
    return html`
      <section class="detail-section">
        <h4>
          ${
            kind
              ? html`
                  <a href=${c.relatedEntityHref(kind, entry.entity.id)}>${title}</a>
                `
              : title
          }
          <small class="detail-copy">${c.label(purposeLabels[entry.purpose] || entry.purpose, entry.purpose)}</small>
        </h4>
        <ul class="detail-object-list">
          ${entry.occurrences.map(
            (row) => html`
              <li>
                <span>${condition(row)}</span>
                <strong>
                  ${row.count === null ? c.label("unknown", "Unknown") : `×${row.count.toLocaleString(c.settings.locale)}`}
                </strong>
              </li>
            `,
          )}
        </ul>
      </section>
    `;
  };
  return html`
    <p class="detail-copy">
      ${c.label("itemRelationsScope", "Rewards and costs retain each source's conditions and upgrade stage.")}
    </p>
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("itemAcquisition", "Acquisition"), "rewards", { count: data.acquisitions.length })}
      ${data.acquisitions.map(relation)}
    </section>
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("itemUsage", "Uses"), "effects", { count: data.uses.length })}
      ${data.uses.map(relation)}
    </section>
    ${
      data.rules.length
        ? html`
            <section class="detail-section">
              ${renderDetailSectionHeading(c.label("itemBaseRewards", "Base reward rules"), "rewards", { count: data.rules.length })}
              <p class="detail-copy">
                ${c.label("itemBaseRewardsHint", "Base quantities; performance multipliers and game bonuses determine the final reward.")}
              </p>
              ${data.rules.map(
                (rule) => html`
                  <h4>${c.label(ruleLabels[rule.source], rule.source)}</h4>
                  <ul class="detail-object-list">
                    ${rule.occurrences.map(
                      (row) => html`
                        <li>
                          <span>${condition(row)}</span>
                          <strong>
                            ${row.count === null ? c.label("unknown", "Unknown") : `×${row.count.toLocaleString(c.settings.locale)}`}
                          </strong>
                        </li>
                      `,
                    )}
                  </ul>
                `,
              )}
            </section>
          `
        : nothing
    }
    ${
      data.coverage.some((source) => !source.available)
        ? html`
            <p class="detail-copy">
              ${c.label("unavailable", "Unavailable")}:
              ${data.coverage
                .filter((source) => !source.available)
                .map((source) => c.label(resourceLabels[source.resource] || source.resource, source.resource))
                .join(", ")}
            </p>
          `
        : nothing
    }
  `;
}
