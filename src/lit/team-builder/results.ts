/** Search results: ranked team cards, per-song rankings, plan summary, comparison. */
import { html, nothing, type TemplateResult } from "lit";
import type { EngineHit, SongRef, Timeline } from "../../lib/team-builder/engine/api";
import { cardIdOf } from "../../lib/team-builder/sync/box-view";
import { downloadBlob } from "../../lib/canvas-capture";
import { renderTeamResultImage, type ResultImageCard } from "../shared/team-result-image";
import { cardRarityName } from "../shared/rarity-icon";
import { iconButton } from "../ui/controls";
import { accordion } from "../ui/accordion";
import { collectionList } from "../ui/collection-view";
import { skillTimeline } from "../shared/skill-timeline";
import { ORDERS } from "../../lib/team-builder/engine/order-equivalence";
import { icon } from "../ui/icon";
import { tileMedia } from "../ui/tile";
import type { TeamBuilder } from "../team-builder";
import { resultSettings, SCORE_GOALS, scoreProof, scoreText } from "./score-goal";

const RANK_NAMES: Record<string, string> = { "1": "E", "2": "D", "3": "C", "4": "B", "5": "A", "6": "S", "7": "SS" };
export const timelines = new Map<string, Timeline | "loading" | "error">();

const format = (host: TeamBuilder, value: number, digits = 0) =>
  new Intl.NumberFormat(host.locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
const hitKey = (hit: EngineHit) => `${hit.song ? `${hit.song.songId}:${hit.song.difficulty}` : "-"}|${hit.members.join(",")}|${hit.snaps.join(",")}`;

function primary(host: TeamBuilder, hit: EngineHit): { label: string; value: string; unit?: string } {
  const s = resultSettings(host);
  if (s.goal === "power") return { label: host.t("power", "Power"), value: format(host, hit.power) };
  if (s.goal === "potential" && hit.potential) return { label: host.t("potential", "Potential"), value: format(host, hit.potential.value) };
  if ((s.goal === "event" || s.goal === "plan") && hit.event) {
    const label = s.measure === "items" && s.goal === "event" ? host.t("itemsPerPlay", "Items per play") : s.measure === "challenge-points" && s.goal === "event" ? host.t("cpPerPlay", "Challenge points per play") : host.t("pointsPerPlay", "Event points per play");
    return { label, value: format(host, s.measure === "challenge-points" && s.goal === "event" ? hit.event.challengePoints : hit.event.mean, 1) };
  }
  if (hit.score) return { label: scoreText(host, SCORE_GOALS[s.criterion].metric), value: format(host, hit.score[s.criterion]) };
  return { label: host.t("power", "Power"), value: format(host, hit.power) };
}

function chips(host: TeamBuilder, hit: EngineHit): TemplateResult[] {
  const s = resultSettings(host);
  const out: TemplateResult[] = [];
  const chip = (label: string, value: string, leading?: TemplateResult) => html`<span class="tb-chip">${leading ?? nothing}<span class="tb-chip__label">${label}</span><strong class="tabular">${value}</strong></span>`;
  if (s.goal !== "power") out.push(chip(host.t("power", "Power"), format(host, hit.power), icon("bolt", 16)));
  if (hit.score) {
    if ((s.goal !== "score" && s.goal !== "gekiso") || s.criterion !== "mean") out.push(chip(host.t("expectedScore", "Average score"), format(host, hit.score.mean)));
    out.push(chip(host.t("scoreRange", "Range"), `${format(host, hit.score.min)} – ${format(host, hit.score.max)}`));
    const ranks = Object.entries(hit.score.ranks).sort((a, b) => Number(b[0]) - Number(a[0]));
    const top = ranks[0];
    if (top) out.push(chip(RANK_NAMES[top[0]] ?? top[0], `${format(host, (top[1] / 120) * 100, top[1] === 120 ? 0 : 1)}%`, icon("workspace_premium", 16)));
  }
  if (hit.event) {
    out.push(chip(host.t("eventBonus", "Event bonus"), `+${format(host, hit.event.bonusPercent, 0)}%`, icon("trending_up", 16)));
    if (hit.event.challengePoints && s.measure !== "challenge-points") out.push(chip(host.t("cpPerPlay", "Challenge points per play"), format(host, hit.event.challengePoints, 1)));
  }
  if (hit.skipScore !== null) out.push(chip(host.t("skipScore", "Skip score"), format(host, hit.skipScore), icon("fast_forward", 16)));
  if (hit.potential) out.push(chip(host.t("skillCoverage", "Skill coverage"), `${format(host, hit.potential.area * 100, 0)}%·s`));
  return out;
}

export function formation(host: TeamBuilder, hit: EngineHit): TemplateResult {
  const catalog = host.catalog!;
  // The leader stands in the centre, as in the game's formation screen.
  const order = [1, 2, 0, 3, 4].filter((index) => index < hit.members.length);
  return html`
    <ol class="tb-formation" aria-label=${host.t("formation", "Formation")}>
      ${order.map((index) => {
        const member = cardIdOf(hit.members[index]!);
        const snapKey = hit.snaps[index];
        const snap = snapKey ? cardIdOf(snapKey) : null;
        const memberOptions = catalog.cardOptions("members", member);
        const snapOptions = snap !== null ? catalog.cardOptions("snaps", snap) : null;
        const owned = host.view?.members.get(member);
        return html`
          <li
            class=${`tb-slot${index === 0 ? " is-leader" : ""}`}
            title=${`${catalog.characterName(catalog.member(member)?.characterId ?? 0)} · ${host.t("slotPower", "Slot power")} ${format(host, hit.slotPowers[index] ?? 0)}`}
          >
            <button class="tb-slot__member" type="button" aria-label=${`${host.t("editGrowth", "Edit growth")}: ${memberOptions?.label ?? member}`}
              @click=${() => { host.editing = { kind: "members", cardId: member }; host.requestUpdate(); }}>
              ${memberOptions ? tileMedia({ ...memberOptions, marks: [...(memberOptions.marks ?? []), ...(index === 0 ? [{ at: "bottom-start" as const, text: host.t("leader", "Leader"), accent: "var(--md-sys-color-primary)" }] : [])] }) : nothing}
            </button>
            <button class="tb-slot__snap" type="button" ?disabled=${snap === null} aria-label=${snapOptions ? `${host.t("editGrowth", "Edit growth")}: ${snapOptions.label}` : host.t("noSnap", "No snap")}
              @click=${() => { if (snap !== null) { host.editing = { kind: "snaps", cardId: snap }; host.requestUpdate(); } }}>
              ${snapOptions ? tileMedia(snapOptions) : html`<span class="tb-slot__empty">${icon("hide_image", 20)}</span>`}
            </button>
            ${owned ? nothing : resultSettings(host).scope === "theoretical" ? html`<span class="tb-slot__flag">${host.t("notOwned", "Not owned")}</span>` : nothing}
          </li>
        `;
      })}
    </ol>
  `;
}

function distribution(host: TeamBuilder, hit: EngineHit, chart: SongRef | null): TemplateResult {
  const score = hit.score;
  if (!score) return html``;
  const thresholds = chart ? (host.master?.scoreRanks.get(host.master.songs.get(chart.songId)?.rankGroup ?? 0) ?? []) : [];
  const low = Math.min(score.min, ...thresholds.filter((row) => row.required >= score.min * 0.9 && row.required <= score.max * 1.05).map((row) => row.required));
  const high = Math.max(score.max, ...thresholds.filter((row) => row.required <= score.max * 1.1 && row.required >= score.min).map((row) => row.required));
  const span = Math.max(1, high - low);
  const at = (value: number) => `${(((value - low) / span) * 100).toFixed(2)}%`;
  return html`
    <div class="tb-dist" role="img" aria-label=${`${host.t("scoreRange", "Range")}: ${format(host, score.min)} – ${format(host, score.max)}, ${host.t("median", "median")} ${format(host, score.median)}`}>
      <div class="tb-dist__track">
        <span class="tb-dist__range" style=${`inset-inline-start:${at(score.min)};inset-inline-end:calc(100% - ${at(score.max)})`}></span>
        <span class="tb-dist__mark tb-dist__mark--median" style=${`inset-inline-start:${at(score.median)}`} title=${host.t("median", "median")}></span>
        <span class="tb-dist__mark tb-dist__mark--mean" style=${`inset-inline-start:${at(score.mean)}`} title=${host.t("mean", "mean")}></span>
        ${thresholds
          .filter((row) => row.required > low && row.required < high)
          .map((row) => html`<span class="tb-dist__threshold" style=${`inset-inline-start:${at(row.required)}`}><small>${RANK_NAMES[String(row.rank)]}</small></span>`)}
      </div>
      <div class="row row--between tb-dist__labels tabular"><span>${format(host, score.min)}</span><span>${host.t("median", "median")} ${format(host, score.median)}</span><span>${format(host, score.max)}</span></div>
      <div class="cluster">${Object.entries(score.ranks)
        .sort((a, b) => Number(b[0]) - Number(a[0]))
        .map(([rank, count]) => html`<span class="tb-chip"><span class="tb-chip__label">${RANK_NAMES[rank] ?? rank}</span><strong class="tabular">${format(host, (count / 120) * 100, count === 120 ? 0 : 1)}%</strong></span>`)}</div>
    </div>
  `;
}

const ORDER_INDEX = new Map(ORDERS.map((order, index) => [order.join(","), index]));
/** The order chosen in each result's skill-order editor, and the position picked for a swap. */
const orderChoice = new Map<string, number>();
const swapPick = new Map<string, number>();
/** Chart skill events in firing order, learned from the first timeline of each result. */
const firingOrder = new Map<string, number[]>();
/** The timeline on screen, kept while the next order's timeline loads. */
const shownTimeline = new Map<string, Timeline>();

function orderTimeline(host: TeamBuilder, hit: EngineHit, index: number) {
  const key = `${hitKey(hit)}|${index}`;
  const value = timelines.get(key);
  if (value) return value;
  timelines.set(key, "loading");
  const request = host.request();
  if (request && host.engine && hit.song)
    void host.engine
      .explain({ members: request.members, snaps: request.snaps, unknownPolicy: request.unknownPolicy, team: { members: hit.members, snaps: hit.snaps, leader: hit.members[0]! }, song: hit.song, eventOrder: ORDERS[index]!.map((slot) => hit.members[slot]!), play: { great: 0, good: 0, bad: 0, miss: 0 } })
      .then((timeline) => timelines.set(key, timeline))
      .catch(() => timelines.set(key, "error"))
      .finally(() => host.requestUpdate());
  return "loading" as const;
}

function memberFace(host: TeamBuilder, hit: EngineHit, slot: number) {
  const catalog = host.catalog!;
  const card = catalog.member(cardIdOf(hit.members[slot]!));
  const character = card?.characterId ?? 0;
  return { character, name: catalog.characterName(character), face: catalog.characterFace(character), card: card?.image ?? "", color: catalog.characterColor(character) };
}

function orderFaces(host: TeamBuilder, hit: EngineHit, index: number, firing: readonly number[]) {
  return html`<span class="tb-order-faces">${firing.map((event) => {
    const member = memberFace(host, hit, ORDERS[index]![event]!);
    return html`<img src=${member.face} alt=${member.name} title=${member.name} width="28" height="28" loading="lazy" decoding="async" style=${`--member-color:${member.color}`} />`;
  })}</span>`;
}

function skillOrderView(host: TeamBuilder, hit: EngineHit): TemplateResult {
  const score = hit.score;
  if (!hit.song || !score?.orders?.length) return html``;
  const key = hitKey(hit);
  const ranked = score.orders.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value || a.index - b.index);
  const best = ranked[0]!;
  const current = orderChoice.get(key) ?? best.index;
  const requested = orderTimeline(host, hit, current);
  if (typeof requested === "object") shownTimeline.set(key, requested);
  const timeline = typeof requested === "object" ? requested : (shownTimeline.get(key) ?? requested);
  if (typeof timeline === "object" && !firingOrder.has(key))
    firingOrder.set(key, [...timeline.windows].sort((a, b) => a.startMs - b.startMs || a.event - b.event).map((window) => window.event));
  const firing = firingOrder.get(key) ?? [0, 1, 2, 3, 4];
  const value = score.orders[current]!;
  const rank = score.orders.filter((other) => other > value).length + 1;
  const gap = (other: number) => (other === best.value ? "±0" : `−${format(host, best.value - other)}`);
  const choose = (index: number) => {
    orderChoice.set(key, index);
    swapPick.delete(key);
    host.requestUpdate();
  };
  const picked = swapPick.get(key);
  const pick = (position: number) => {
    if (picked === undefined) swapPick.set(key, position);
    else if (picked === position) swapPick.delete(key);
    else {
      const order = [...ORDERS[current]!];
      const a = firing[picked]!, b = firing[position]!;
      [order[a], order[b]] = [order[b]!, order[a]!];
      choose(ORDER_INDEX.get(order.join(","))!);
      return;
    }
    host.requestUpdate();
  };
  const first = firing[0]!;
  const byFirst = [0, 1, 2, 3, 4]
    .filter((slot) => slot < hit.members.length)
    .map((slot) => ranked.find((entry) => ORDERS[entry.index]![first] === slot)!)
    .sort((a, b) => b.value - a.value);
  const topOpen = host.expanded.has(`${key}|orders`);
  const rankOf = (other: number) => score.orders.filter((entry) => entry > other).length + 1;
  return html`
    <section class="tb-order stack">
      <div class="row row--wrap row--between">
        <strong class="tb-subtitle">${host.t("skillOrder", "Skill order")}</strong>
        <div class="cluster">
          <button class="button button--text button--small" type="button" ?disabled=${current === best.index} @click=${() => choose(best.index)}>${host.t("bestOrder", "Best order")}</button>
          <button class="button button--text button--small" type="button" ?disabled=${current === ranked.at(-1)!.index} @click=${() => choose(ranked.at(-1)!.index)}>${host.t("worstOrder", "Worst order")}</button>
        </div>
      </div>
      <ol class="tb-order-editor" role="list" aria-label=${host.t("skillOrder", "Skill order")}>
        ${firing.map((event, position) => {
          const member = memberFace(host, hit, ORDERS[current]![event]!);
          return html`<li>
            <button type="button" class="tb-order-slot" aria-pressed=${String(picked === position)} ?data-swap=${picked !== undefined && picked !== position}
              aria-label=${`${position + 1} · ${member.name}`} title=${member.name} style=${`--member-color:${member.color}`}
              @click=${() => pick(position)}>
              <span class="tb-order-slot__index">${position + 1}</span>
              <img src=${member.card} alt="" width="48" height="64" decoding="async" />
              <span class="tb-order-slot__swap">${icon("swap_horiz", 18)}</span>
            </button>
          </li>`;
        })}
      </ol>
      <dl class="spec-list spec-list--split spec-list--numeric">
        <div><dt>${host.t("score", "Score")}</dt><dd>${format(host, value)}</dd></div>
        <div><dt>${host.t("orderRank", "Rank")}</dt><dd>${rank} / ${score.orders.length}</dd></div>
        <div><dt>${host.t("orderGap", "From best")}</dt><dd>${gap(value)}</dd></div>
      </dl>
      <div class="tb-order__timeline" aria-busy=${String(typeof requested !== "object")}>
      ${typeof timeline === "object"
        ? skillTimeline({
            label: host.t("timeline", "Skill timeline"),
            durationMs: timeline.durationMs,
            density: timeline.density,
            fever: timeline.fever,
            feverLabel: (index) => `${host.t("gekiso", "Gekisou")} ${index + 1}`,
            windows: timeline.windows.map((window) => {
              const member = memberFace(host, hit, hit.members.indexOf(window.member));
              return {
                startMs: window.startMs,
                endMs: window.endMs,
                color: member.color,
                image: member.face,
                label: member.name,
                value: `+${format(host, window.percent + window.perfectPercent, 0)}%${window.extensionMs ? ` · +${(window.extensionMs / 1000).toFixed(1)}s` : ""}`,
              };
            }),
          })
        : timeline === "error"
          ? html`<p class="inline-message">${host.t("timelineFailed", "The timeline could not be drawn.")}</p>`
          : html`<div class="skill-timeline__plot" aria-label=${host.t("loadingTimeline", "Loading skill timeline")}></div>`}
      </div>
      <div class="stack stack--tight">
        <strong class="tb-subtitle">${host.t("firstSkill", "Best order by first skill")}</strong>
        ${collectionList(
          byFirst.map((entry) => {
            const member = memberFace(host, hit, ORDERS[entry.index]![first]!);
            return {
              id: String(entry.index),
              title: member.name,
              subtitle: html`<span class="tabular" title=${format(host, entry.value)}>${gap(entry.value)}</span>`,
              media: html`<img src=${member.card} alt="" width="42" height="56" decoding="async" />`,
              trailing: orderFaces(host, hit, entry.index, firing),
              onOpen: () => choose(entry.index),
            };
          }),
        )}
      </div>
      ${accordion({
        id: `tb-orders-${key.replace(/[^a-z0-9]/giu, "-")}`,
        label: host.t("topOrders", "Top orders"),
        metadata: "10",
        expanded: topOpen,
        onExpandedChange: (open) => {
          if (open) host.expanded.add(`${key}|orders`);
          else host.expanded.delete(`${key}|orders`);
          host.requestUpdate();
        },
        content: collectionList(
          ranked.slice(0, 10).map((entry) => ({
            id: String(entry.index),
            title: orderFaces(host, hit, entry.index, firing),
            subtitle: html`<span class="tabular">${format(host, entry.value)} · ${gap(entry.value)}</span>`,
            media: html`<span class="tb-order-rank tabular">${rankOf(entry.value)}</span>`,
            onOpen: () => choose(entry.index),
          })),
        ),
      })}
    </section>
  `;
}

async function exportImage(host: TeamBuilder, hit: EngineHit) {
  const catalog = host.catalog!;
  const style = getComputedStyle(host);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const card = (kind: "members" | "snaps", id: number, leader: boolean): ResultImageCard => {
    const entry = kind === "members" ? catalog.member(id) : catalog.snap(id);
    const characters = catalog.characterIds(kind, id);
    return {
      title: catalog.cardName(kind, id),
      character: characters.map((character) => catalog.characterName(character)).join(" · "),
      image: entry?.image ?? "",
      avatars: characters.map((character) => catalog.characterFace(character)).filter(Boolean),
      attribute: catalog.attributeIcon(entry?.attribute ?? 0) || undefined,
      rarity: catalog.rarityIcon(entry?.rarity ?? 0) || undefined,
      attributeLabel: catalog.attributeName(entry?.attribute ?? 0),
      rarityLabel: cardRarityName(entry?.rarity ?? 0),
      leader,
      facts: [],
    };
  };
  const main = primary(host, hit);
  const blob = await renderTeamResultImage({
    title: host.t("title", "Team builder"),
    subtitle: hit.song ? `${catalog.songTitle(hit.song.songId)} · ${catalog.difficultyLabel(hit.song.songId, hit.song.difficulty)}` : main.label,
    membersLabel: host.t("members", "Members"),
    snapshotsLabel: host.t("snapshots", "Snaps"),
    leaderLabel: host.t("leader", "Leader"),
    emptyLabel: host.t("noSnap", "No snap"),
    imageUnavailableLabel: host.t("imageUnavailable", "Image unavailable"),
    members: hit.members.map((key, index) => card("members", cardIdOf(key), index === 0)),
    snapshots: hit.snaps.map((key) => (key ? card("snaps", cardIdOf(key), false) : null)),
    metrics: [
      { label: main.label, value: main.value, detail: "" },
      { label: host.t("power", "Power"), value: format(host, hit.power), detail: "" },
      ...(hit.score ? [{ label: host.t("scoreRange", "Range"), value: `${format(host, hit.score.min)} – ${format(host, hit.score.max)}`, detail: "" }] : []),
    ],
    footer: ["haneoka.org"],
    server: catalog.data.identity.server,
    releaseId: catalog.data.identity.releaseId,
    theme: {
      surface: token("--md-sys-color-surface", "#fff"),
      container: token("--md-sys-color-surface-container", "#f3f3f3"),
      text: token("--md-sys-color-on-surface", "#111"),
      muted: token("--md-sys-color-on-surface-variant", "#555"),
      primary: token("--md-sys-color-primary", "#4455aa"),
      outline: token("--md-sys-color-outline-variant", "#ccc"),
      font: token("--app-font", "sans-serif"),
    },
  });
  downloadBlob(blob, "team.png");
}

function copyText(host: TeamBuilder, hit: EngineHit) {
  const catalog = host.catalog!;
  const main = primary(host, hit);
  const lines = [
    hit.song ? `${catalog.songTitle(hit.song.songId)} ${catalog.difficultyLabel(hit.song.songId, hit.song.difficulty)}` : "",
    `${main.label}: ${main.value} · ${host.t("power", "Power")}: ${format(host, hit.power)}`,
    ...hit.members.map((key, index) => {
      const snap = hit.snaps[index];
      return `${index === 0 ? `[${host.t("leader", "Leader")}] ` : ""}${catalog.cardName("members", cardIdOf(key))} (${catalog.characterName(catalog.member(cardIdOf(key))?.characterId ?? 0)}) + ${snap ? catalog.cardName("snaps", cardIdOf(snap)) : "—"}`;
    }),
  ].filter(Boolean);
  void navigator.clipboard?.writeText(lines.join("\n")).then(() => {
    host.notice = host.t("copied", "Copied");
    host.requestUpdate();
  });
}

export function saveTeam(host: TeamBuilder, members: number[], snaps: (number | null)[], song: SongRef | null, name?: string) {
  const id = (crypto.randomUUID?.() ?? `${Date.now()}`).replace(/[^a-z0-9-]/gu, "").slice(0, 36);
  const catalog = host.catalog!;
  const label = name ?? `${catalog.characterName(catalog.member(members[0]!)?.characterId ?? 0)} · ${song ? catalog.songTitle(song.songId) : host.t("noSong", "No song")}`;
  host.write([{ key: `team.${id}`, value: { name: label.slice(0, 80), members, snaps, leader: members[0] ?? null, song, createdAt: Date.now() } }]);
  host.notice = host.t("savedTeam", "Saved to Teams");
  host.requestUpdate();
}

function renderHit(host: TeamBuilder, hit: EngineHit, index: number): TemplateResult {
  const key = hitKey(hit);
  const expanded = host.expanded.has(key);
  const compared = host.compare.includes(key);
  const main = primary(host, hit);
  const catalog = host.catalog!;
  return html`
    <article class=${`card card--outlined tb-hit${index === 0 ? " is-best" : ""}`} aria-label=${`#${index + 1} · ${main.label} ${main.value}`}>
      <header class="tb-hit__header">
        <span class="tb-hit__rank">${index + 1}</span>
        <div class="tb-hit__main">
          <span class="tb-hit__label">${main.label}${hit.song && resultSettings(host).songs.length > 1 ? html` · <span class="clamp-1">${catalog.songTitle(hit.song.songId)} ${catalog.difficultyLabel(hit.song.songId, hit.song.difficulty)}</span>` : nothing}</span>
          <strong class="tb-hit__value tabular">${main.value}</strong>
        </div>
        <div class="tb-hit__actions">
          ${iconButton({ icon: "bookmark_add", label: host.t("saveTeam", "Save team"), onClick: () => saveTeam(host, hit.members.map(cardIdOf), hit.snaps.map((snap) => (snap ? cardIdOf(snap) : null)), hit.song) })}
          ${iconButton({ icon: "compare_arrows", label: host.t("compare", "Compare"), toggle: true, pressed: compared, onClick: () => {
            host.compare = compared ? host.compare.filter((item) => item !== key) : [...host.compare, key].slice(-3);
            host.requestUpdate();
          } })}
          ${iconButton({ icon: "content_copy", label: host.t("copyTeam", "Copy as text"), onClick: () => copyText(host, hit) })}
          ${iconButton({ icon: "image", label: host.t("saveImage", "Save image"), onClick: () => void exportImage(host, hit) })}
        </div>
      </header>
      <div class="cluster tb-hit__chips">${chips(host, hit)}</div>
      ${formation(host, hit)}
      <button class="button button--text tb-hit__more" type="button" aria-expanded=${String(expanded)} @click=${() => {
        if (expanded) host.expanded.delete(key);
        else host.expanded.add(key);
        host.requestUpdate();
      }}>${icon(expanded ? "expand_less" : "expand_more", 18)}${expanded ? host.t("lessDetail", "Less") : host.t("moreDetail", "Details")}</button>
      ${expanded
        ? html`<div class="tb-hit__detail stack">
            ${distribution(host, hit, hit.song)}
            ${skillOrderView(host, hit)}
          </div>`
        : nothing}
    </article>
  `;
}

function compareTable(host: TeamBuilder, hits: EngineHit[]): TemplateResult {
  const picked = host.compare.map((key) => hits.find((hit) => hitKey(hit) === key)).filter((hit): hit is EngineHit => !!hit);
  if (picked.length < 2) return html``;
  const catalog = host.catalog!;
  const rows: [string, (hit: EngineHit) => string][] = [
    [host.t("power", "Power"), (hit) => format(host, hit.power)],
    ...(picked.some((hit) => hit.score) ? ([
      [host.t("expectedScore", "Expected score"), (hit) => (hit.score ? format(host, hit.score.mean) : "—")],
      [host.t("worstScore", "Worst-order score"), (hit) => (hit.score ? format(host, hit.score.min) : "—")],
      [host.t("bestScore", "Best-order score"), (hit) => (hit.score ? format(host, hit.score.max) : "—")],
    ] as [string, (hit: EngineHit) => string][]) : []),
    ...(picked.some((hit) => hit.event) ? ([
      [host.t("pointsPerPlay", "Event points per play"), (hit) => (hit.event ? format(host, hit.event.mean, 1) : "—")],
      [host.t("eventBonus", "Event bonus"), (hit) => (hit.event ? `+${format(host, hit.event.bonusPercent)}%` : "—")],
    ] as [string, (hit: EngineHit) => string][]) : []),
    [host.t("leader", "Leader"), (hit) => catalog.characterName(catalog.member(cardIdOf(hit.members[0]!))?.characterId ?? 0)],
  ];
  return html`
    <section class="surface stack tb-compare">
      <div class="row row--between"><strong class="tb-subtitle">${host.t("comparison", "Comparison")}</strong>
        <button class="button button--text button--small" type="button" @click=${() => { host.compare = []; host.requestUpdate(); }}>${host.common("common.actions.clear", "Clear")}</button></div>
      <div class="scroll-x"><table class="table tb-compare__table">
        <thead><tr><th></th>${picked.map((hit) => html`<th>#${hits.indexOf(hit) + 1}</th>`)}</tr></thead>
        <tbody>${rows.map(([label, value]) => {
          const values = picked.map(value);
          return html`<tr><th scope="row">${label}</th>${values.map((item) => html`<td class="tabular">${item}</td>`)}</tr>`;
        })}</tbody>
      </table></div>
    </section>
  `;
}

export function renderResults(host: TeamBuilder): TemplateResult {
  const results = host.results;
  if (!results) {
    return html`
      <section class="surface tb-results tb-results--empty">
        <div class="state">
          <span class="state__icon">${icon("groups", 40)}</span>
          <p class="state__title">${host.t("resultsEmpty", "Results appear here")}</p>
        </div>
      </section>
    `;
  }
  const catalog = host.catalog!;
  const multi = results.results.length > 1 && resultSettings(host).goal !== "plan";
  const tab = multi ? host.resultTab : "all";
  const shown = tab === "overall" || !multi ? (multi ? results.overall : results.results[0]?.hits ?? []) : (results.results.find((result) => result.song && `${result.song.songId}:${result.song.difficulty}` === tab)?.hits ?? []);
  const groups = multi && tab !== "overall" ? results.results.filter((result) => result.song && `${result.song.songId}:${result.song.difficulty}` === tab) : results.results;
  const proven = groups.length > 0 && groups.every((result) => result.proven);
  const stats = results.results.reduce((total, result) => total + result.stats.exact, 0);
  return html`
    <section class="tb-results stack" aria-live="polite">
      <div class="row row--wrap row--between tb-results__summary">
        <span class=${`tb-proof${proven ? " is-proven" : ""}`}>${icon(proven ? "verified" : "hourglass_bottom", 18)}${scoreProof(host, proven)}</span>
        ${host.stale
          ? html`<button class="button button--tonal button--small" type="button" title=${host.t("staleResults", "Conditions changed since this search.")} @click=${() => void host.run()}>${icon("refresh", 18)}${host.t("rerun", "Search again")}</button>`
          : html`<span class="tb-results__meta tabular">${host.t("resultMeta", "{ms} ms · {exact} teams simulated exactly", { ms: format(host, results.elapsedMs), exact: stats })}</span>`}
      </div>
      ${results.unknownCards.length ? html`<p class="inline-message">${host.t("unknownCards", "{count} saved cards are not in this data release and were skipped.", { count: results.unknownCards.length })}</p>` : nothing}
      ${results.plan
        ? html`<section class="surface surface--tonal stack tb-plan">
            <strong class="tb-subtitle">${host.t("planTotal", "Total event points")}</strong>
            <strong class="tb-hit__value tabular">${format(host, results.plan.eventPoints)}</strong>
            <div class="cluster">
              <span class="tb-chip"><span class="tb-chip__label">${host.t("normalLives", "Normal lives")}</span><strong>${results.plan.normalLives}</strong></span>
              <span class="tb-chip"><span class="tb-chip__label">${host.t("challengeLives", "Challenge lives")}</span><strong>${results.plan.challengeLives}</strong></span>
              <span class="tb-chip"><span class="tb-chip__label">${host.t("cpEarned", "Challenge points earned")}</span><strong>${format(host, results.plan.challengePointsEarned)}</strong></span>
              <span class="tb-chip"><span class="tb-chip__label">${host.t("cpLeft", "Left over")}</span><strong>${format(host, results.plan.leftoverChallengePoints)}</strong></span>
              <span class="tb-chip"><span class="tb-chip__label">${host.t("perBoost", "Per boost")}</span><strong>${format(host, results.plan.perBoost, 1)}</strong></span>
            </div>
          </section>`
        : nothing}
      ${multi
        ? html`<nav class="tabs tabs--secondary tb-song-tabs" role="tablist" aria-label=${host.t("songs", "Songs")}>
            ${[{ id: "overall", label: host.t("overall", "Overall") }, ...results.results.map((result) => ({ id: `${result.song!.songId}:${result.song!.difficulty}`, label: `${catalog.songTitle(result.song!.songId)} ${catalog.difficultyLabel(result.song!.songId, result.song!.difficulty)}` }))].map(
              (item) => html`<button class="tab" type="button" role="tab" aria-selected=${String(tab === item.id)} @click=${() => { host.resultTab = item.id; host.requestUpdate(); }}>
                <span class="clamp-1">${item.label}</span><span class="tab__indicator"></span></button>`,
            )}
          </nav>`
        : nothing}
      ${compareTable(host, shown)}
      ${shown.length
        ? shown.map((hit, index) => renderHit(host, hit, index))
        : html`<div class="state"><p class="state__title">${host.t("noTeams", "No team meets these conditions")}</p></div>`}
    </section>
  `;
}
