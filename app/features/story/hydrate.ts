import { storyResourceAliases, type StoryResourceKind } from "@haneoka/story-editor";

const collectionValues = (value: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(value))
    return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
  if (value && typeof value === "object")
    return Object.values(value).filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object"),
    );
  return [];
};

const indexBy = (value: unknown, keysOf: (entry: Record<string, unknown>) => unknown[]) => {
  const result = new Map<string, Record<string, unknown>>();
  for (const entry of collectionValues(value)) {
    for (const key of keysOf(entry)) {
      const identity = String(key ?? "").trim();
      if (identity && !result.has(identity)) result.set(identity, entry);
    }
  }
  return result;
};

const resourceIndex = (value: unknown, kind: StoryResourceKind) =>
  indexBy(value, (entry) => [...storyResourceAliases(kind, entry)]);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export interface StoryHydrationMissingResource {
  kind: string;
  reference: string;
}

export interface StoryHydrationOptions {
  /** Editor previews omit unresolved media while normal playback remains strict. */
  missingResource?: "throw" | "omit";
  onMissingResource?: (resource: StoryHydrationMissingResource) => void;
}

const unresolvedResource = (key: unknown, kind: string, options: StoryHydrationOptions): undefined => {
  const identity = String(key || "");
  if (options.missingResource !== "omit") {
    throw new Error(`Story ${kind} reference is unresolved: ${identity || "<empty>"}`);
  }
  options.onMissingResource?.({ kind, reference: identity });
  return undefined;
};

const resolvedEntry = (
  registry: Record<string, unknown>,
  key: unknown,
  kind: string,
  options: StoryHydrationOptions,
): Record<string, unknown> | undefined => {
  const identity = String(key || "");
  const value = registry[identity];
  return identity && value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : unresolvedResource(identity, kind, options);
};

const resolvedIndexedEntry = (
  registry: Map<string, Record<string, unknown>>,
  key: unknown,
  kind: string,
  options: StoryHydrationOptions,
): Record<string, unknown> | undefined => {
  const identity = String(key ?? "").trim();
  const value = registry.get(identity);
  return identity && value ? value : unresolvedResource(identity, kind, options);
};

const presentRecords = (values: Array<Record<string, unknown> | undefined>): Record<string, unknown>[] =>
  values.filter((value): value is Record<string, unknown> => value !== undefined);

export const hydrateStoryPayload = (
  payload: Record<string, unknown>,
  options: StoryHydrationOptions = {},
): Record<string, unknown> => {
  const assets = (payload.assets || {}) as Record<string, unknown>;
  const runtime = record(payload.runtime);
  const postEffects = record(runtime.postEffects);
  const stages = record(runtime.stages);
  const chatPresets = record(record(runtime.chatAssets).presetsByRef);
  const hydratedStages = new Map<string, Record<string, unknown>>();
  const hydrateStage = (key: unknown) => {
    const identity = String(key || "");
    const cached = hydratedStages.get(identity);
    if (cached) return cached;
    const stage = resolvedEntry(stages, identity, "stage", options);
    if (!stage) return undefined;
    const refs = stage.environmentPostEffectRefs;
    const hydrated = {
      ...stage,
      environmentPostEffects: Array.isArray(refs)
        ? presentRecords(refs.map((reference) => resolvedEntry(postEffects, reference, "post-effect", options)))
        : [],
    };
    hydratedStages.set(identity, hydrated);
    return hydrated;
  };
  const backgroundEntries = collectionValues(assets.backgrounds).map((entry) => ({
    ...entry,
    stage: entry.stageRef ? hydrateStage(entry.stageRef) : undefined,
  }));
  const backgrounds = resourceIndex(backgroundEntries, "background");
  const stills = resourceIndex(assets.stills, "still");
  const sounds = resourceIndex(assets.sounds, "sound");
  const frames = resourceIndex(assets.frames, "frame");
  const effects = resourceIndex(assets.effects, "effect");
  const videos = resourceIndex(assets.videos, "video");
  const live2d = resourceIndex(assets.live2d, "live2d");

  const hydrateCommand = (input: unknown): unknown => {
    if (!input || typeof input !== "object") return input;
    const command = input as Record<string, unknown>;
    const {
      backgroundRef,
      stillRef,
      bgmRef,
      seRef,
      voiceRefs,
      postEffectRef,
      frameRef,
      effectRef,
      videoRef,
      timeline,
      commandGroup,
      ...fields
    } = command;
    const result: Record<string, unknown> = { ...fields };
    if (!result.background && backgroundRef) {
      const value = resolvedIndexedEntry(backgrounds, backgroundRef, "background", options);
      if (value) result.background = value;
    }
    if (!result.still && stillRef) {
      const value = resolvedIndexedEntry(stills, stillRef, "still", options);
      if (value) result.still = value;
    }
    if (!result.bgm && bgmRef) {
      const value = resolvedIndexedEntry(sounds, bgmRef, "BGM", options);
      if (value) result.bgm = value;
    }
    if (!result.se && seRef) {
      const value = resolvedIndexedEntry(sounds, seRef, "sound-effect", options);
      if (value) result.se = value;
    }
    if (!result.postEffect && postEffectRef) {
      const value = resolvedEntry(postEffects, postEffectRef, "post-effect", options);
      if (value) result.postEffect = value;
    }
    if (!result.frame && frameRef) {
      const value = resolvedIndexedEntry(frames, frameRef, "frame", options);
      if (value) result.frame = value;
    }
    if (!result.effect && effectRef) {
      const value = resolvedIndexedEntry(effects, effectRef, "effect", options);
      if (value) result.effect = value;
    }
    if (!result.video && videoRef) {
      const value = resolvedIndexedEntry(videos, videoRef, "video", options);
      if (value) result.video = value;
    }
    const needsHydratedVoices = result.voices == null || (Array.isArray(result.voices) && result.voices.length === 0);
    if (needsHydratedVoices && Array.isArray(voiceRefs)) {
      result.voices = presentRecords(voiceRefs.map((key) => resolvedIndexedEntry(sounds, key, "voice", options)));
    }
    if (!result.live2d && result.live2dKey) {
      const value = resolvedIndexedEntry(live2d, result.live2dKey, "Live2D", options);
      if (value) result.live2d = value;
    }
    if (result.chatPresetRef) {
      const preset = resolvedEntry(chatPresets, result.chatPresetRef, "chat preset", options);
      if (preset) {
        const targetChatID = Number(preset.id);
        if (!Number.isSafeInteger(targetChatID) || targetChatID <= 0) {
          if (options.missingResource !== "omit") {
            throw new Error(`Story chat preset has an invalid native identity: ${String(result.chatPresetRef)}`);
          }
          options.onMissingResource?.({ kind: "chat preset", reference: String(result.chatPresetRef) });
        } else if (!Number.isSafeInteger(Number(result.targetChatID)) || Number(result.targetChatID) <= 0) {
          result.targetChatID = targetChatID;
        }
      }
    }
    if (timeline && typeof timeline === "object") {
      const timelineRecord = timeline as Record<string, unknown>;
      result.timeline = {
        ...timelineRecord,
        signals: Array.isArray(timelineRecord.signals)
          ? timelineRecord.signals.map((signal) => {
              if (!signal || typeof signal !== "object") return signal;
              const record = signal as Record<string, unknown>;
              return { ...record, episode: hydrateCommand(record.episode) };
            })
          : [],
      };
    }
    if (commandGroup && typeof commandGroup === "object" && !Array.isArray(commandGroup)) {
      const group = commandGroup as Record<string, unknown>;
      result.commandGroup = {
        ...group,
        actions: Array.isArray(group.actions)
          ? group.actions.map((action) => {
              if (!action || typeof action !== "object" || Array.isArray(action)) return action;
              const actionRecord = action as Record<string, unknown>;
              return { ...actionRecord, command: hydrateCommand(actionRecord.command) };
            })
          : [],
      };
    }
    return result;
  };

  return {
    ...payload,
    assets: { ...assets, backgrounds: backgroundEntries },
    commands: Array.isArray(payload.commands) ? payload.commands.map(hydrateCommand) : [],
  };
};

/** Resolve transcript audio without requiring the WebGL runtime or stage registry. */
export const hydrateStoryTextPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const assets = (payload.assets || {}) as Record<string, unknown>;
  const sounds = resourceIndex(assets.sounds, "sound");

  const hydrateCommand = (input: unknown): unknown => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const command = input as Record<string, unknown>;
    const result: Record<string, unknown> = { ...command };
    const needsHydratedVoices = result.voices == null || (Array.isArray(result.voices) && result.voices.length === 0);
    if (needsHydratedVoices && Array.isArray(command.voiceRefs)) {
      result.voices = presentRecords(command.voiceRefs.map((key) => resolvedIndexedEntry(sounds, key, "voice", {})));
    }
    if (command.timeline && typeof command.timeline === "object" && !Array.isArray(command.timeline)) {
      const timeline = command.timeline as Record<string, unknown>;
      result.timeline = {
        ...timeline,
        signals: Array.isArray(timeline.signals)
          ? timeline.signals.map((signal) => {
              if (!signal || typeof signal !== "object" || Array.isArray(signal)) return signal;
              const record = signal as Record<string, unknown>;
              return { ...record, episode: hydrateCommand(record.episode) };
            })
          : [],
      };
    }
    if (command.commandGroup && typeof command.commandGroup === "object" && !Array.isArray(command.commandGroup)) {
      const group = command.commandGroup as Record<string, unknown>;
      result.commandGroup = {
        ...group,
        actions: Array.isArray(group.actions)
          ? group.actions.map((action) => {
              if (!action || typeof action !== "object" || Array.isArray(action)) return action;
              const actionRecord = action as Record<string, unknown>;
              return { ...actionRecord, command: hydrateCommand(actionRecord.command) };
            })
          : [],
      };
    }
    return result;
  };

  return {
    ...payload,
    commands: Array.isArray(payload.commands) ? payload.commands.map(hydrateCommand) : [],
  };
};
