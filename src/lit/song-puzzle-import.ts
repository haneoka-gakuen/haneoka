// L3 — GEB
// Input: 所选封面、阶数、目标空格、语言与本地截图。
// Output: 经预览校正的布局事件；取消保持原棋盘。
// Pos: [Map](L2-2.md)；按需加载的截图导入弹层。
// Effects/Dependencies: 有界 Canvas 解码、读取封面、识别 Worker 与临时对象 URL；断开时释放。
import { LitElement, html, nothing } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/textfield/outlined-text-field.js";
import { clientText } from "../i18n/client";
import { modal } from "./ui/modal";
import { goalBoard, solvable } from "../lib/song-puzzle/model";
import type { PuzzleCrop, PuzzlePixels, PuzzleRecognition } from "../lib/song-puzzle/recognition";

export interface ImportedPuzzle {
  size: number;
  tiles: number[];
  goalBlank: number;
}

async function readPixels(url: string, maxSide: number, signal: AbortSignal): Promise<PuzzlePixels> {
  const image = new Image();
  image.src = url;
  await image.decode();
  signal.throwIfAborted();
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight)),
    canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  if (Math.min(canvas.width, canvas.height) < 64) throw new Error("image");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("canvas");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  canvas.width = canvas.height = 0;
  return { width: pixels.width, height: pixels.height, data: pixels.data };
}

export class SongPuzzleImport extends LitElement {
  static properties = {
    locale: { type: String },
    cover: { type: String },
    songName: { type: String },
    songLanguage: { type: String },
    size: { type: Number },
    goalBlank: { type: Number },
  };
  declare locale: string;
  declare cover: string;
  declare songName: string;
  declare songLanguage: string;
  declare size: number;
  declare goalBlank: number;
  private image?: PuzzlePixels;
  private reference?: PuzzlePixels;
  private imageUrl = "";
  private crop?: PuzzleCrop;
  private result?: PuzzleRecognition;
  private selected = -1;
  private busy = false;
  private error = "";
  private worker?: Worker;
  private token = 0;
  private timeout?: ReturnType<typeof setTimeout>;
  private readonly controller = new AbortController();
  private gesture?: { pointer: number; x: number; y: number; crop: PuzzleCrop; mode: "move" | "draw" };

  constructor() {
    super();
    this.locale = "en";
    this.cover = "";
    this.songName = "";
    this.songLanguage = "ja";
    this.size = 3;
    this.goalBlank = 8;
  }
  createRenderRoot() {
    return this;
  }
  disconnectedCallback() {
    this.controller.abort();
    this.stop();
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    super.disconnectedCallback();
  }
  private text(key: string, values: Record<string, number> = {}) {
    let text = clientText(this.locale, `tools.songPuzzle.${key}`, key);
    for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  }
  private stop() {
    ++this.token;
    clearTimeout(this.timeout);
    this.worker?.terminate();
    this.worker = undefined;
    this.busy = false;
  }
  private close() {
    this.dispatchEvent(new CustomEvent("puzzle-import-close", { bubbles: true, composed: true }));
  }
  private async chooseFile(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    input.value = "";
    if (!file) return;
    this.stop();
    this.result = undefined;
    this.image = undefined;
    this.crop = undefined;
    this.error = "";
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = "";
    if (file.size > 20 * 1024 * 1024) {
      this.error = "imageTooLarge";
      this.requestUpdate();
      return;
    }
    const token = this.token,
      url = URL.createObjectURL(file);
    this.imageUrl = url;
    this.busy = true;
    this.requestUpdate();
    try {
      const image = await readPixels(url, 2048, this.controller.signal);
      if (!this.isConnected || token !== this.token) return;
      this.image = image;
      const side = Math.min(image.width, image.height);
      this.crop = { x: (image.width - side) / 2, y: (image.height - side) / 2, side };
      await this.analyze(true);
    } catch {
      if (this.isConnected && token === this.token) {
        this.busy = false;
        this.error = "imageError";
        this.requestUpdate();
      }
    }
  }
  private async analyze(automatic = false) {
    if (!this.image) return;
    this.stop();
    const token = this.token;
    this.busy = true;
    this.error = "";
    this.result = undefined;
    this.selected = -1;
    this.requestUpdate();
    try {
      if (!this.reference) {
        const response = await fetch(this.cover, { signal: this.controller.signal });
        if (!response.ok) throw new Error("cover");
        const url = URL.createObjectURL(await response.blob());
        try {
          this.reference = await readPixels(url, 1024, this.controller.signal);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (!this.isConnected || token !== this.token) return;
      const worker = new Worker(new URL("../workers/song-puzzle-import.worker.ts", import.meta.url), {
        type: "module",
      });
      this.worker = worker;
      const current = () => this.isConnected && this.worker === worker && this.token === token;
      const failed = () => {
        if (!current()) return;
        this.stop();
        this.error = "imageNoMatch";
        this.requestUpdate();
      };
      worker.onmessage = ({ data }: MessageEvent<{ token: number; result?: PuzzleRecognition; error?: boolean }>) => {
        if (!current() || data.token !== token) return;
        if (!data.result) {
          failed();
          return;
        }
        this.stop();
        this.result = data.result;
        this.crop = data.result.crop;
        this.requestUpdate();
      };
      worker.onerror = failed;
      this.timeout = setTimeout(failed, 30000);
      worker.postMessage({
        token,
        image: this.image,
        cover: this.reference,
        size: this.size,
        crop: automatic ? undefined : this.crop,
        goalBlank: this.goalBlank < 0 ? undefined : this.goalBlank,
      });
    } catch {
      if (this.isConnected && token === this.token) {
        this.stop();
        this.error = "imageError";
        this.requestUpdate();
      }
    }
  }
  private setCrop(value: PuzzleCrop) {
    if (!this.image) return;
    this.stop();
    this.result = undefined;
    this.selected = -1;
    this.error = "";
    const side = Math.max(this.size * 8, Math.min(this.image.width, this.image.height, value.side));
    this.crop = {
      x: Math.max(0, Math.min(this.image.width - side, value.x)),
      y: Math.max(0, Math.min(this.image.height - side, value.y)),
      side,
    };
    this.requestUpdate();
  }
  private point(event: PointerEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * this.image!.width) / rect.width,
      y: ((event.clientY - rect.top) * this.image!.height) / rect.height,
    };
  }
  private pointerDown(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || !this.crop) return;
    const point = this.point(event),
      crop = this.crop,
      inside = point.x >= crop.x && point.y >= crop.y && point.x <= crop.x + crop.side && point.y <= crop.y + crop.side;
    this.gesture = { pointer: event.pointerId, ...point, crop: { ...crop }, mode: inside ? "move" : "draw" };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  private pointerMove(event: PointerEvent) {
    const start = this.gesture;
    if (!start || start.pointer !== event.pointerId) return;
    const point = this.point(event),
      dx = point.x - start.x,
      dy = point.y - start.y;
    if (start.mode === "move") this.setCrop({ ...start.crop, x: start.crop.x + dx, y: start.crop.y + dy });
    else {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      this.setCrop({ x: dx < 0 ? start.x - side : start.x, y: dy < 0 ? start.y - side : start.y, side });
    }
  }
  private swap(index: number) {
    if (!this.result) return;
    if (this.selected < 0) this.selected = index;
    else {
      const first = this.selected,
        tiles = [...this.result.tiles];
      [tiles[first], tiles[index]] = [tiles[index], tiles[first]];
      this.result = {
        ...this.result,
        tiles,
        repair: undefined,
        uncertain: this.result.uncertain.filter((cell) => cell !== first && cell !== index),
      };
      this.selected = -1;
    }
    this.requestUpdate();
  }
  private valid() {
    return (
      this.result &&
      solvable({ size: this.size, tiles: this.result.tiles, goal: goalBoard(this.size, this.result.goalBlank) })
    );
  }
  private apply() {
    if (!this.result || !this.valid()) return;
    this.dispatchEvent(
      new CustomEvent<ImportedPuzzle>("puzzle-import", {
        bubbles: true,
        composed: true,
        detail: { size: this.size, tiles: [...this.result.tiles], goalBlank: this.result.goalBlank },
      }),
    );
  }
  render() {
    const image = this.image,
      crop = this.crop,
      result = this.result,
      goal = result ? goalBoard(this.size, result.goalBlank) : [],
      state = this.busy
        ? "imageRecognizing"
        : this.error ||
          (result
            ? !this.valid()
              ? "unsolvable"
              : result.uncertain.length
                ? "imageReview"
                : "imageMatched"
            : image
              ? "imageCrop"
              : "imageEmpty");
    return html`
      <dialog class="dialog puzzle-import" aria-labelledby="puzzle-import-title" ${modal(() => this.close())}>
        <div class="dialog__surface">
          <header class="dialog__header"><h2 id="puzzle-import-title">${this.text("imageImport")}</h2></header>
          <div class="dialog__body stack">
            <div class="cluster">
              <label class="button button--tonal puzzle-import__choose">
                ${this.text("imageChoose")}
                <input
                  class="puzzle-import__file"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  @change=${(event: Event) => void this.chooseFile(event)}
                />
              </label>
              <md-outlined-select
                label=${this.text("size")}
                .value=${String(this.size)}
                @change=${(event: Event) => {
                  this.size = Number((event.target as HTMLSelectElement).value);
                  if (this.goalBlank >= 0) this.goalBlank = this.size * this.size - 1;
                  this.stop();
                  this.result = undefined;
                  this.requestUpdate();
                  if (this.image) void this.analyze(true);
                }}
              >
                ${[3, 4, 5, 6, 7, 8].map(
                  (size) => html`
                    <md-select-option value=${String(size)}>
                      <span slot="headline">${size} × ${size}</span>
                    </md-select-option>
                  `,
                )}
              </md-outlined-select>
              <md-outlined-select
                label=${this.text("goalBlank")}
                .value=${String(this.goalBlank)}
                @change=${(event: Event) => {
                  this.goalBlank = Number((event.target as HTMLSelectElement).value);
                  if (this.image) void this.analyze();
                }}
              >
                <md-select-option value="-1"><span slot="headline">${this.text("imageAuto")}</span></md-select-option>
                ${Array.from(
                  { length: this.size * this.size },
                  (_, index) => html`
                    <md-select-option value=${String(index)}>
                      <span slot="headline">
                        ${this.text("position", { row: Math.floor(index / this.size) + 1, column: (index % this.size) + 1 })}
                      </span>
                    </md-select-option>
                  `,
                )}
              </md-outlined-select>
            </div>
            <div class="puzzle-import__status" role="status" aria-live="polite">
              ${this.text(state, { count: result?.uncertain.length ?? 0 })}
            </div>
            ${
              result?.repair
                ? html`
                    <button
                      type="button"
                      class="button button--tonal"
                      @click=${() => {
                        this.result = { ...result, tiles: result.repair!, repair: undefined };
                        this.selected = -1;
                        this.requestUpdate();
                      }}
                    >
                      ${this.text("imageResolveSimilar")}
                    </button>
                  `
                : nothing
            }
            ${
              image && crop
                ? html`
                    <div
                      class="puzzle-import__image"
                      style=${styleMap({ "--puzzle-image-ratio": String(image.width / image.height) })}
                      @pointerdown=${(event: PointerEvent) => this.pointerDown(event)}
                      @pointermove=${(event: PointerEvent) => this.pointerMove(event)}
                      @pointerup=${() => {
                        this.gesture = undefined;
                      }}
                      @pointercancel=${() => {
                        this.gesture = undefined;
                      }}
                    >
                      <img src=${this.imageUrl} alt=${this.text("imageScreenshot")} draggable="false" />
                      <div
                        class="puzzle-import__crop"
                        style=${styleMap({ left: `${(crop.x / image.width) * 100}%`, top: `${(crop.y / image.height) * 100}%`, width: `${(crop.side / image.width) * 100}%`, height: `${(crop.side / image.height) * 100}%` })}
                      >
                        ${Array.from(
                          { length: this.size - 1 },
                          (_, index) => html`
                            <span
                              class="puzzle-import__line puzzle-import__line--x"
                              style=${styleMap({ left: `${((index + 1) / this.size) * 100}%` })}
                            ></span>
                            <span
                              class="puzzle-import__line puzzle-import__line--y"
                              style=${styleMap({ top: `${((index + 1) / this.size) * 100}%` })}
                            ></span>
                          `,
                        )}
                      </div>
                    </div>
                    <div class="puzzle-import__coordinates">
                      ${(["x", "y", "side"] as const).map(
                        (axis) => html`
                          <md-outlined-text-field
                            type="number"
                            label=${this.text(axis === "x" ? "imageX" : axis === "y" ? "imageY" : "imageSide")}
                            min=${axis === "side" ? this.size * 8 : 0}
                            max=${axis === "side" ? Math.min(image.width, image.height) : axis === "x" ? image.width - crop.side : image.height - crop.side}
                            .value=${String(Math.round(crop[axis]))}
                            @change=${(event: Event) => {
                              const value = Number((event.target as HTMLInputElement).value);
                              if (Number.isFinite(value)) this.setCrop({ ...crop, [axis]: value });
                            }}
                          ></md-outlined-text-field>
                        `,
                      )}
                    </div>
                    <div class="cluster">
                      <button
                        type="button"
                        class="button button--tonal"
                        ?disabled=${this.busy}
                        @click=${() => void this.analyze(true)}
                      >
                        ${this.text("imageLocate")}
                      </button>
                      <button
                        type="button"
                        class="button button--tonal"
                        ?disabled=${this.busy}
                        @click=${() => void this.analyze()}
                      >
                        ${this.text("imageRecognize")}
                      </button>
                      ${
                        this.busy
                          ? html`
                              <button
                                type="button"
                                class="button button--text"
                                @click=${() => {
                                  this.stop();
                                  this.requestUpdate();
                                }}
                              >
                                ${this.text("cancel")}
                              </button>
                            `
                          : nothing
                      }
                    </div>
                  `
                : nothing
            }
            ${
              result
                ? html`
                    <section class="stack">
                      <h3 class="detail-section-title" lang=${this.songLanguage}>${this.songName}</h3>
                      <div
                        class="puzzle-import__preview"
                        role="region"
                        aria-label=${this.text("imagePreview")}
                        tabindex="0"
                      >
                        <div
                          class="puzzle-import__board"
                          style=${styleMap({ "--puzzle-columns": String(this.size), "--puzzle-cover": `url(${JSON.stringify(this.cover)})` })}
                        >
                          ${result.tiles.map((tile, index) => {
                            const source = goal.indexOf(tile);
                            return html`
                              <button
                                type="button"
                                class="puzzle-import__tile"
                                data-empty=${String(tile === 0)}
                                data-uncertain=${String(result.uncertain.includes(index))}
                                aria-pressed=${String(this.selected === index)}
                                aria-label=${`${tile === 0 ? this.text("blank") : this.text("tile", { tile })}, ${this.text("position", { row: Math.floor(index / this.size) + 1, column: (index % this.size) + 1 })}${result.uncertain.includes(index) ? `, ${this.text("imageReview", { count: 1 })}` : ""}`}
                                style=${styleMap({ "--puzzle-fragment-x": `${((source % this.size) / (this.size - 1)) * 100}%`, "--puzzle-fragment-y": `${(Math.floor(source / this.size) / (this.size - 1)) * 100}%` })}
                                @click=${() => this.swap(index)}
                              >
                                <span>${tile || this.text("blank")}</span>
                              </button>
                            `;
                          })}
                        </div>
                      </div>
                    </section>
                  `
                : nothing
            }
          </div>
          <footer class="dialog__actions">
            <button type="button" class="button button--text" @click=${() => this.close()}>
              ${this.text("cancel")}
            </button>
            <button type="button" class="button" ?disabled=${this.busy || !this.valid()} @click=${() => this.apply()}>
              ${this.text("imageApply")}
            </button>
          </footer>
        </div>
      </dialog>
    `;
  }
}
if (!customElements.get("song-puzzle-import")) customElements.define("song-puzzle-import", SongPuzzleImport);
