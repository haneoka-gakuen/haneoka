import type { AdvVoiceMotionSyncPcmSnapshot } from "../../sound/AdvSoundManager";
import type { VoiceAnalysisSource } from "./StorySceneTypes";

export interface VoiceMotionSyncInput {
  pcm: AdvVoiceMotionSyncPcmSnapshot | null;
  rms: number;
  playing: boolean;
  pending: boolean;
  analyzable: boolean;
}

function finite(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, finite(value)));
}

/** Reads the decoded voice immediately behind the Howl playhead. */
function pcmWindowRms(source: AdvVoiceMotionSyncPcmSnapshot | null, windowSeconds = 0.025): number {
  if (!source?.channelData?.length) return 0;
  const end = Math.max(0, Math.min(source.channelData.length, Math.trunc(finite(source.samplePosition))));
  const sampleCount = Math.max(1, Math.trunc(Math.max(1, finite(source.sampleRate)) * windowSeconds));
  const start = Math.max(0, end - sampleCount);
  if (end <= start) return 0;
  let sum = 0;
  for (let index = start; index < end; index += 1) {
    const value = finite(source.channelData[index]);
    sum += value * value;
  }
  return Math.sqrt(sum / (end - start));
}

/** Soft-knee speech envelope: closed below codec noise, fully open on strong vowels. */
export function voiceRmsMouthOpening(rms: number, multiplier = 1): number {
  const decibels = 20 * Math.log10(Math.max(0.000001, finite(rms)));
  const level = clamp((decibels + 52) / 34);
  const smoothStep = level * level * (3 - 2 * level);
  return clamp(smoothStep * Math.max(0, finite(multiplier)));
}

/**
 * Unity attaches one CRI player to one MotionSync input. Voice commands can
 * still carry several browser entries, so keep their source order and select
 * the first currently-playing PCM stream; RMS remains the explicit fallback.
 */
export function sampleVoiceMotionSyncInput(
  sources: readonly VoiceAnalysisSource[],
  skipRmsWhenPcm = false,
  result: VoiceMotionSyncInput = {
    pcm: null,
    rms: 0,
    playing: false,
    pending: false,
    analyzable: false,
  },
): VoiceMotionSyncInput {
  let pcm: AdvVoiceMotionSyncPcmSnapshot | null = null;
  let rms = 0;
  let playing = false;
  let pending = false;
  let analyzable = false;
  for (const source of sources) {
    try {
      const sourcePlaying = Boolean(source.howl?.playing?.(source.howlId));
      playing ||= sourcePlaying;
      pending ||= source.playbackStarted === false && source.playbackSettled !== true && source.stopping !== true;
      if (sourcePlaying) {
        analyzable ||= Boolean(source.analyzer);
      }
      if (!pcm && sourcePlaying) pcm = source.analyzer?.sampleMotionSyncPcm?.() ?? null;
    } catch {
      // A released Howl/analyser contributes neither PCM nor level.
    }
  }
  if (!pcm || !skipRmsWhenPcm) {
    for (const source of sources) {
      try {
        if (source.howl?.playing?.(source.howlId)) {
          rms = Math.max(rms, finite(source.analyzer?.sampleRms?.()));
        }
      } catch {
        // A released analyser contributes no fallback level.
      }
    }
    // Reading decoded PCM at the actual playhead avoids browser analyser graph
    // quirks and keeps legacy Cubism 2 mouths aligned with the voice waveform.
    rms = Math.max(rms, pcmWindowRms(pcm));
  }
  result.pcm = pcm;
  result.rms = rms;
  result.playing = playing;
  result.pending = pending;
  result.analyzable = analyzable || Boolean(pcm);
  return result;
}

export function isAnyVoicePlaying(sources: readonly VoiceAnalysisSource[]): boolean {
  for (const source of sources) {
    try {
      if (source.howl?.playing?.(source.howlId)) return true;
    } catch {
      // Released voices are no longer playing.
    }
  }
  return false;
}
