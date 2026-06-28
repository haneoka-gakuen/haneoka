export interface AudioBufferLike {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface WaveformBins {
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly rms: Float32Array;
}

export interface WaveformOptions {
  /** Mix averages all channels per frame. A number analyzes only that channel. */
  channel?: "mix" | number;
}

export const createWaveformBins = (
  audio: AudioBufferLike,
  binCount: number,
  options: WaveformOptions = {},
): WaveformBins => {
  if (!Number.isSafeInteger(binCount) || binCount <= 0) throw new RangeError("Bin count must be positive");
  if (!Number.isSafeInteger(audio.length) || audio.length < 0) throw new RangeError("Invalid audio length");
  if (!Number.isSafeInteger(audio.numberOfChannels) || audio.numberOfChannels <= 0) {
    throw new RangeError("Audio must contain at least one channel");
  }
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) throw new RangeError("Invalid sample rate");

  const requestedChannel = options.channel ?? "mix";
  if (
    requestedChannel !== "mix" &&
    (!Number.isSafeInteger(requestedChannel) || requestedChannel < 0 || requestedChannel >= audio.numberOfChannels)
  ) {
    throw new RangeError("Audio channel is out of range");
  }
  const channels =
    requestedChannel === "mix"
      ? Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index))
      : [audio.getChannelData(requestedChannel)];
  for (const channel of channels) {
    if (channel.length < audio.length) throw new RangeError("Audio channel is shorter than the declared length");
  }

  const min = new Float32Array(binCount);
  const max = new Float32Array(binCount);
  const rms = new Float32Array(binCount);
  for (let bin = 0; bin < binCount; bin++) {
    const start = Math.min(audio.length, Math.floor((bin * audio.length) / binCount));
    const end = Math.min(audio.length, Math.max(start + 1, Math.floor(((bin + 1) * audio.length) / binCount)));
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    let squareSum = 0;
    let frames = 0;
    for (let frame = start; frame < end; frame++) {
      let sample = 0;
      for (const channel of channels) sample += channel[frame] ?? 0;
      sample /= channels.length;
      low = Math.min(low, sample);
      high = Math.max(high, sample);
      squareSum += sample * sample;
      frames += 1;
    }
    min[bin] = frames ? low : 0;
    max[bin] = frames ? high : 0;
    rms[bin] = frames ? Math.sqrt(squareSum / frames) : 0;
  }

  return {
    length: binCount,
    sampleRate: audio.sampleRate,
    duration: audio.length / audio.sampleRate,
    min,
    max,
    rms,
  };
};
