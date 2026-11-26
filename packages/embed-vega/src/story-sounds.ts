import type { AdvStory } from "@haneoka/vega/engine";

type Command = NonNullable<AdvStory["commands"]>[number];
type Sound = NonNullable<Command["bgm"]>;

export const cueResourceKey = (cue: string) => `embed-cue:${encodeURIComponent(cue)}`;

/** Fill existing cue slots before Vega plans audio preload and playback. */
export function bindStorySounds(story: AdvStory, cues: ReadonlySet<string>): AdvStory {
  const assets = story.assets as { sounds?: Record<string, Sound> | Sound[] } | undefined;
  const soundEntries = Object.entries(assets?.sounds ?? {});
  const soundByKey = new Map<string, Sound>();
  const keys = (sound?: Sound | null) => [sound?.soundId, sound?.id, sound?.cueId, sound?.cueName];
  for (const [key, sound] of soundEntries) {
    if (!sound || typeof sound !== "object") continue;
    for (const id of [key, ...keys(sound)]) {
      if (id != null) soundByKey.set(String(id), sound);
    }
  }
  const mapped = (sound: Sound | null | undefined, ...ids: unknown[]): Sound | undefined => {
    const candidates = [...keys(sound), ...ids].filter((id) => id != null).map(String);
    const entry = candidates.map((id) => soundByKey.get(id)).find(Boolean);
    const cue = [
      ...candidates,
      ...keys(entry)
        .filter((id) => id != null)
        .map(String),
    ].find((id) => cues.has(id));
    if (cue === undefined) return sound ?? undefined;
    const soundId = Number(cue);
    return {
      ...(Number.isSafeInteger(soundId) && soundId > 0 ? { soundId } : {}),
      ...entry,
      ...sound,
      playableUrl: cueResourceKey(cue),
    };
  };
  const usedChatSounds = new Map<number, Sound>();
  const visit = (command: Command): Command => {
    const bgm = mapped(command.bgm, command.bgmId, command.bgmRef);
    const se = mapped(command.se, command.seId, command.seRef);
    const chatSound = mapped(command.chatSound, command.chatSoundId);
    const voiceIds = Array.isArray(command.voiceIds) ? command.voiceIds : [];
    const voiceRefs = Array.isArray(command.voiceRefs) ? command.voiceRefs : [];
    const voices = (command.voices ?? []).map((voice) => ({
      ...mapped(voice),
      ...(voice.chatSound ? { chatSound: mapped(voice.chatSound)! } : {}),
    }));
    for (const [index, id] of (voiceIds.length ? voiceIds : voiceRefs).entries()) {
      const source = mapped(undefined, id, voiceIds.length === voiceRefs.length ? voiceRefs[index] : undefined);
      if (!source) continue;
      const match = voices.findIndex((voice) =>
        keys(voice).some((key) => key != null && keys(source).some((value) => String(value) === String(key))),
      );
      if (match < 0) voices.push(source);
    }
    const master = story.runtime?.chatAssets?.masters?.[String(command.targetChatID ?? "")];
    if (master) {
      for (const id of [master.chatSoundId, master.inOutSoundId]) {
        const entry = mapped(undefined, id);
        if (entry) usedChatSounds.set(id, { ...entry, soundId: id });
      }
    }
    return {
      ...command,
      ...(bgm ? { bgm } : {}),
      ...(se ? { se } : {}),
      ...(chatSound ? { chatSound } : {}),
      ...(voices.length ? { voices } : {}),
      ...(command.timeline
        ? {
            timeline: {
              ...command.timeline,
              signals: command.timeline.signals.map((s) => ({ ...s, episode: visit(s.episode) })),
            },
          }
        : {}),
      ...(command.commandGroup
        ? {
            commandGroup: {
              ...command.commandGroup,
              actions: command.commandGroup.actions.map((action) => ({ ...action, command: visit(action.command) })),
            },
          }
        : {}),
    };
  };
  const commands = story.commands?.map(visit);
  const sounds = soundEntries.flatMap<Sound>(([key, sound]) => {
    const entry = mapped(sound, key);
    const replacement = usedChatSounds.get(Number(entry?.soundId ?? entry?.id));
    if (replacement) usedChatSounds.delete(replacement.soundId!);
    return replacement ?? entry ?? [];
  });
  return {
    ...story,
    ...(commands ? { commands } : {}),
    assets: { ...assets, sounds: [...sounds, ...usedChatSounds.values()] },
  };
}
