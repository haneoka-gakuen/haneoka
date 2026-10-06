import { LitElement, html, nothing } from "lit";
import type { MessageParams } from "@haneoka/i18n";
import { Editor, Node, mergeAttributes, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import { clientText } from "../i18n/client";
import { communityMarkup, communityDocument, safeCommunityLink } from "../lib/community-markup";
import { communityStamps, stampServers } from "./community-sticker";
import { currentReleaseServer, localizedText, type JsonRecord } from "./shared/catalog";
import { icon } from "./ui/icon";
import { loadingIndicator } from "./ui/loading-indicator";

export class CommunityEditor extends LitElement {
  static properties = {
    value: {},
    locale: {},
    raw: { state: true },
    picker: { state: true },
    stamps: { state: true },
    error: { state: true },
    loading: { state: true },
    menu: { state: true },
    compact: { type: Boolean, reflect: true },
    maxLength: { type: Number },
    labels: { attribute: false },
    allowStickers: { type: Boolean, attribute: "allow-stickers" },
  };
  declare value: string;
  declare locale: string;
  declare raw: boolean;
  declare picker: boolean;
  declare stamps: JsonRecord[];
  declare error: string;
  declare loading: boolean;
  declare compact: boolean;
  declare maxLength: number;
  declare labels?: (key: string, fallback?: string, params?: MessageParams) => string;
  declare allowStickers: boolean;
  declare menu: "format" | "insert" | null;
  private editor?: Editor;
  private current = "";
  private mounted = false;
  private stampSequence = 0;
  private visualSelection = { from: 1, to: 1 };
  private dismiss = (event: Event) => {
    if (!event.composedPath().includes(this)) {
      this.menu = null;
      this.picker = false;
    }
  };
  constructor() {
    super();
    this.value = "";
    this.locale = "en";
    this.raw = false;
    this.picker = false;
    this.stamps = [];
    this.error = "";
    this.loading = false;
    this.menu = null;
    this.compact = false;
    this.maxLength = 20000;
    this.allowStickers = true;
  }
  createRenderRoot() {
    return this;
  }
  override focus() {
    if (this.raw) this.querySelector<HTMLTextAreaElement>(".community-source-editor")?.focus();
    else this.editor?.commands.focus();
  }
  private text(key: string, params?: MessageParams) {
    return this.labels ? this.labels(key, key, params) : clientText(this.locale, `communityPage.${key}`, key, params);
  }
  protected firstUpdated() {
    this.mount();
  }
  protected updated(changed: Map<string, unknown>) {
    if (changed.has("allowStickers") && this.editor) {
      ++this.stampSequence;
      this.picker = false;
      this.loading = false;
      this.editor.destroy();
      this.editor = undefined;
      this.mount();
    }
    if (changed.has("locale") || changed.has("labels")) this.editor?.view.dom.setAttribute("aria-label", this.text("postBody"));
    if (changed.has("value") && this.value !== this.current) {
      this.current = this.value;
      this.editor?.commands.setContent(communityMarkup(this.value, this.text("spoiler"), this.locale, { allowStickers: this.allowStickers }), {
        emitUpdate: false,
      });
    }
  }
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.dismiss);
    if (this.mounted) void this.updateComplete.then(() => this.mount());
  }
  disconnectedCallback() {
    document.removeEventListener("pointerdown", this.dismiss);
    this.stampSequence++;
    this.loading = false;
    this.editor?.destroy();
    this.editor = undefined;
    super.disconnectedCallback();
  }
  private mount() {
    const element = this.querySelector<HTMLElement>(".community-rich-editor__document");
    if (!element || this.editor) return;
    this.mounted = true;
    const Sticker = Node.create({
      name: "communitySticker",
      group: "inline",
      inline: true,
      atom: true,
      addAttributes: () => ({ token: { default: "" }, label: { default: "" }, locale: { default: this.locale } }),
      parseHTML: () => [{ tag: "community-sticker" }],
      renderHTML: ({ HTMLAttributes }) => [
        "community-sticker",
        mergeAttributes(HTMLAttributes, { contenteditable: "false" }),
      ],
    });
    const Spoiler = Node.create({
      name: "communitySpoiler",
      group: "block",
      content: "block+",
      defining: true,
      parseHTML: () => [{ tag: "details[data-spoiler]", contentElement: "div" }],
      renderHTML: () => [
        "details",
        { "data-spoiler": "", open: "" },
        ["summary", { contenteditable: "false" }, this.text("spoiler")],
        ["div", {}, 0],
      ],
    });
    this.current = this.value;
    this.editor = new Editor({
      element,
      editable: !this.raw,
      extensions: [
        StarterKit.configure({
          heading: { levels: [2, 3, 4] },
          code: false,
          link: { openOnClick: false, autolink: false, defaultProtocol: "https", protocols: ["http", "https"] },
        }),
        ...(this.allowStickers ? [Sticker] : []),
        Spoiler,
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        Highlight,
      ],
      content: communityMarkup(this.value, this.text("spoiler"), this.locale, { allowStickers: this.allowStickers }),
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": this.text("postBody"),
          class: "community-bbcode",
        },
      },
      onUpdate: ({ editor }) => this.change(communityDocument(editor.getJSON())),
      onSelectionUpdate: () => this.requestUpdate(),
      onTransaction: () => this.requestUpdate(),
    });
  }
  private change(value: string) {
    this.current = value;
    this.value = value;
    this.dispatchEvent(new CustomEvent("body-change", { detail: value, bubbles: true, composed: true }));
  }
  private format(command: string) {
    const editor = this.editor;
    if (!editor) return;
    const chain = editor.chain().focus();
    if (command === "bold") chain.toggleBold().run();
    if (command === "italic") chain.toggleItalic().run();
    if (command === "underline") chain.toggleUnderline().run();
    if (command === "strike") chain.toggleStrike().run();
    if (command === "quote") chain.toggleBlockquote().run();
    if (command === "code") chain.toggleCodeBlock().run();
    if (command === "list") chain.toggleBulletList().run();
    if (command === "orderedList") chain.toggleOrderedList().run();
    if (command === "highlight") chain.toggleHighlight().run();
    if (command === "divider") chain.setHorizontalRule().run();
    if (command === "clearFormat") chain.unsetAllMarks().clearNodes().run();
    if (command === "unlink") chain.unsetLink().run();
    if (["left", "center", "right", "justify"].includes(command)) chain.setTextAlign(command).run();
    if (command === "paragraph") chain.setParagraph().run();
    if (["h2", "h3", "h4"].includes(command))
      chain.toggleHeading({ level: Number(command.slice(1)) as 2 | 3 | 4 }).run();
    if (command === "spoiler")
      editor.isActive("communitySpoiler")
        ? chain.lift("communitySpoiler").run()
        : chain.wrapIn("communitySpoiler").run();
    if (command === "undo") chain.undo().run();
    if (command === "redo") chain.redo().run();
    if (command === "link") this.querySelector<HTMLDialogElement>(".community-link-dialog")?.showModal();
    this.menu = null;
  }
  private preserveSelection(event: PointerEvent) {
    // Keep the editable selection and mobile keyboard while tapping formatting controls.
    if ((event.target as Element).closest("button") && event.isPrimary) event.preventDefault();
  }
  private async toggleSource() {
    if (this.raw && this.value.length > this.maxLength) {
      this.error = this.text(this.compact ? "invalidCommentBody" : "invalidBody", { limit: this.maxLength });
      return;
    }
    if (!this.raw && this.editor)
      this.visualSelection = { from: this.editor.state.selection.from, to: this.editor.state.selection.to };
    this.raw = !this.raw;
    this.menu = null;
    this.picker = false;
    this.error = "";
    this.editor?.setEditable(!this.raw, false);
    if (!this.raw && this.editor) {
      this.editor.commands.setContent(communityMarkup(this.value, this.text("spoiler"), this.locale, { allowStickers: this.allowStickers }), {
        emitUpdate: false,
      });
      const end = this.editor.state.doc.content.size;
      this.editor.commands.setTextSelection({
        from: Math.min(this.visualSelection.from, end),
        to: Math.min(this.visualSelection.to, end),
      });
    }
    await this.updateComplete;
    this.focus();
  }
  private async openStamps() {
    if (!this.allowStickers) return;
    this.picker = !this.picker;
    if (!this.picker || this.stamps.length) return;
    const sequence = ++this.stampSequence;
    const reload = Boolean(this.error);
    this.loading = true;
    this.error = "";
    const entries = new Map<string, JsonRecord>();
    for (const server of stampServers(currentReleaseServer())) {
      try {
        const catalog = await communityStamps(server, reload);
        if (!this.isConnected || sequence !== this.stampSequence) return;
        for (const [id, stamp] of Object.entries(catalog)) {
          if (!stamp || typeof stamp !== "object" || entries.has(id)) continue;
          const entry = stamp as JsonRecord;
          if (!/^\d{1,12}$/.test(String(entry.stampId || id))) continue;
          entries.set(id, { ...entry, stampId: entry.stampId || id, sourceServer: server });
        }
        this.stamps = [...entries.values()].sort((a, b) => Number(a.stampId) - Number(b.stampId));
      } catch {
        if (!this.isConnected || sequence !== this.stampSequence) return;
      }
    }
    this.loading = false;
    if (!this.stamps.length) this.error = this.text("stickersUnavailable");
  }
  private stampToken(stamp: JsonRecord) {
    return `${stamp.sourceServer || currentReleaseServer()}:${stamp.stampId}:${this.locale}`;
  }
  private insertStamp(stamp: JsonRecord) {
    if (!this.allowStickers) return;
    const label = localizedText(stamp.name, this.locale);
    const token = this.stampToken(stamp);
    this.editor
      ?.chain()
      .focus()
      .insertContent({ type: "communitySticker", attrs: { token, label, locale: this.locale } } as JSONContent)
      .run();
    this.picker = false;
  }
  private active(command: string): boolean {
    const node = (
      {
        list: "bulletList",
        orderedList: "orderedList",
        quote: "blockquote",
        code: "codeBlock",
        spoiler: "communitySpoiler",
      } as Record<string, string>
    )[command];
    if (["h2", "h3", "h4"].includes(command))
      return this.editor?.isActive("heading", { level: Number(command.slice(1)) }) || false;
    if (["left", "center", "right", "justify"].includes(command))
      return this.editor?.isActive({ textAlign: command }) || false;
    return this.editor?.isActive(node || command) || false;
  }
  render() {
    const common = [
      { command: "bold", icon: "format_bold", mark: "bold" },
      { command: "italic", icon: "format_italic", mark: "italic" },
      { command: "underline", icon: "format_underlined", mark: "underline" },
      { command: "link", icon: "link", mark: "link" },
    ];
    const format = [
      { command: "paragraph", icon: "notes", label: "paragraph" },
      { command: "h2", icon: "format_h2", label: "headingLarge" },
      { command: "h3", icon: "format_h3", label: "headingMedium" },
      { command: "h4", icon: "format_h4", label: "headingSmall" },
      { command: "strike", icon: "strikethrough_s", label: "strike" },
      { command: "highlight", icon: "format_ink_highlighter", label: "highlight" },
      { command: "left", icon: "format_align_left", label: "alignLeft" },
      { command: "center", icon: "format_align_center", label: "alignCenter" },
      { command: "right", icon: "format_align_right", label: "alignRight" },
      { command: "justify", icon: "format_align_justify", label: "alignJustify" },
      { command: "clearFormat", icon: "format_clear", label: "clearFormat" },
      { command: "unlink", icon: "link_off", label: "unlink" },
    ];
    const inserts = [
      { command: "list", icon: "format_list_bulleted", label: "list" },
      { command: "orderedList", icon: "format_list_numbered", label: "orderedList" },
      { command: "quote", icon: "format_quote", label: "quote" },
      { command: "code", icon: "code", label: "code" },
      { command: "spoiler", icon: "visibility_off", label: "spoiler" },
      { command: "divider", icon: "horizontal_rule", label: "divider" },
    ];
    return html`
      <div
        class="community-rich-editor"
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape" && (this.menu || this.picker)) {
            event.preventDefault();
            event.stopPropagation();
            this.menu = null;
            this.picker = false;
            this.focus();
          }
        }}
      >
        <div class="community-editor-toolbar-row" @pointerdown=${this.preserveSelection}>
          <div class="community-format-toolbar" role="toolbar" aria-label=${this.text("formatting")}>
            ${(this.compact ? common.filter(({ command }) => command !== "underline") : common).map(
              ({ command, icon: glyph, mark }) => html`
                <button
                  class="icon-button"
                  type="button"
                  title=${this.text(command)}
                  aria-label=${this.text(command)}
                  aria-pressed=${this.editor?.isActive(mark) || false}
                  ?disabled=${this.raw}
                  @click=${() => this.format(command)}
                >
                  ${icon(glyph, 20)}
                </button>
              `,
            )}
            ${this.allowStickers !== false ? html`
            <button
              class="icon-button"
              type="button"
              aria-label=${this.text("stickers")}
              title=${this.text("stickers")}
              aria-expanded=${this.picker}
              ?disabled=${this.raw}
              @click=${() => {
                this.menu = null;
                void this.openStamps();
              }}
            >
              ${icon("emoji_emotions", 20)}
            </button>
` : nothing}
            <button
              class="icon-button"
              type="button"
              aria-label=${this.text("insert")}
              title=${this.text("insert")}
              aria-expanded=${this.menu === "insert"}
              ?disabled=${this.raw}
              @click=${() => {
                this.picker = false;
                this.menu = this.menu === "insert" ? null : "insert";
              }}
            >
              ${icon("add", 20)}
            </button>
            <button
              class="icon-button"
              type="button"
              aria-label=${this.text("undo")}
              title=${this.text("undo")}
              ?disabled=${this.raw || !this.editor?.can().undo()}
              @click=${() => this.format("undo")}
            >
              ${icon("undo", 20)}
            </button>
            <button
              class="icon-button"
              type="button"
              aria-label=${this.text("redo")}
              title=${this.text("redo")}
              ?disabled=${this.raw || !this.editor?.can().redo()}
              @click=${() => this.format("redo")}
            >
              ${icon("redo", 20)}
            </button>
          </div>
          <button
            class="icon-button community-format-more"
            type="button"
            aria-label=${this.text("moreFormatting")}
            title=${this.text("moreFormatting")}
            aria-expanded=${this.menu === "format"}
            @click=${() => {
              this.picker = false;
              this.menu = this.menu === "format" ? null : "format";
            }}
          >
            ${icon("text_format", 20)}
          </button>
          <button
            class="icon-button community-source-toggle"
            type="button"
            aria-label=${this.raw ? this.text("visualEditor") : "BBCode"}
            title=${this.raw ? this.text("visualEditor") : "BBCode"}
            aria-pressed=${this.raw}
            @click=${this.toggleSource}
          >
            ${this.raw ? icon("notes", 20) : icon("code", 20)}
          </button>
        </div>
        ${
          this.menu
            ? html`
                <section
                  class="community-format-panel"
                  @pointerdown=${this.preserveSelection}
                  aria-label=${this.text(this.menu === "format" ? "moreFormatting" : "insert")}
                >
                  ${(this.menu === "format" ? format : inserts).map(
                    ({ command, icon: glyph, label }) => html`
                      <button
                        type="button"
                        aria-pressed=${this.active(command)}
                        ?disabled=${this.raw}
                        @click=${() => this.format(command)}
                      >
                        ${icon(glyph, 20)}
                        <span>${this.text(label)}</span>
                      </button>
                    `,
                  )}
                </section>
              `
            : nothing
        }
        ${
          this.allowStickers !== false && this.picker
            ? html`
                <section
                  class="community-stamp-picker"
                  aria-label=${this.text("stickers")}
                  @pointerdown=${this.preserveSelection}
                >
                  ${
                    this.loading
                      ? html`
                          ${loadingIndicator({ label: this.text("loading") })}
                        `
                      : nothing
                  }
                  ${
                    this.error
                      ? html`
                          <p role="alert">${this.error}</p>
                          <button
                            class="button button--text"
                            type="button"
                            @click=${() => {
                              this.picker = false;
                              void this.openStamps();
                            }}
                          >
                            ${this.text("retry")}
                          </button>
                        `
                      : nothing
                  }
                  ${this.stamps.map(
                    (stamp) => html`
                      <button
                        type="button"
                        title=${localizedText(stamp.name, this.locale)}
                        aria-label=${localizedText(stamp.name, this.locale)}
                        @click=${() => this.insertStamp(stamp)}
                      >
                        <community-sticker
                          token=${this.stampToken(stamp)}
                          locale=${this.locale}
                          label=${localizedText(stamp.name, this.locale)}
                        ></community-sticker>
                      </button>
                    `,
                  )}
                </section>
              `
            : nothing
        }
        <div class="community-rich-editor__document" ?hidden=${this.raw}></div>
        ${
          this.raw
            ? html`
                <textarea
                  class="community-source-editor"
                  aria-label="BBCode"
                  .value=${this.value}
                  @input=${(event: Event) => this.change((event.target as HTMLTextAreaElement).value)}
                ></textarea>
              `
            : nothing
        }
        ${
          this.error && !this.picker
            ? html`
                <p class="community-editor-error" role="alert">${this.error}</p>
              `
            : nothing
        }
        <div class="community-editor-count" aria-live="off" data-over-limit=${this.value.length > this.maxLength}>
          ${new Intl.NumberFormat(this.locale).format(this.value.length)} /
          ${new Intl.NumberFormat(this.locale).format(this.maxLength)}
        </div>
        <dialog class="community-link-dialog" aria-label=${this.text("link")}>
          <form
            method="dialog"
            @submit=${(event: SubmitEvent) => {
              event.stopPropagation();
              const data = new FormData(event.currentTarget as HTMLFormElement);
              if ((event.submitter as HTMLButtonElement)?.value === "cancel") return;
              const href = safeCommunityLink(String(data.get("url") || ""));
              if (!href) {
                event.preventDefault();
                return;
              }
              this.editor?.chain().focus().extendMarkRange("link").setLink({ href }).run();
            }}
          >
            <label>
              ${this.text("link")}
              <input
                name="url"
                type="url"
                placeholder="https://"
                required
                .value=${String(this.editor?.getAttributes("link").href || "")}
              />
            </label>
            <div class="dialog-actions">
              <button class="button button--text" value="cancel" formnovalidate>${this.text("cancel")}</button>
              <button class="button" type="submit">${this.text("save")}</button>
            </div>
          </form>
        </dialog>
      </div>
    `;
  }
}
if (!customElements.get("community-editor")) customElements.define("community-editor", CommunityEditor);
