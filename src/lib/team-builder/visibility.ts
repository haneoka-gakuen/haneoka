// L3 — GEB
// Input: Pinned team data, active visibility policy and account entries.
// Output: Eligible cards and events for the workspace and its engine, with a matching inventory view.
// Pos: [Map](L2-2.md); workspace projection shared by selection, calculations and saved formations.
// Effects/Dependencies: Reads the current presentation policy. Source data and stored account entries are preserved.
import { isContentListed, isContentVisible } from "../content-release";
import type { DataRow, MemberCatalog, SnapshotCatalog, TeamBuilderData } from "./data";
import { plannerMetadata } from "./planner-data";
import type { BoxView, SavedTeam } from "./sync/box-view";

export type TeamCardKind = "members" | "snaps";
type Card = MemberCatalog | SnapshotCatalog;
const resource = (kind: TeamCardKind) => kind === "members" ? "cards" : "support-cards";

export function teamCardDetailsVisible(kind: TeamCardKind, card: Card): boolean {
  return typeof plannerMetadata(card).active === "boolean" || isContentVisible(resource(kind), card, String(card.id));
}

export function teamEventDetailsVisible(event: DataRow): boolean {
  return event.kind === "planner-event" || isContentVisible("events", event, String(event.id));
}

function listed<T>(rows: Record<string, T>, visible: (row: T, id: string) => boolean): Record<string, T> {
  const entries = Object.entries(rows);
  const accepted = entries.filter(([id, row]) => visible(row, id));
  return accepted.length === entries.length ? rows : Object.fromEntries(accepted);
}

export function visibleTeamBuilderData(data: TeamBuilderData): TeamBuilderData {
  const cardListed = (kind: TeamCardKind, card: Card) => {
    const local = plannerMetadata(card);
    return typeof local.active === "boolean" || isContentListed(resource(kind), card, String(card.id));
  };
  const members = listed(data.members, (card) => cardListed("members", card));
  const snapshots = listed(data.snapshots, (card) => cardListed("snaps", card));
  const events = listed(data.events, (row, id) => row.kind === "planner-event" || isContentListed("events", row, id));
  if (members === data.members && snapshots === data.snapshots && events === data.events) return data;
  return { ...data, members, snapshots, events };
}

export function visibleTeamBox(view: BoxView, data: TeamBuilderData): BoxView {
  const hasMember = (id: number) => Object.hasOwn(data.members, String(id));
  const hasSnapshot = (id: number) => Object.hasOwn(data.snapshots, String(id));
  const visibleSavedTeam = (team: SavedTeam): SavedTeam => {
    const slots = team.members.flatMap((member, index) => {
      if (!hasMember(member)) return [];
      const snap = team.snaps[index] ?? null;
      return [{ member, snap: snap !== null && hasSnapshot(snap) ? snap : null }];
    });
    return {
      ...team,
      members: slots.map(({ member }) => member),
      snaps: slots.map(({ snap }) => snap),
      leader: team.leader !== null && hasMember(team.leader) ? team.leader : null,
    };
  };
  return {
    ...view,
    members: new Map([...view.members].filter(([id]) => hasMember(id))),
    snaps: new Map([...view.snaps].filter(([id]) => hasSnapshot(id))),
    teams: view.teams.map(visibleSavedTeam),
  };
}
