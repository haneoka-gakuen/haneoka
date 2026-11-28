// L3 — GEB
// Input: 图库中按原顺序排列的幻灯片、打开位置与触发控件。
// Output: 共用的放大查看器，含翻图、缩放、焦点管理与保存操作。
// Pos: [Map](L2-2.md)；资料图库与社区帖子共用。
// Effects/Dependencies: 读取原件字节，通过浏览器或 App 下载通道保存。
import { render } from "lit";
import type PhotoSwipe from "photoswipe";
import { downloadBlob } from "../../lib/canvas-capture";
import { trapFocus } from "../../lib/overlay";
import { snackbar } from "../../lib/snackbar";
import { uiText } from "../shared/catalog";
import { icon } from "./icon";
import "../../styles/image-viewer.css";
import "photoswipe/style.css";

type ImageDownload = { source: string; name?: string };
type ViewerSlide = { src: string; width: number; height: number; alt: string; original?: ImageDownload };
export type ImageViewer = Pick<PhotoSwipe, "init" | "destroy">;

interface ViewerOptions {
  slides: readonly (ViewerSlide | null | Promise<ViewerSlide | null>)[];
  index: number;
  locale: string;
  title?: string;
  trigger: HTMLElement;
  onChange: (index: number) => void;
  onDestroy: () => void;
}

async function saveImage({ source, name }: ImageDownload, button: HTMLElement, locale: string, container?: HTMLElement) {
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("aria-busy", "true");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const url = new URL(source, document.baseURI);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Image download failed");
    const blob = await response.blob();
    const format = /^image\/(?:x-)?([a-z0-9]+)(?:\+xml)?(?:;|$)/u.exec(blob.type)?.[1];
    if (!format || !blob.size) throw new Error("Invalid image response");
    const basename = ["http:", "https:"].includes(url.protocol) ? url.pathname.split("/").pop() : "";
    const filename = name || (basename ? decodeURIComponent(basename) : "image");
    const extension = format === "jpeg" ? "jpg" : format;
    const lowerName = filename.toLowerCase();
    const hasExtension = lowerName.endsWith(`.${format}`) || lowerName.endsWith(`.${extension}`);
    await downloadBlob(blob, hasExtension ? filename : `${filename}.${extension}`);
  } catch {
    snackbar(uiText(locale, "media.images.actions.saveFailed"), {
      error: true,
      container: container?.isConnected ? container : undefined,
    });
  } finally {
    clearTimeout(timeout);
    button.removeAttribute("aria-busy");
    button.removeAttribute("aria-disabled");
  }
}

export async function createImageViewer(options: ViewerOptions): Promise<ImageViewer> {
  const { locale, title, trigger, onChange, onDestroy } = options;
  const [{ default: Viewer }, slides] = await Promise.all([import("photoswipe"), Promise.all(options.slides)]);
  const unavailable = uiText(locale, "common.states.unavailable");
  if (!slides[options.index]) throw new Error(unavailable);
  const indices = slides.flatMap((slide, index) => (slide ? [index] : []));
  const images = slides.filter((slide): slide is ViewerSlide => slide !== null);
  const viewer = new Viewer({
    dataSource: images,
    index: indices.indexOf(options.index),
    mainClass: "image-viewer",
    appendToEl: trigger.closest<HTMLElement>("dialog[open]") ?? undefined,
    bgOpacity: 1,
    showHideAnimationType: "fade",
    trapFocus: false,
    returnFocus: false,
    wheelToZoom: true,
    imageClickAction: "zoom",
    padding: { top: 64, bottom: 24, left: 12, right: 12 },
    closeTitle: uiText(locale, "common.actions.close"),
    zoomTitle: uiText(locale, "media.models.labels.zoom"),
    arrowPrevTitle: uiText(locale, "media.images.actions.previousImage"),
    arrowNextTitle: uiText(locale, "media.images.actions.nextImage"),
    errorMsg: unavailable,
  });
  viewer.on("uiRegister", () => {
    viewer.ui?.registerElement({
      name: "save-image",
      order: 15,
      isButton: true,
      title: uiText(locale, "media.images.actions.saveImage"),
      onInit: (button) => render(icon("download"), button),
      onClick: (_event, button) => {
        if (button.hasAttribute("aria-disabled")) return;
        const slide = images[viewer.currIndex];
        if (slide) void saveImage(slide.original ?? { source: slide.src }, button, locale, viewer.element);
      },
    });
  });
  let releaseFocus: (() => void) | undefined;
  viewer.on("afterInit", () => {
    if (!viewer.element) return;
    viewer.element.setAttribute("aria-label", title || uiText(locale, "media.images.viewerTitle"));
    releaseFocus = trapFocus(viewer.element, { onDismiss: () => viewer.close(), returnFocus: trigger });
  });
  viewer.on("change", () => onChange(indices[viewer.currIndex]));
  viewer.on("destroy", () => {
    releaseFocus?.();
    onDestroy();
  });
  return viewer;
}
