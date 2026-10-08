import { analyzeAudio, type AudioAnalysis } from "../../../packages/chart-editor/src/creation/audio-analysis";

export const AUDIO_LIMITS = { bytes: 32 * 1024 * 1024, seconds: 600, sampleRate: 22050 } as const;
export interface CreationAudio {
  file: File;
  sha256: string;
  analysis: AudioAnalysis;
}
export const sha256Blob = async (file: Blob): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");

/** Decode the actual File; retain original encoded bytes, never store decoded PCM. */
export async function decodeCreationAudio(file: File, signal: AbortSignal): Promise<CreationAudio> {
  signal.throwIfAborted();
  if (!file.size || file.size > AUDIO_LIMITS.bytes) throw new Error("audio_size");
  const url = URL.createObjectURL(file),
    media = new Audio();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    media.pause();
    media.removeAttribute("src");
    media.load();
    URL.revokeObjectURL(url);
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        media.onloadedmetadata = null;
        media.onerror = null;
        if (error) reject(error);
        else resolve(media.duration);
      };
      const abort = () => finish(signal.reason);
      const timer = setTimeout(() => finish(new Error("audio_timeout")), 10000);
      media.onloadedmetadata = () => finish();
      media.onerror = () => finish(new Error("audio_decode"));
      signal.addEventListener("abort", abort, { once: true });
      media.preload = "metadata";
      media.src = url;
    });
    signal.throwIfAborted();
    if (!Number.isFinite(duration) || duration <= 0 || duration > AUDIO_LIMITS.seconds)
      throw new Error("audio_duration");
    release();
    const encoded = await file.arrayBuffer();
    signal.throwIfAborted();
    const decoder = new OfflineAudioContext(1, 1, AUDIO_LIMITS.sampleRate);
    const buffer = await decoder.decodeAudioData(encoded);
    signal.throwIfAborted();
    if (buffer.duration > AUDIO_LIMITS.seconds || buffer.numberOfChannels > 8) throw new Error("audio_duration");
    const analysis = analyzeAudio(buffer);
    const sha256 = await sha256Blob(file);
    signal.throwIfAborted();
    return { file, sha256, analysis };
  } finally {
    signal.removeEventListener("abort", release);
    release();
  }
}

/** Original synthesized click track: 8 seconds, 120 BPM, PCM WAV, no third-party assets. */
export function createExampleAudio(): File {
  const rate = 22050,
    frames = rate * 8,
    bytes = new ArrayBuffer(44 + frames * 2),
    view = new DataView(bytes);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const phase = (i / rate) % 0.5;
    view.setInt16(
      44 + i * 2,
      Math.round(phase < 0.06 ? Math.sin(2 * Math.PI * 880 * phase) * Math.exp(-phase * 90) * 24000 : 0),
      true,
    );
  }
  return new File([bytes], "Haneoka-120bpm.wav", { type: "audio/wav" });
}
