export function videoAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function waitForVideo(video: HTMLVideoElement, event: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(videoAbortError("Video load was cancelled"));
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = (): void => finish();
    const onError = (): void => finish(new Error(video.error?.message || "Video failed to load"));
    const onAbort = (): void => finish(videoAbortError("Video load was cancelled"));
    const finish = (error?: Error): void => {
      video.removeEventListener(event, onReady);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    video.addEventListener(event, onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
