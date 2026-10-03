import type { EvidenceGap, OptimizationInput, TeamAssignment } from "../contracts.ts";
import { dataRows, nativeRow, type TeamBuilderData } from "../data.ts";
import { nativeGekisoAllComboDriverSupports } from "./native-gekiso-driver-profile.ts";
import {
  resolveSelectedGekisoSkills,
  resolveGekisoEffectFactorBP,
  type GekisoRuleIdentity,
  type GekisoResolved,
  type GekisoSelectedSkill,
  type GekisoSkillBinding,
} from "./gekiso-mission-luck.ts";

export interface NativeGekisoRangeUpdate {
  rangeIndex: number;
  /** Native managed simulate state; Ready3 is a start pulse, End8 clears it. */
  simulateState: number;
  mission: number;
  startTimeMs: number;
}
export interface NativeGekisoPhaseFrame {
  timeMs: number;
  /** Original CurrentFrameStateUpdateRangeIndexList order, not sorted by UI. */
  rangeUpdates: readonly NativeGekisoRangeUpdate[];
}
export interface NativeGekisoBasicWindow {
  binding: GekisoSkillBinding;
  effectId: number;
  family: "gauge" | "combo" | "just";
  frameMs: number;
  executeMs: number;
  finishMs: number;
  /** Frame which emitted EndFrame; the recorded finish time can be earlier. */
  finishFrameMs: number;
  factor: number;
}
export interface NativeGekisoBasicPhasePlan {
  windows: readonly NativeGekisoBasicWindow[];
  verifiedThroughMs: number;
  assumptions: readonly string[];
}
const f = Math.fround;
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
const gap = (code: string, source: string): EvidenceGap => ({ code, source });
const fail = <T>(code: string, source: string): GekisoResolved<T> => ({ value: null, gaps: [gap(code, source)] });
type SelectedGekiso = NonNullable<ReturnType<typeof resolveSelectedGekisoSkills>["value"]>;

/** Original GekisouRangeStartChecker.Check: one first matching new range per
 * check, original start-time override, persistent duplicate suppression. */
export function createNativeGekisoStartChecker(targetMissions: readonly number[]) {
  const triggered = new Set<number>();
  return {
    check(frame: NativeGekisoPhaseFrame): { rangeIndex: number; executeMs: number } | null {
      for (const update of frame.rangeUpdates) {
        if (update.simulateState === 8) {
          triggered.delete(update.rangeIndex);
          continue;
        }
        if (update.simulateState !== 3) continue;
        if (targetMissions.length && !targetMissions.includes(4) && !targetMissions.includes(update.mission)) continue;
        if (triggered.has(update.rangeIndex)) continue;
        triggered.add(update.rangeIndex);
        return { rangeIndex: update.rangeIndex, executeMs: update.startTimeMs };
      }
      return null;
    },
    reset() {
      triggered.clear();
    },
  };
}

/** RangePlaying checker registers Ready/Playing. Formal v25 clears7/8;
 * current v50 also clears Finish5. Override uses the first newly
 * registered range before target filtering, even when its mission differs. */
export function createNativeGekisoPlayingChecker(
  targetMissions: readonly number[],
  profile: "intl-formal-v25" | "intl-current-v50" = "intl-formal-v25",
) {
  const retained = new Map<number, number>();
  return {
    check(frame: NativeGekisoPhaseFrame): { executeMs: number | null } | null {
      let executeMs: number | null = null;
      for (const update of frame.rangeUpdates) {
        if (update.simulateState === 7 || update.simulateState === 8 ||
          (profile === "intl-current-v50" && update.simulateState === 5)) retained.delete(update.rangeIndex);
        else if ((update.simulateState === 3 || update.simulateState === 4) && !retained.has(update.rangeIndex)) {
          retained.set(update.rangeIndex, update.mission);
          executeMs ??= update.startTimeMs;
        }
      }
      const matches = retained.size > 0 &&
        (!targetMissions.length || targetMissions.includes(4) ||
          [...retained.values()].some((mission) => targetMissions.includes(mission)));
      return matches ? { executeMs } : null;
    },
    reset() { retained.clear(); },
  };
}

/** Prepare actual selected GK level rows once; physical photo holes and native
 * leader slot2 stay intact. Activation still requires native range frames. */
export function createNativeGekisoPhaseResolver(data: TeamBuilderData, input: OptimizationInput) {
  const members = new Map(input.members.map((member) => [member.instanceId, member]));
  const photos = new Map(input.snapshots.map((photo) => [photo.instanceId, photo]));
  const phase = new Map(
    dataRows(data.skillReference.effectSettings)
      .map(nativeRow)
      .map((row) => [Number(row.skillEffectType), Number(row.phase)]),
  );
  const sets = dataRows(data.skillReference.conditionSets).map(nativeRow);
  const conditions = new Map(
    dataRows(data.skillReference.conditions)
      .map(nativeRow)
      .map((row) => [Number(row.id), row]),
  );
  const targets = new Map(
    dataRows(data.skillReference.targets)
      .map(nativeRow)
      .map((row) => [Number(row.id), row]),
  );
  const samePin = (expected: GekisoRuleIdentity) =>
    expected.server === data.identity.server &&
    expected.releaseId === data.identity.releaseId &&
    !!expected.sourceId &&
    expected.sourceId === data.identity.sourceId;
  const selectSkill = (
    kind: "gekiso" | "gekisoSupport",
    id: number,
    level: number | null,
  ): GekisoResolved<GekisoSelectedSkill | null> => {
    if (id === 0) return { value: null, gaps: [] };
    if (!int(id) || !int(level) || level < 1) return fail("native-gekiso-selected-level-unresolved", `${kind}:${id}`);
    const row = data.skills[kind]?.[String(id)];
    if (!row || !int(row.gekisouMissionType) || row.gekisouMissionType > 4)
      return fail("native-gekiso-selected-mission-unresolved", `${kind}:${id}`);
    const timing = kind === "gekisoSupport" ? row.gekisouSupportSkillExecTiming : undefined;
    if (kind === "gekisoSupport" && !int(timing))
      return fail("native-gekiso-selected-timing-unresolved", `${kind}:${id}`);
    return {
      value: {
        id,
        level,
        mission: row.gekisouMissionType as GekisoSelectedSkill["mission"],
        effectRows: dataRows(row.effects),
        supportExecTiming: timing as number | undefined,
      },
      gaps: [],
    };
  };
  const triggerTargets = (group: number, conditionType: 7010 | 7020): readonly number[] | null => {
    const rows = sets.filter((row) => row.group === group);
    // OR/AND stateful checker composition is a separate exact runtime path.
    if (rows.length !== 1 || !Array.isArray(rows[0]!.conditionIds) || rows[0]!.conditionIds.length !== 1) return null;
    const condition = conditions.get(Number(rows[0]!.conditionIds[0]));
    if (
      !condition ||
      condition.conditionType !== conditionType ||
      condition.isPositive !== true ||
      !Array.isArray(condition.conditionValues) ||
      condition.conditionValues.length ||
      !Array.isArray(condition.conditionTargetIDs)
    )
      return null;
    const values: number[] = [];
    for (const id of condition.conditionTargetIDs) {
      const target = targets.get(Number(id));
      if (!target || target.skillTargetType !== 5 || !int(target.gekisouMissionType) || target.gekisouMissionType > 4)
        return null;
      values.push(target.gekisouMissionType);
    }
    return values;
  };
  return {
    select(assignment: TeamAssignment, expectedIdentity: GekisoRuleIdentity): GekisoResolved<SelectedGekiso> {
      if (
        !samePin(expectedIdentity) ||
        input.server !== data.identity.server ||
        input.releaseId !== data.identity.releaseId
      )
        return fail<SelectedGekiso>("native-gekiso-selected-source-mismatch", "same-pin selected GK factory");
      const ids = [...assignment.memberInstanceIds],
        slots = [...assignment.snapshotInstanceIds];
      const leader = ids.indexOf(assignment.leaderInstanceId);
      const owners = ids.map((id) => members.get(id));
      const selectedPhotos = slots.filter((id) => id !== null).map((id) => photos.get(id));
      if (
        ids.length !== 5 ||
        slots.length !== 5 ||
        leader < 0 ||
        new Set(ids).size !== 5 ||
        (owners.every((owner) => owner) &&
          (new Set(owners.map((owner) => owner!.cardId)).size !== 5 ||
            new Set(owners.map((owner) => owner!.characterId)).size !== 5)) ||
        new Set(slots.filter((id) => id !== null)).size !== selectedPhotos.length ||
        (selectedPhotos.every((photo) => photo) &&
          new Set(selectedPhotos.map((photo) => photo!.cardId)).size !== selectedPhotos.length)
      )
        return fail("native-gekiso-selected-formation-unresolved", "five selected physical slots");
      [ids[2], ids[leader]] = [ids[leader]!, ids[2]!];
      [slots[2], slots[leader]] = [slots[leader]!, slots[2]!];
      const selected = ids.map((id, index) => {
        const owner = members.get(id),
          photoId = slots[index],
          photo = photoId === null ? null : photos.get(photoId!);
        const gaps: EvidenceGap[] = [];
        if (!owner) gaps.push(gap("native-gekiso-selected-member-unresolved", id));
        if (photoId !== null && !photo) gaps.push(gap("native-gekiso-selected-photo-unresolved", String(photoId)));
        const member = owner
          ? selectSkill("gekiso", owner.gekisoSkillId, owner.gekisoSkillLevel)
          : { value: null, gaps: [] };
        gaps.push(...member.gaps);
        const supports: [GekisoSelectedSkill | null, GekisoSelectedSkill | null] = [null, null];
        if (photo) {
          if (photo.gekisoSupportSkills?.length !== 2)
            gaps.push(gap("native-gekiso-selected-physical-slots-unresolved", photo.instanceId));
          else
            photo.gekisoSupportSkills.forEach((skill, slot) => {
              const resolved = selectSkill("gekisoSupport", skill.id, skill.level);
              supports[slot] = resolved.value;
              gaps.push(...resolved.gaps);
            });
        }
        return { memberSkillIndex: index, member: member.value, supports, gaps };
      });
      return resolveSelectedGekisoSkills(selected);
    },
    compileBasic(
      assignment: TeamAssignment,
      expectedIdentity: GekisoRuleIdentity,
      frames: readonly NativeGekisoPhaseFrame[],
    ): GekisoResolved<NativeGekisoBasicPhasePlan> {
      const selected = this.select(assignment, expectedIdentity);
      if (!selected.value) return { value: null, gaps: selected.gaps };
      if (
        !Array.isArray(frames) ||
        frames.length > 10000 ||
        frames.some(
          (frame, index) =>
            !int(frame.timeMs) ||
            (index && frame.timeMs <= frames[index - 1]!.timeMs) ||
            !Array.isArray(frame.rangeUpdates) ||
            new Set(frame.rangeUpdates.map((update: NativeGekisoRangeUpdate) => update.rangeIndex)).size !==
              frame.rangeUpdates.length ||
            frame.rangeUpdates.some(
              (update: NativeGekisoRangeUpdate) =>
                !int(update.rangeIndex) ||
                update.rangeIndex > 2 ||
                !int(update.simulateState) ||
                update.simulateState > 8 ||
                !int(update.mission) ||
                update.mission < 1 ||
                update.mission > 3 ||
                !int(update.startTimeMs) ||
                (update.simulateState >= 3 && update.startTimeMs > frame.timeMs),
            ),
        )
      )
        return fail("native-gekiso-phase-frames-unresolved", "actual ordered range updates");
      if (selected.value.supports.length)
        return fail("native-gekiso-support-phase-factory-unresolved", "selected parent/live-start/rank support timing");
      const bindings = [...new Set(Object.values(selected.value.membersByMission).flat())];
      const windows: NativeGekisoBasicWindow[] = [],
        gaps: EvidenceGap[] = [];
      for (const binding of bindings)
        for (const row of binding.effectsAtLevel) {
          const source = `member:${binding.memberSkillIndex}/GK:${binding.skill.id}/effect:${row.id}`;
          const sustained = row.skillTriggerType === 2;
          const missions = triggerTargets(Number(row.skillTriggerConditionGroup), sustained ? 7020 : 7010);
          if (!missions || (!sustained && row.skillTriggerType !== 1)) {
            gaps.push(gap("native-gekiso-basic-trigger-unresolved", source));
            continue;
          }
          if (binding.skill.mission !== 4 && missions.some((mission) => mission !== binding.skill.mission)) {
            gaps.push(gap("native-gekiso-basic-member-mission-binding-unresolved", source));
            continue;
          }
          const family =
            row.skillEffectType === 11001
              ? "gauge"
              : row.skillEffectType === 12000
                ? "combo"
                : row.skillEffectType === 13000
                  ? "just"
                  : null;
          if (
            !family ||
            phase.get(Number(row.skillEffectType)) !== 2 ||
            !int(row.id) ||
            !int(row.effectValue) ||
            typeof row.activationTimeSecond !== "number" ||
            !Number.isFinite(f(row.activationTimeSecond)) ||
            (sustained ? row.activationTimeSecond !== 0 : row.activationTimeSecond <= 0) ||
            row.skillConditionGroup !== 0 ||
            row.skillReleaseConditionGroup !== 0 ||
            !Array.isArray(row.skillTargetIDs) ||
            row.skillTargetIDs.length ||
            [
              "skillCumulativeConditionID",
              "effectExecuteLimitCount",
              "effectExecuteLimitResetConditionGroup",
              "effectLimitCount",
              "maxEffectValue",
            ].some((key) => row[key] !== 0)
          ) {
            gaps.push(gap("native-gekiso-basic-effect-factory-unresolved", source));
            continue;
          }
          const factor = family === "gauge" ? resolveGekisoEffectFactorBP(row.effectValue).value : f(row.effectValue);
          if (factor === null || !Number.isFinite(factor)) {
            gaps.push(gap("native-gekiso-basic-value-unresolved", source));
            continue;
          }
          if (sustained) {
            // Current 1340B Check uses clear mask0x1a0 (5/7/8); formal
            // 1296B Check clears only7/8. This selects that checker dialect,
            // and does not grant public whole-GK source qualification.
            const checkerSource = expectedIdentity.sourceId;
            const profile = checkerSource === "v25-c0b6a1541e45-3a5d2eec9935-n653c6392"
              ? "intl-formal-v25"
              : checkerSource === "v50-e5786b7ddada-79f2f470b3cf-m73807cbb0192-n7ba0928c" ||
                nativeGekisoAllComboDriverSupports(data.identity)
                ? "intl-current-v50" : null;
            if (!profile) {
              gaps.push(gap("native-gekiso-playing-checker-source-unresolved", checkerSource ?? "sourceId"));
              continue;
            }
            const checker = createNativeGekisoPlayingChecker(missions, profile);
            let active: { state: 2 | 3 | 4; window: NativeGekisoBasicWindow } | null = null;
            for (const frame of frames) {
              const condition = checker.check(frame);
              // Zero-duration sustained updater returns EndFrame to its queue
              // before the current trigger can request another instance.
              if (active?.state === 4) active = null;
              else if (active?.state === 2) active.state = 3;
              if (!condition) {
                if (active) {
                  active.state = 4;
                  active.window.finishMs = frame.timeMs;
                  active.window.finishFrameMs = frame.timeMs;
                }
              } else if (!active) {
                const window: NativeGekisoBasicWindow = {
                  binding, effectId: row.id, family, frameMs: frame.timeMs,
                  executeMs: condition.executeMs ?? frame.timeMs,
                  finishMs: -1, finishFrameMs: -1, factor,
                };
                windows.push(window);
                active = { state: 2, window };
              }
            }
            if (active && active.state !== 4)
              gaps.push(gap("native-gekiso-basic-effect-horizon-unresolved", source));
            continue;
          }
          const checker = createNativeGekisoStartChecker(missions);
          const pulses = frames.flatMap((frame) => {
            const pulse = checker.check(frame);
            return pulse ? [{ frame, pulse }] : [];
          });
          if (!pulses.length) continue;
          const starts = new Map(pulses.map(({ frame, pulse }) => [frame.timeMs, pulse]));
          const durationMs = f(f(row.activationTimeSecond) * f(1000));
          let active: { state: 2 | 3 | 4; window: NativeGekisoBasicWindow } | null = null;
          let reusable = true;
          for (const frame of frames) {
            // Conditions/pop run before active updates; a returning instance
            // is unavailable to another request in the same frame.
            const availableBeforeUpdate = reusable,
              pulse = starts.get(frame.timeMs);
            if (active?.state === 4) {
              active = null;
              reusable = true;
            } else if (active) {
              const elapsed = f((frame.timeMs - active.window.executeMs) | 0);
              if ((active.state === 2 && durationMs <= elapsed) || (active.state === 3 && elapsed > durationMs)) {
                active.state = 4;
                active.window.finishFrameMs = frame.timeMs;
              } else active.state = 3;
            }
            if (!pulse) continue;
            const finishMs = pulse.executeMs + Math.ceil(durationMs);
            if (!availableBeforeUpdate || !int(finishMs) || finishMs <= pulse.executeMs || frame.timeMs >= finishMs) {
              gaps.push(gap("native-gekiso-basic-instance-reuse-needs-frames", source));
              break;
            }
            const window: NativeGekisoBasicWindow = {
              binding,
              effectId: row.id,
              family,
              frameMs: frame.timeMs,
              executeMs: pulse.executeMs,
              finishMs,
              finishFrameMs: -1,
              factor,
            };
            windows.push(window);
            active = { state: 2, window };
            reusable = false;
          }
          if (active && active.state !== 4) gaps.push(gap("native-gekiso-basic-effect-horizon-unresolved", source));
        }
      return gaps.length
        ? { value: null, gaps }
        : {
            value: {
              windows,
              verifiedThroughMs: frames.at(-1)?.timeMs ?? 0,
              assumptions: ["complete-native-update-frame-tape", "basic-GK-timed-and-sustained-member-effects"],
            },
            gaps: [],
          };
    },
  };
}
