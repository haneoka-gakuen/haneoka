import { createWaveformBins, type AudioBufferLike, type WaveformBins } from "../waveform";

export interface TempoCandidate {
  bpm: number;
  correlation: number;
}
export interface AudioAnalysis {
  duration: number;
  sampleRate: number;
  channels: number;
  waveform: WaveformBins;
  candidates: TempoCandidate[];
}

/** RMS energy across channels avoids cancelling anti-phase stereo material. */
export function analyzeAudio(audio: AudioBufferLike): AudioAnalysis {
  const count = Math.max(1, Math.ceil((audio.length / audio.sampleRate) * 100));
  const waveform = createWaveformBins(audio, count, { channel: 0 });
  for (let channel = 1; channel < audio.numberOfChannels; channel++) {
    const other = createWaveformBins(audio, count, { channel });
    for (let i = 0; i < count; i++) {
      waveform.min[i] = Math.min(waveform.min[i]!, other.min[i]!);
      waveform.max[i] = Math.max(waveform.max[i]!, other.max[i]!);
      waveform.rms[i] = Math.hypot(waveform.rms[i]!, other.rms[i]!);
    }
  }
  for (let i = 0; i < count; i++) waveform.rms[i] = waveform.rms[i]! / Math.sqrt(audio.numberOfChannels);
  // A bounded onset-energy autocorrelation. Candidates intentionally retain half/double-time ambiguity.
  const length = Math.min(count, 9000),
    rate = count / waveform.duration;
  const onset = new Float32Array(length);
  let energy = 0;
  for (let i = 1; i < length; i++) {
    onset[i] = Math.max(0, waveform.rms[i]! - waveform.rms[i - 1]!);
    energy += onset[i]! * onset[i]!;
  }
  const scores: { lag: number; score: number }[] = [];
  const minimum = Math.max(1, Math.floor((rate * 60) / 240)),
    maximum = Math.ceil((rate * 60) / 50);
  for (let lag = minimum; lag <= maximum && lag < length / 3; lag++) {
    let cross = 0,
      a = 0,
      b = 0;
    for (let i = lag; i < length; i++) {
      cross += onset[i]! * onset[i - lag]!;
      a += onset[i]! ** 2;
      b += onset[i - lag]! ** 2;
    }
    scores.push({ lag, score: cross / (Math.sqrt(a * b) || 1) });
  }
  const candidates =
    energy > 1e-6 && waveform.duration >= 4
      ? scores
          .filter(
            (item, i) =>
              item.score >= 0.15 &&
              item.score >= (scores[i - 1]?.score ?? 0) &&
              item.score >= (scores[i + 1]?.score ?? 0),
          )
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((item) => ({ bpm: Math.round(((rate * 60) / item.lag) * 10) / 10, correlation: item.score }))
      : [];
  return {
    duration: waveform.duration,
    sampleRate: audio.sampleRate,
    channels: audio.numberOfChannels,
    waveform,
    candidates,
  };
}
