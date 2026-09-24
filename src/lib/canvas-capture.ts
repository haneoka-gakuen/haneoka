export async function saveCanvasFrame(canvas: HTMLCanvasElement, filename: string, render: () => boolean | void) {
  if (!canvas.width || !canvas.height || render() === false) throw new Error("Canvas is not ready");
  const snapshot = document.createElement("canvas");
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  const context = snapshot.getContext("2d");
  if (!context) throw new Error("Image capture is unavailable");
  // Copy the rendered pixels before the WebGL drawing buffer is discarded.
  context.drawImage(canvas, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    snapshot.toBlob((value) => (value ? resolve(value) : reject(new Error("Image encoding failed"))), "image/png"),
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
