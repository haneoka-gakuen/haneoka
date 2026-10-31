// L3 — GEB
// Input: 用户选择的录屏文件与取消信号。
// Output: 按固定间隔抽取的 JPEG 帧（异步迭代）。
// Pos: [Map](L2-2.md)；录屏导入的抽帧，供截图识别逐帧使用。
// Effects/Dependencies: 在页面内用 <video> 解码并绘制到 canvas；视频不上传。

/** Seconds between frames; a Box row stays on screen longer than this while scrolling. */
const STEP_SECONDS = 0.25;
const MAX_FRAMES = 600;
const MAX_SIDE = 4096;

function once(target: EventTarget, type: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const fail = () => reject(new RangeError("image-video"));
    target.addEventListener(type, () => {
      signal.removeEventListener("abort", abort);
      target.removeEventListener("error", fail);
      resolve();
    }, { once: true });
    target.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** The frame count a recording of [duration] seconds yields. */
export const videoFrameCount = (duration: number) =>
  Math.min(MAX_FRAMES, Math.max(1, Math.floor(duration / STEP_SECONDS) + 1));

export async function* videoFrames(file: Blob, signal: AbortSignal): AsyncGenerator<{ frame: Blob; index: number; total: number }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    const loaded = once(video, "loadeddata", signal);
    video.src = url;
    await loaded;
    if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) throw new RangeError("image-video");
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new RangeError("image-video");
    const total = videoFrameCount(video.duration);
    for (let index = 0; index < total; index++) {
      signal.throwIfAborted();
      const seeked = once(video, "seeked", signal);
      video.currentTime = Math.min(video.duration, index * STEP_SECONDS);
      await seeked;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new RangeError("image-video"))), "image/jpeg", 0.92),
      );
      yield { frame, index, total };
    }
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
