// L3 — GEB
// Input: The loaded Home Spot stage canvas, entrance duration and cancellation signal.
// Output: One silent recording of the native entrance in a supported video format.
// Pos: [Map](L2-2.md); lazy browser export for Home Spot scenes.
// Effects/Dependencies: Uses canvas capture and MediaRecorder; releases the stream on every exit.
const FORMATS = [
  { mime: "video/webm;codecs=vp9", extension: "webm" },
  { mime: "video/webm;codecs=vp8", extension: "webm" },
  { mime: "video/mp4", extension: "mp4" },
];

export function homeSpotVideoFormat() {
  if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement.prototype.captureStream !== "function")
    return undefined;
  return FORMATS.find(({ mime }) => MediaRecorder.isTypeSupported(mime));
}

export async function recordHomeSpot(
  canvas: HTMLCanvasElement,
  seconds: number,
  replay: () => void,
  signal: AbortSignal,
): Promise<{ blob: Blob; extension: string }> {
  signal.throwIfAborted();
  const format = homeSpotVideoFormat();
  if (!format) throw new Error("Video recording unavailable");
  const width = canvas.width;
  const height = canvas.height;
  replay();
  const stream = canvas.captureStream(30);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recorder: MediaRecorder | undefined;
  let signalCleanup: (() => void) | undefined;
  try {
    const video = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 5_000_000 });
    recorder = video;
    const blob = await new Promise<Blob>((resolve, reject) => {
      const chunks: Blob[] = [];
      const abort = () => reject(signal.reason);
      const visibility = () => {
        if (document.hidden) reject(new Error("Recording interrupted"));
      };
      const resize = new ResizeObserver(() => {
        if (canvas.width !== width || canvas.height !== height || !canvas.isConnected)
          reject(new Error("Scene size changed during recording"));
      });
      const cleanup = () => {
        resize.disconnect();
        signal.removeEventListener("abort", abort);
        document.removeEventListener("visibilitychange", visibility);
      };
      video.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      video.addEventListener("error", () => reject(new Error("Recording failed")), { once: true });
      video.addEventListener(
        "stop",
        () => {
          if (signal.aborted) reject(signal.reason);
          else if (chunks.length) resolve(new Blob(chunks, { type: video.mimeType }));
          else reject(new Error("Recording is empty"));
        },
        { once: true },
      );
      signal.addEventListener("abort", abort, { once: true });
      document.addEventListener("visibilitychange", visibility);
      signalCleanup = cleanup;
      resize.observe(canvas);
      video.addEventListener(
        "start",
        () => {
          if (signal.aborted) return;
          replay();
          timer = setTimeout(() => {
            if (video.state === "recording") video.stop();
          }, seconds * 1000);
        },
        { once: true },
      );
      try {
        video.start(1000);
      } catch (error) {
        reject(error);
      }
    });
    return { blob, extension: format.extension };
  } finally {
    signalCleanup?.();
    clearTimeout(timer);
    if (recorder?.state === "recording") recorder.stop();
    for (const track of stream.getTracks()) track.stop();
  }
}
