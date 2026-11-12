// L3 — GEB
// Input: Local planner drafts, public card/skill templates and published rule defaults.
// Output: Shared Material editors for complete custom activities and hypothetical cards.
// Pos: [Map](../L2-2.md); local scenario editing surface.
// Effects/Dependencies: Commits only through Planner; song selection reuses the workspace picker.
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import type { TeamBuilder } from "../team-builder";
import { dataRows, nativeRow, type DataRow } from "../../lib/team-builder/data";
import {
  plannerCardFromTemplate,
  plannerEffectKey,
  PLANNER_MAX_SKILL_SECONDS,
  plannerSkillRecord,
  plannerSkillOrigin,
  type PlannerCard,
  type PlannerEvent,
} from "../../lib/team-builder/planner-data";
import type { EventEffectRow, RewardRow, ScoreRankRow, BoostRow } from "../../lib/team-builder/engine/master";
import { skillDisplay } from "../shared/skill-text";
import { resolveLocalizedText } from "../../lib/localized-text";
import { contentPublished } from "../../lib/content-publication";
import { cardRarityName } from "../shared/rarity-icon";
import { filterChip, iconButton, segmented } from "../ui/controls";
import { modal } from "../ui/modal";
import { tile } from "../ui/tile";
import { accordion } from "../ui/accordion";
import { choiceField, sectionHeading } from "./catalog";

type Host = TeamBuilder;
const text = (host: Host, key: string) => host.t(`planner.${key}`, key);
const update = (host: Host) => host.requestUpdate();
const empty = (host: Host) => host.t("unrestricted", "Unrestricted");
const fieldId = (key: string) => `tb-planner-${key}`;
function field(
  host: Host,
  key: string,
  label: string,
  value: string,
  change: (value: string) => void,
  type = "text",
  minimum?: number,
  maximum?: number,
  step?: number,
) {
  const invalid = host.planner.submitted && host.planner.issues().includes(key.split("-")[0]!);
  return html`
    <md-outlined-text-field
      id=${fieldId(key)}
      label=${label}
      type=${type}
      .value=${live(value)}
      min=${minimum ?? nothing}
      max=${maximum ?? nothing}
      step=${step ?? nothing}
      .error=${invalid}
      @input=${(event: Event) => {
        if (type !== "number") {
          change((event.target as HTMLInputElement).value);
          update(host);
        }
      }}
      @change=${(event: Event) => {
        if (type === "number") {
          change((event.target as HTMLInputElement).value);
          update(host);
        }
      }}
    ></md-outlined-text-field>
  `;
}
const number = (
  host: Host,
  key: string,
  label: string,
  value: number,
  change: (value: number) => void,
  minimum = 0,
  maximum = 0x7fffffff,
  step = 1,
) =>
  field(
    host,
    key,
    label,
    String(value),
    (value) => change(value.trim() ? Number(value) : NaN),
    "number",
    minimum,
    maximum,
    step,
  );
function choose(
  host: Host,
  label: string,
  value: number,
  options: readonly { value: number; label: string }[],
  change: (value: number) => void,
) {
  return choiceField({
    type: "select",
    label,
    value: String(value),
    options: options.map((row) => ({ value: String(row.value), label: row.label })),
    onSelect: (value) => {
      change(Number(value));
      update(host);
    },
  });
}
function fold(host: Host, key: string, label: string, content: unknown) {
  const planner = host.planner;
  if (planner.expanded.has(key)) planner.visited.add(key);
  return accordion({
    id: fieldId(key),
    label,
    expanded: planner.expanded.has(key),
    onExpandedChange: (value) => {
      if (value) planner.expanded.add(key);
      else planner.expanded.delete(key);
      update(host);
    },
    content: planner.visited.has(key) ? content : nothing,
  });
}
const table = (headers: unknown[], rows: unknown[]) => html`
  <div class="table-scroll" tabindex="0">
    <table class="data-table">
      <thead>
        <tr>
          ${headers.map(
            (label) => html`
              <th scope="col">${label}</th>
            `,
          )}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
`;
const remove = (host: Host, action: () => void) =>
  iconButton({
    icon: "close",
    label: host.common("common.actions.remove", "Remove"),
    onClick: () => {
      action();
      update(host);
    },
  });
const button = (label: string, action: () => void) => html`
  <button class="button button--tonal" type="button" @click=${action}>${label}</button>
`;
const ranks = (host: Host) =>
  ["E", "D", "C", "B", "A", "S", "SS"].map((label, index) => ({
    value: index + 1,
    label: host.t("planner.rank", "{rank}", { rank: label }),
  }));
const attributes = (host: Host, all = false) => [
  ...(all ? [{ value: 99, label: host.catalog!.attributeName(99) }] : []),
  ...[1, 2, 3, 4, 5].map((value) => ({ value, label: host.catalog!.attributeName(value) })),
];
function cardChoices(host: Host, kind: PlannerCard["kind"], publicOnly = false) {
  const rows =
    kind === "members"
      ? (publicOnly ? host.publicData! : host.data!).members
      : (publicOnly ? host.publicData! : host.data!).snapshots;
  return Object.values(rows)
    .filter((row) => (publicOnly ? contentPublished(row) : host.planner.cardById(row.id)?.active !== false))
    .map((row) => ({
      value: row.id,
      label: [
        host.catalog!.text(row.name),
        ...("characterId" in row ? [row.characterId] : row.characterIds).map((id: number) =>
          host.catalog!.characterName(id),
        ),
        cardRarityName(row.rarity),
      ].join(" / "),
    }));
}

function cardEditor(host: Host) {
  const planner = host.planner,
    c = planner.card!,
    catalog = host.catalog!,
    source = planner.source;
  const changeTemplate = (id: number) => {
    planner.card = plannerCardFromTemplate(source, planner.document, c.kind, id, c.name);
    update(host);
  };
  const characters = [...host.master!.characters.keys()];
  return html`
    <div class="stack">
      ${field(host, "name", text(host, "cardName"), c.name, (value) => (c.name = value))}
      ${choose(host, text(host, "cardTemplate"), c.templateId, cardChoices(host, c.kind, true), changeTemplate)}
      ${choose(
        host,
        host.common("catalog.cards.fields.rarity", "Rarity"),
        c.rarity,
        [2, 3, 4, 10, 20].map((value) => ({ value, label: cardRarityName(value) })),
        (value) => {
          c.rarity = value;
          const cards = c.kind === "members" ? source.members : source.snapshots;
          if (cards[String(c.materialTemplateId)]?.rarity !== value) {
            const match = Object.values(cards).find((card) => card.rarity === value);
            if (match) c.materialTemplateId = match.id;
          }
        },
      )}
      ${choose(host, host.common("catalog.fields.attribute", "Attribute"), c.attribute, attributes(host), (value) => (c.attribute = value))}
      <section id=${fieldId("characters")} class="stack stack--tight">
        ${sectionHeading({ icon: "person", label: host.common("navigation.characters", "Characters"), level: 3 })}
        ${
          c.kind === "members"
            ? choose(
                host,
                host.common("catalog.fields.character", "Character"),
                c.characterIds[0] ?? 0,
                characters.map((id) => ({ value: id, label: catalog.characterName(id) })),
                (id) => (c.characterIds = [id]),
              )
            : html`
                <div class="cluster">
                  ${characters.map((id) =>
                    filterChip({
                      label: catalog.characterName(id),
                      image: catalog.characterFace(id),
                      selected: c.characterIds.includes(id),
                      onToggle: () => {
                        c.characterIds = c.characterIds.includes(id)
                          ? c.characterIds.filter((value) => value !== id)
                          : c.characterIds.length < 5
                            ? [...c.characterIds, id]
                            : c.characterIds;
                        update(host);
                      },
                    }),
                  )}
                </div>
              `
        }
      </section>
      <section id=${fieldId("stats")} class="stack">
        ${sectionHeading({ icon: "bar_chart", label: text(host, "baseStats"), level: 3 })}
        ${(["performance", "technique", "visual"] as const).map((key) =>
          number(
            host,
            `stats-${key}`,
            host.common(`catalog.cards.fields.${key}`, key),
            c.stats[key] / (c.kind === "snaps" ? 100 : 1),
            (value) => (c.stats[key] = Math.round(value * (c.kind === "snaps" ? 100 : 1))),
            0,
            0x7fffffff / (c.kind === "snaps" ? 100 : 1),
            c.kind === "snaps" ? 0.01 : 1,
          ),
        )}
      </section>
      <section id=${fieldId("skills")} class="stack">
        ${sectionHeading({ icon: "bolt", label: host.common("catalog.cards.fields.skills", "Skills"), level: 3 })}
        ${c.skills.map((skill, slot) => {
          planner.describeSkill(skill);
          const role = skill.family.replace("gekiso", "gekisou"),
            label = host.common(`catalog.cards.fields.${role}Skill`, role);
          const template = source.skills[skill.family]?.[String(skill.templateId)];
          const record = plannerSkillRecord(source, skill, slot + 1);
          const display = record
            ? skillDisplay({ resolvedSkills: { [role]: record } }, source.skillReference)[0]
            : undefined;
          const levels = (display?.levels ?? []) as { level: number; description: unknown }[];
          const level = planner.levels.get(slot) ?? levels.at(-1)?.level ?? 1;
          const rows = dataRows(template?.effects)
            .map((row, index) => ({ row: nativeRow(row), key: plannerEffectKey(row, index) }))
            .filter(({ row }) => Number(row.level) === level);
          const optionRows = Object.entries(source.skills[skill.family] ?? {}).flatMap(([id, row]) => {
            const origin = plannerSkillOrigin(source, skill.family, Number(id));
            const card = origin
              ? (origin.kind === "members" ? source.members : source.snapshots)[String(origin.cardId)]
              : undefined;
            if (!card || !contentPublished(card)) return [];
            return [
              {
                value: Number(id),
                label: [catalog.text(row.skillName) || catalog.text(row.description), catalog.text(card.name)]
                  .filter(Boolean)
                  .join(" / "),
              },
            ];
          });
          const settings = dataRows(source.skillReference.effectSettings).map(nativeRow);
          const percentKinds = new Set([
            1000, 1001, 1002, 1003, 1004, 1005, 2000, 2001, 2003, 2004, 2005, 4000, 4001, 4002, 4003, 4004, 11000,
            11002,
          ]);
          return fold(
            host,
            `skill-${slot}`,
            label,
            html`
              <div class="stack">
                ${choose(
                  host,
                  label,
                  skill.templateId,
                  [{ value: 0, label: text(host, "noSkill") }, ...optionRows],
                  (value) => {
                    c.skills[slot] = {
                      ...skill,
                      templateId: value,
                      origin: plannerSkillOrigin(source, skill.family, value),
                      effects: {},
                      name: "",
                      description: undefined,
                    };
                    planner.levels.delete(slot);
                  },
                )}
                ${
                  record
                    ? html`
                        ${field(host, `skills-name-${slot}`, text(host, "skillName"), skill.name, (value) => (skill.name = value))}
                        ${
                          levels.length > 1
                            ? segmented({
                                label: host.common("common.fields.level", "Level"),
                                value: String(level),
                                options: levels.map((row) => ({ value: String(row.level), label: `Lv.${row.level}` })),
                                onSelect: (value) => {
                                  planner.levels.set(slot, Number(value));
                                  update(host);
                                },
                              })
                            : nothing
                        }
                        <div class="spec-list">
                          <div>
                            <dt>${host.common("catalog.fields.effects", "Effects")}</dt>
                            <dd>
                              ${resolveLocalizedText(levels.find((row) => row.level === level)?.description, host.locale).text}
                            </dd>
                          </div>
                        </div>
                        ${rows.map(({ row, key }, index) => {
                          const effect = skill.effects[key] ?? {},
                            kind = Number(row.effectType ?? row.skillEffectType),
                            divisor = percentKinds.has(kind) ? 100 : kind === 15000 ? 1000 : 1;
                          const label =
                            catalog.text(settings.find((value) => Number(value.skillEffectType) === kind)?.name) ||
                            text(host, "effectValue");
                          const change = (patch: typeof effect) =>
                            (skill.effects = { ...skill.effects, [key]: { ...skill.effects[key], ...patch } });
                          const unit = percentKinds.has(kind) ? "%" : kind === 15000 ? "s" : "";
                          return html`
                            <div class="stack">
                              ${number(host, `skills-value-${slot}-${index}`, `${label}${unit ? ` (${unit})` : ""}`, (effect.value ?? Number(row.effectValue)) / divisor, (value) => change({ value: Math.round(value * divisor) }), -0x80000000 / divisor, 0x7fffffff / divisor, 1 / divisor)}
                              ${number(host, `skills-time-${slot}-${index}`, text(host, "duration"), effect.seconds ?? Number(row.activationTimeSecond ?? 0), (value) => change({ seconds: value }), 0, PLANNER_MAX_SKILL_SECONDS, 0.01)}
                              ${Number(row.maxEffectValue) || effect.maximum !== undefined ? number(host, `skills-maximum-${slot}-${index}`, text(host, "maximumEffect"), (effect.maximum ?? Number(row.maxEffectValue)) / divisor, (value) => change({ maximum: Math.round(value * divisor) }), -0x80000000 / divisor, 0x7fffffff / divisor, 1 / divisor) : nothing}
                            </div>
                          `;
                        })}
                      `
                    : nothing
                }
              </div>
            `,
          );
        })}
      </section>
      ${fold(
        host,
        "materials",
        text(host, "growthRules"),
        html`
          <div class="stack">
            ${choose(host, text(host, "materialTemplate"), c.materialTemplateId, cardChoices(host, c.kind, true), (value) => (c.materialTemplateId = value))}
          </div>
        `,
      )}
    </div>
  `;
}

function songPicker(host: Host, challenge: boolean) {
  const planner = host.planner,
    event = planner.event!,
    catalog = host.catalog!;
  host.songPicker = {
    songs: (challenge ? event.challenges.map((row) => row.songId) : event.rules.normalSongs).map((songId) => ({
      songId,
      difficulty: host.songDifficulties[0] ?? 3,
    })),
    single: false,
    query: "",
    filtersOpen: false,
    bands: [],
    attributes: [],
    gekisouTypes: [],
    difficulty: host.songDifficulties[0] ?? 3,
    context: `planner-${challenge ? "challenge" : "live"}`,
    title: text(host, challenge ? "challengeSongs" : "normalSongs"),
    change: (songs) => {
      const ids = [...new Set(songs.map((song) => song.songId))];
      if (challenge)
        event.challenges = ids.map(
          (songId) =>
            event.challenges.find((row) => row.songId === songId) ?? {
              songId,
              attribute: Number(catalog.song(songId).musicType) || 99,
            },
        );
      else event.rules.normalSongs = ids;
      update(host);
    },
  };
  update(host);
}
function rewardTable(host: Host, rows: RewardRow[], key: string) {
  const catalog = host.catalog!;
  const resourceOptions = [
    { value: 1, label: host.common("navigation.items", "Items") },
    { value: 2, label: host.t("members", "Members") },
    { value: 3, label: host.t("snapshots", "Snapshots") },
  ];
  const items = Object.values(host.publicData!.events).flatMap((event) => {
    const item = event.eventItem as DataRow | undefined;
    return item
      ? [{ value: Number(item.resourceId ?? item.id), label: catalog.text(item.name) || catalog.text(event.title) }]
      : [];
  });
  return html`
    <div class="stack">
      ${table(
        [
          text(host, "rankLabel"),
          text(host, "rewardResource"),
          text(host, "count"),
          text(host, "probability"),
          text(host, "dropGroup"),
          "",
        ],
        rows.map(
          (row, index) => html`
            <tr>
              <td>
                ${choose(host, text(host, "rankLabel"), row.scoreRank, ranks(host), (value) => (row.scoreRank = value))}
              </td>
              <td>
                <div class="stack stack--tight">
                  ${choose(host, text(host, "resourceType"), row.resourceType, resourceOptions, (value) => (row.resourceType = value))}
                  ${choose(host, text(host, "rewardResource"), row.resourceId, [{ value: host.planner.event!.id, label: text(host, "eventBadge") }, ...(row.resourceType === 1 ? items : cardChoices(host, row.resourceType === 2 ? "members" : "snaps"))], (value) => (row.resourceId = value))}
                </div>
              </td>
              <td>
                ${number(host, `rewards-${key}-${index}`, text(host, "count"), row.count, (value) => (row.count = value))}
              </td>
              <td>
                ${number(host, `rewards-chance-${key}-${index}`, text(host, "probability"), row.probability / 100, (value) => (row.probability = Math.round(value * 100)), 0, 100, 0.01)}
              </td>
              <td>
                ${number(host, `rewards-group-${key}-${index}`, text(host, "dropGroup"), row.group, (value) => (row.group = value))}
              </td>
              <td>${remove(host, () => rows.splice(index, 1))}</td>
            </tr>
          `,
        ),
      )}
      ${button(text(host, "addReward"), () => {
        rows.push({
          scoreRank: 7,
          group: 0,
          resourceType: 1,
          resourceId: host.planner.event!.id,
          count: 0,
          probability: 10000,
        });
        update(host);
      })}
    </div>
  `;
}
function boostTable(host: Host, rows: BoostRow[], key: string) {
  return table(
    [text(host, "consumption"), text(host, "pointRate"), text(host, "rewardRate")],
    rows.map(
      (row, index) => html`
        <tr>
          <td>${row.consumed}</td>
          <td>
            ${number(host, `boosts-pt-${key}-${index}`, text(host, "pointRate"), row.eventPointRate, (value) => (row.eventPointRate = value), 1)}
          </td>
          <td>
            ${number(host, `boosts-drop-${key}-${index}`, text(host, "rewardRate"), row.rewardRate, (value) => (row.rewardRate = value), 1)}
          </td>
        </tr>
      `,
    ),
  );
}
function rankTable(host: Host, rows: ScoreRankRow[], key: string) {
  const reset = () => {
    const groups = [...host.master!.scoreRanks.values()];
    const selected = groups.find((group) => group.length) ?? [];
    rows.splice(0, rows.length, ...structuredClone(selected));
    update(host);
  };
  return html`
    <div class="stack">
      ${
        rows.length
          ? table(
              [text(host, "rankLabel"), text(host, "scoreRequired"), text(host, "battleScoreRequired")],
              rows.map(
                (row, index) => html`
                  <tr>
                    <th scope="row">${ranks(host).find((rank) => rank.value === row.rank)?.label ?? row.rank}</th>
                    <td>
                      ${number(host, `ranks-score-${key}-${index}`, text(host, "scoreRequired"), row.required, (value) => (row.required = value))}
                    </td>
                    <td>
                      ${number(host, `ranks-battle-${key}-${index}`, text(host, "battleScoreRequired"), row.battleRequired, (value) => (row.battleRequired = value))}
                    </td>
                  </tr>
                `,
              ),
            )
          : html`
              <span class="chip">${text(host, "songRankRules")}</span>
            `
      }
      <div class="cluster">
        ${button(text(host, "customizeRanks"), reset)}${
          rows.length
            ? button(text(host, "songRankRules"), () => {
                rows.splice(0);
                update(host);
              })
            : nothing
        }
      </div>
    </div>
  `;
}
function addBonus(host: Host, target: "attribute" | "band" | "character" | "member" | "snap", selected?: number) {
  const fields = {
    attribute: "cardType",
    band: "bandId",
    character: "characterId",
    member: "memberCardId",
    snap: "supportCardId",
  } as const;
  const field = fields[target],
    resource = target === "snap" ? 3 : 2;
  const rows = [...host.master!.events.values()].filter(
    (event) => event.startAt !== null && event.startAt <= Date.now() && host.publicData!.events[event.id],
  );
  const match = (row: EventEffectRow) =>
    row[field] > 0 && (["member", "snap"].includes(target) ? row.resourceType === resource : true);
  const examples = rows.flatMap((event) => event.effects.filter(match));
  const patterns = new Map<string, { count: number; rows: EventEffectRow[] }>();
  for (const event of rows) {
    const sample = event.effects.find(match);
    if (!sample) continue;
    const group = event.effects.filter((row) => row[field] === sample[field] && match(row));
    const key = JSON.stringify(group.map((row) => [row.resourceType, row.bonusType, row.perRank]));
    const old = patterns.get(key);
    if (old) old.count++;
    else patterns.set(key, { count: 1, rows: group });
  }
  const defaults = [...patterns.values()].sort((a, b) => b.count - a.count)[0]?.rows ?? [];
  const value =
    selected ??
    (target === "attribute"
      ? 1
      : target === "band"
        ? 1
        : target === "character"
          ? Number(Object.keys(host.data!.characters)[0])
          : Number(Object.keys(target === "member" ? host.data!.members : host.data!.snapshots)[0]));
  const blank: EventEffectRow = {
    resourceType: resource,
    characterId: 0,
    bandId: 0,
    cardType: 0,
    tagId: 0,
    memberCardId: 0,
    supportCardId: 0,
    bonusType: 0,
    perRank: [0, 0, 0, 0, 0],
  };
  host.planner.event!.effects.push(
    ...(defaults.length ? defaults : [examples[0] ?? blank]).map((row) => ({
      ...blank,
      resourceType: row.resourceType,
      bonusType: row.bonusType,
      perRank: [...row.perRank],
      [field]: value,
    })),
  );
  update(host);
}
function eventBonusChoices(host: Host, event: PlannerEvent) {
  const catalog = host.catalog!;
  const generic = (row: EventEffectRow) => !row.memberCardId && !row.supportCardId;
  const toggle = (target: "attribute" | "band" | "character", id: number) => {
    const field = target === "attribute" ? "cardType" : target === "band" ? "bandId" : "characterId";
    if (event.effects.some((row) => generic(row) && row[field] === id))
      event.effects = event.effects.filter((row) => !generic(row) || row[field] !== id);
    else addBonus(host, target, id);
    update(host);
  };
  const cards = (kind: PlannerCard["kind"]) => {
    const field = kind === "members" ? "memberCardId" : "supportCardId",
      target = kind === "members" ? "member" : "snap";
    const selected = [...new Set(event.effects.map((row) => row[field]).filter(Boolean))];
    const open = () => {
      host.slotPicker = {
        target: "selection",
        kind,
        ids: selected,
        change: (ids) => {
          event.effects = event.effects.filter((row) => !row[field] || ids.includes(row[field]));
          for (const id of ids) if (!selected.includes(id)) addBonus(host, target, id);
          update(host);
        },
      };
      update(host);
    };
    return html`
      <section class="stack">
        ${sectionHeading({ icon: kind === "members" ? "person" : "photo_library", label: host.t(kind === "members" ? "members" : "snapshots", kind === "members" ? "Members" : "Snapshots"), level: 3 })}
        ${button(text(host, `addBonus.${target}`), open)}
        ${
          selected.length
            ? html`
                <div class=${`collection collection--${kind === "members" ? "member" : "support"}`}>
                  ${selected.map((id) => tile({ ...catalog.cardOptions(kind, id)!, onOpen: open }))}
                </div>
              `
            : nothing
        }
      </section>
    `;
  };
  return html`
    <div class="stack">
      <section class="stack">
        ${sectionHeading({ icon: "palette", label: host.common("catalog.fields.attribute", "Attribute"), level: 3 })}
        <div class="cluster">
          ${[1, 2, 3, 4, 5].map((id) => filterChip({ label: catalog.attributeName(id), image: catalog.attributeIcon(id), selected: event.effects.some((row) => generic(row) && row.cardType === id), onToggle: () => toggle("attribute", id) }))}
        </div>
      </section>
      <section class="stack">
        ${sectionHeading({ icon: "groups", label: host.common("catalog.fields.band", "Band"), level: 3 })}
        <div class="cluster">
          ${Object.keys(host.publicData!.bands)
            .map(Number)
            .map((id) =>
              filterChip({
                label: catalog.bandName(id),
                image: catalog.bandIcon(id),
                selected: event.effects.some((row) => generic(row) && row.bandId === id),
                onToggle: () => toggle("band", id),
              }),
            )}
        </div>
      </section>
      ${fold(
        host,
        "bonus-characters",
        host.common("navigation.characters", "Characters"),
        html`
          <div class="cluster">
            ${[...host.master!.characters.keys()].map((id) => filterChip({ label: catalog.characterName(id), image: catalog.characterFace(id), selected: event.effects.some((row) => generic(row) && row.characterId === id), onToggle: () => toggle("character", id) }))}
          </div>
        `,
      )}
      ${cards("members")}${cards("snaps")}
      ${fold(host, "bonuses", text(host, "bonusDetails"), bonusEditor(host, event))}
    </div>
  `;
}
function bonusEditor(host: Host, event: PlannerEvent) {
  const catalog = host.catalog!;
  return html`
    <div id=${fieldId("bonuses")} class="stack">
      <div class="cluster">
        ${(["attribute", "band", "character", "member", "snap"] as const).map((target) => button(text(host, `addBonus.${target}`), () => addBonus(host, target)))}
      </div>
      ${event.effects.map((row, index) =>
        fold(
          host,
          `bonus-${index}`,
          `${text(host, "bonusRule")} ${index + 1}`,
          html`
            <div class="stack">
              ${choose(
                host,
                text(host, "bonusTarget"),
                row.resourceType,
                [
                  { value: 2, label: host.t("members", "Members") },
                  { value: 3, label: host.t("snapshots", "Snapshots") },
                ],
                (value) => (row.resourceType = value),
              )}
              ${choose(
                host,
                host.t("eventBonus", "Event bonus"),
                row.bonusType,
                [
                  { value: 0, label: text(host, "pointBonus") },
                  { value: 1, label: text(host, "itemBonus") },
                  { value: 2, label: text(host, "parameterBonus") },
                ],
                (value) => (row.bonusType = value),
              )}
              ${choose(host, host.common("catalog.fields.attribute", "Attribute"), row.cardType, [{ value: 0, label: empty(host) }, ...attributes(host)], (value) => (row.cardType = value))}
              ${choose(
                host,
                host.common("catalog.fields.band", "Band"),
                row.bandId,
                [
                  { value: 0, label: empty(host) },
                  ...Object.keys(host.data!.bands)
                    .map(Number)
                    .map((value) => ({ value, label: catalog.bandName(value) })),
                ],
                (value) => (row.bandId = value),
              )}
              ${choose(
                host,
                host.common("catalog.fields.character", "Character"),
                row.characterId,
                [
                  { value: 0, label: empty(host) },
                  ...Object.keys(host.data!.characters)
                    .map(Number)
                    .map((value) => ({ value, label: catalog.characterName(value) })),
                ],
                (value) => (row.characterId = value),
              )}
              ${
                row.resourceType === 2
                  ? choose(
                      host,
                      host.t("members", "Members"),
                      row.memberCardId,
                      [{ value: 0, label: empty(host) }, ...cardChoices(host, "members")],
                      (value) => {
                        row.memberCardId = value;
                        row.supportCardId = 0;
                      },
                    )
                  : choose(
                      host,
                      host.t("snapshots", "Snapshots"),
                      row.supportCardId,
                      [{ value: 0, label: empty(host) }, ...cardChoices(host, "snaps")],
                      (value) => {
                        row.supportCardId = value;
                        row.memberCardId = 0;
                      },
                    )
              }
              ${table(
                [text(host, "cardRank"), host.t("eventBonus", "Event bonus")],
                row.perRank.map(
                  (value, rank) => html`
                    <tr>
                      <th scope="row">${rank + 1}</th>
                      <td>
                        ${number(
                          host,
                          `bonuses-${index}-${rank}`,
                          `${host.t("eventBonus", "Event bonus")} (%)`,
                          value / 100,
                          (next) => {
                            const values = [...row.perRank];
                            values[rank] = Math.round(next * 100);
                            row.perRank = values;
                          },
                          0,
                          0x7fffffff / 100,
                          0.01,
                        )}
                      </td>
                    </tr>
                  `,
                ),
              )}
              ${fold(
                host,
                `bonus-extra-${index}`,
                text(host, "advanced"),
                number(host, `bonuses-tag-${index}`, text(host, "tagId"), row.tagId, (value) => (row.tagId = value)),
              )}
              <button
                class="button button--text"
                type="button"
                @click=${() => {
                  event.effects.splice(index, 1);
                  update(host);
                }}
              >
                ${host.common("common.actions.remove", "Remove")}
              </button>
            </div>
          `,
        ),
      )}
    </div>
  `;
}
function eventEditor(host: Host) {
  const p = host.planner,
    e = p.event!,
    catalog = host.catalog!;
  const date = (value: number | null) =>
    value === null ? "" : new Date(value + 9 * 3600000).toISOString().slice(0, 16);
  const readDate = (value: string) => (value ? Date.parse(value + ":00+09:00") : null);
  const rank = p.eventRank;
  const point = (rows: { rank: number; value: number }[]) => rows.find((row) => row.rank === rank)?.value ?? 0;
  const setPoint = (rows: { rank: number; value: number }[], value: number) => {
    const row = rows.find((row) => row.rank === rank);
    if (row) row.value = value;
    else rows.push({ rank, value });
  };
  return html`
    <div class="stack">
      ${segmented({
        label: text(host, "customEvent"),
        value: p.eventTab,
        options: [
          { value: "basic", label: text(host, "basic") },
          { value: "bonuses", label: text(host, "bonusTab") },
          { value: "rewards", label: text(host, "settlement") },
        ],
        onSelect: (value) => {
          p.eventTab = value;
          update(host);
        },
      })}
      ${
        p.eventTab === "basic"
          ? html`
              <div class="stack">
                ${field(host, "name", text(host, "eventName"), e.name, (value) => (e.name = value))}
                ${choose(
                  host,
                  text(host, "eventType"),
                  e.eventType,
                  [
                    ...new Set([
                      1,
                      ...Object.values(host.publicData!.events)
                        .map((row) => Number(row.eventType))
                        .filter(Number.isFinite),
                    ]),
                  ].map((value) => ({
                    value,
                    label: value === 1 ? text(host, "challengeEvent") : text(host, "eventType") + " " + value,
                  })),
                  (value) => (e.eventType = value),
                )}
                ${fold(
                  host,
                  "dates",
                  text(host, "dates"),
                  html`
                    <div class="stack">
                      ${field(host, "dates-start", text(host, "startAt"), date(e.startAt), (value) => (e.startAt = readDate(value)), "datetime-local")}
                      ${field(host, "dates-end", text(host, "endAt"), date(e.endAt), (value) => (e.endAt = readDate(value)), "datetime-local")}
                    </div>
                  `,
                )}
                <section class="stack">
                  ${sectionHeading({ icon: "music_note", label: text(host, "normalSongs"), level: 3 })}
                  ${button(e.rules.normalSongs.length ? host.t("planner.songCount", "{count} songs", { count: e.rules.normalSongs.length }) : empty(host), () => songPicker(host, false))}
                  ${
                    e.rules.normalSongs.length
                      ? button(empty(host), () => {
                          e.rules.normalSongs = [];
                          update(host);
                        })
                      : nothing
                  }
                </section>
                <section class="stack">
                  ${sectionHeading({ icon: "swords", label: text(host, "challengeSongs"), level: 3 })}
                  ${button(text(host, "chooseSongs"), () => songPicker(host, true))}
                  ${e.challenges.map(
                    (row, index) => html`
                      <div class="stack">
                        <div class="row">
                          <strong class="row__spacer">${catalog.songTitle(row.songId)}</strong>
                          ${remove(host, () => e.challenges.splice(index, 1))}
                        </div>
                        ${choose(host, text(host, "challengeAttribute"), row.attribute, attributes(host, true), (value) => (row.attribute = value))}
                      </div>
                    `,
                  )}
                </section>
              </div>
            `
          : p.eventTab === "bonuses"
            ? eventBonusChoices(host, e)
            : html`
                <div class="stack">
                  ${fold(
                    host,
                    "rewards",
                    text(host, "rankRewards"),
                    html`
                      <div class="stack">
                        ${choose(host, text(host, "rankLabel"), rank, ranks(host), (value) => (p.eventRank = value))}
                        ${number(host, "rewards-live", text(host, "normalPt"), point(e.livePoints), (value) => setPoint(e.livePoints, value))}
                        ${number(host, "rewards-challenge", text(host, "challengePt"), point(e.challengePoints), (value) => setPoint(e.challengePoints, value))}
                        ${number(host, "rewards-cp", "CP", point(e.rules.liveChallengePoints), (value) => setPoint(e.rules.liveChallengePoints, value))}
                      </div>
                    `,
                  )}
                  ${table(
                    [text(host, "rankLabel"), text(host, "normalPt"), text(host, "challengePt"), "CP"],
                    e.livePoints.map(
                      (row) => html`
                        <tr>
                          <th scope="row">${ranks(host).find((rank) => rank.value === row.rank)?.label ?? row.rank}</th>
                          <td>${row.value}</td>
                          <td>${e.challengePoints.find((point) => point.rank === row.rank)?.value ?? 0}</td>
                          <td>${e.rules.liveChallengePoints.find((point) => point.rank === row.rank)?.value ?? 0}</td>
                        </tr>
                      `,
                    ),
                  )}
                  ${choose(
                    host,
                    text(host, "eventBadge"),
                    e.itemId,
                    [
                      { value: 0, label: text(host, "customBadge") },
                      ...Object.values(host.publicData!.events).flatMap((event) => {
                        const item = event.eventItem as DataRow | undefined;
                        return item
                          ? [
                              {
                                value: Number(item.resourceId ?? item.id),
                                label: catalog.text(item.name) || catalog.text(event.title),
                              },
                            ]
                          : [];
                      }),
                    ],
                    (value) => {
                      const old = e.itemId || e.id;
                      e.itemId = value;
                      for (const row of [...e.liveRewards, ...e.challengeRewards])
                        if (row.resourceType === 1 && row.resourceId === old) row.resourceId = value || e.id;
                    },
                  )}
                  ${fold(host, "live-drops", text(host, "normalDrops"), rewardTable(host, e.liveRewards, "live"))}
                  ${fold(host, "challenge-drops", text(host, "challengeDrops"), rewardTable(host, e.challengeRewards, "challenge"))}
                  ${fold(host, "boosts", text(host, "normalBoosts"), boostTable(host, e.rules.boosts, "live"))}
                  ${fold(host, "challenge-boosts", text(host, "challengeBoosts"), boostTable(host, e.rules.challengeBoosts, "challenge"))}
                  ${fold(host, "normal-ranks", text(host, "normalRanks"), rankTable(host, e.rules.normalRanks, "live"))}
                  ${fold(host, "challenge-ranks", text(host, "challengeRanks"), rankTable(host, e.rules.challengeRanks, "challenge"))}
                </div>
              `
      }
    </div>
  `;
}

function library(host: Host) {
  const p = host.planner,
    catalog = host.catalog!;
  return html`
    <div class="stack">
      <div class="cluster">
        ${
          p.libraryScope === "cards"
            ? html`
                ${button(text(host, "newMember"), () => p.editCard("members"))}${button(text(host, "newSnap"), () => p.editCard("snaps"))}
              `
            : button(text(host, "newEvent"), () => p.editEvent())
        }
      </div>
      ${
        p.libraryScope === "cards" && p.cards.length
          ? html`
              <ul class="list">
                ${p.cards.map(
                  (card) => html`
                    <li class="list-item list-item--two-line">
                      <img
                        class="list-item__leading"
                        src=${catalog.cardOptions(card.kind, card.id)?.image ?? ""}
                        alt=""
                        width="48"
                        height="48"
                        loading="lazy"
                      />
                      <span class="list-item__body">
                        <strong class="list-item__headline">${card.name}</strong>
                        <span class="list-item__supporting">
                          ${card.characterIds.map((id) => catalog.characterName(id)).join(" / ")}
                        </span>
                      </span>
                      <span class="list-item__trailing">
                        ${iconButton({ icon: "edit", label: host.t("planner.edit", "Edit"), onClick: () => p.editCard(card.kind, card.id) })}${remove(host, () => p.deactivate("card", card.id))}
                      </span>
                    </li>
                  `,
                )}
              </ul>
            `
          : nothing
      }
      ${
        p.libraryScope === "events" && p.events.length
          ? html`
              <ul class="list">
                ${p.events.map(
                  (event) => html`
                    <li class="list-item list-item--two-line">
                      <span class="list-item__body">
                        <strong class="list-item__headline">${event.name}</strong>
                        <span class="list-item__supporting">
                          ${host.t("planner.songCount", "{count} songs", { count: event.challenges.length })}
                        </span>
                      </span>
                      <span class="list-item__trailing">
                        ${iconButton({ icon: "edit", label: host.t("planner.edit", "Edit"), onClick: () => p.editEvent(event.id) })}${remove(host, () => p.deactivate("event", event.id))}
                      </span>
                    </li>
                  `,
                )}
              </ul>
            `
          : nothing
      }
      <div class="cluster">
        ${button(host.common("common.actions.import", "Import"), () => p.import())}${button(host.common("common.actions.export", "Export"), () => void p.export())}
      </div>
    </div>
  `;
}
export function renderPlanner(host: Host): TemplateResult | typeof nothing {
  const p = host.planner;
  if (!p.dialog || !host.catalog) return nothing;
  const title = text(
    host,
    p.dialog === "library"
      ? p.libraryScope === "events"
        ? "manageEvents"
        : "manageCards"
      : p.dialog === "event"
        ? "customEvent"
        : "hypotheticalCard",
  );
  const close = () => p.close();
  return html`
    <dialog class="dialog" aria-labelledby="tb-planner-title" ${modal(close)}>
      <header class="dialog__header">
        <h2 id="tb-planner-title">${title}</h2>
      </header>
      <div class="dialog__body">
        ${
          p.error
            ? html`
                <p class="field-error" role="alert">${p.error}</p>
              `
            : nothing
        }
        ${
          p.submitted && p.issues().length
            ? html`
                <nav aria-label=${text(host, "invalidFields")}>
                  <ul class="list">
                    ${p.issues().map(
                      (key) => html`
                        <li>
                          <a
                            class="button button--text"
                            href=${"#" + fieldId(key)}
                            @click=${async (event: Event) => {
                              event.preventDefault();
                              if (p.event)
                                p.eventTab = ["name", "dates"].includes(key)
                                  ? "basic"
                                  : key === "bonuses"
                                    ? "bonuses"
                                    : "rewards";
                              const panels: Record<string, string[]> = {
                                dates: ["dates"],
                                bonuses: ["bonuses"],
                                rewards: ["rewards", "live-drops", "challenge-drops"],
                                boosts: ["boosts", "challenge-boosts"],
                                ranks: ["normal-ranks", "challenge-ranks"],
                                skills: p.card?.skills.map((_skill, index) => `skill-${index}`) ?? [],
                              };
                              for (const panel of panels[key] ?? []) p.expanded.add(panel);
                              update(host);
                              await host.updateComplete;
                              const target =
                                host.querySelector<HTMLElement>("#" + fieldId(key)) ??
                                host.querySelector<HTMLElement>("#" + fieldId(panels[key]?.[0] ?? key) + "-trigger");
                              target?.scrollIntoView({ block: "center" });
                              (
                                target?.querySelector<HTMLElement>(
                                  "md-outlined-text-field,md-outlined-select,button",
                                ) ?? target
                              )?.focus();
                            }}
                          >
                            ${text(host, "need." + key)}
                          </a>
                        </li>
                      `,
                    )}
                  </ul>
                </nav>
              `
            : nothing
        }
        ${p.dialog === "library" ? library(host) : p.dialog === "card" ? cardEditor(host) : eventEditor(host)}
      </div>
      <footer class="dialog__actions">
        ${
          p.dialog === "library"
            ? button(host.common("common.actions.close", "Close"), close)
            : html`
                <button class="button button--text" type="button" @click=${() => p.open(p.event ? "events" : "cards")}>
                  ${host.common("common.actions.cancel", "Cancel")}
                </button>
                <button class="button" type="button" @click=${() => p.save()}>${host.t("planner.save", "Save")}</button>
              `
        }
      </footer>
    </dialog>
  `;
}
