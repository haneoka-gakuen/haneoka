/**
 * An overlay that covers the page (a detail pane, an episode, a chart) takes
 * over the shell's app bar while it is open: Back in the leading slot, its
 * title in the heading, its marks after the title and its actions in the
 * trailing row. The page's own bar groups are hidden, not removed, and come
 * back unchanged when the overlay closes. Nothing is drawn inside the page.
 */
import { html, nothing, type TemplateResult } from "lit";
import { AsyncDirective, directive, type ElementPart, type PartInfo, PartType } from "lit/async-directive.js";
import { appBarElement, clearAppBarActions, clearAppBarIdentity, setAppBarActions, setAppBarIdentity } from "./app-bar";

export interface AppBarTakeover {
  title: string;
  titleLanguage?: string;
  backLabel: string;
  backHref?: string;
  onBack: () => void;
  /** Marks after the title: rarity, chapter, difficulty. */
  identity?: TemplateResult | typeof nothing;
  actions?: TemplateResult | typeof nothing;
}

let generation = 0;

interface MovedMenu {
  node: HTMLElement;
  home: HTMLElement;
  group: HTMLElement;
}

class TakeoverDirective extends AsyncDirective {
  private readonly owner = `takeover-${++generation}`;
  private source?: Element;
  private options?: AppBarTakeover;
  private saved?: {
    heading: HTMLElement;
    title: ChildNode[];
    lang: string | null;
    entityTitle: string | undefined;
    back: HTMLAnchorElement;
    menu?: MovedMenu;
    hidden: HTMLElement[];
  };
  private scheduled = false;

  constructor(part: PartInfo) {
    super(part);
    if (part.type !== PartType.ELEMENT) throw new Error("appBarTakeover belongs on an element");
  }
  render(_options: AppBarTakeover | null) {
    return nothing;
  }
  update(part: ElementPart, [options]: [AppBarTakeover | null]) {
    this.source = part.element;
    this.options = options ?? undefined;
    // Owners render their bar groups during the same commit; apply after it.
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (this.isConnected && this.options) this.apply(this.options);
        else this.restore();
      });
    }
    return nothing;
  }
  protected disconnected() {
    this.restore();
  }
  protected reconnected() {
    if (this.options) this.apply(this.options);
  }

  private apply(options: AppBarTakeover) {
    const source = this.source;
    if (!source) return;
    const bar = appBarElement(source);
    const heading = bar?.querySelector<HTMLElement>("h1");
    const leading = bar?.querySelector<HTMLElement>("[data-top-app-bar-leading]");
    const actions = bar?.querySelector<HTMLElement>("[data-top-app-bar-actions]");
    const identity = bar?.querySelector<HTMLElement>("[data-top-app-bar-identity]");
    if (!heading || !leading || !actions) return;
    if (!this.saved) {
      const back = document.createElement("a");
      back.className = "icon-button";
      back.href = location.pathname + location.search;
      back.dataset.entityBack = "";
      back.innerHTML = `<svg class="material-icon" width="24" height="24" aria-hidden="true"><use href="/icons.svg#arrow_back"></use></svg>`;
      back.addEventListener("click", (event) => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        this.options?.onBack();
      });
      // A page already showing Back (an entity page) keeps it; the overlay's Back sits in front.
      const toggle = leading.querySelector<HTMLElement>("[data-nav-toggle]");
      let menu: MovedMenu | undefined;
      if (toggle) {
        const group = document.createElement("div");
        group.className = "top-app-bar__group";
        group.append(toggle);
        actions.prepend(group);
        menu = { node: toggle, home: leading, group };
      }
      leading.prepend(back);
      this.saved = {
        heading,
        title: [...heading.childNodes],
        lang: heading.getAttribute("lang"),
        entityTitle: heading.dataset.entityTitle,
        back,
        ...(menu ? { menu } : {}),
        hidden: [],
      };
    }
    const saved = this.saved;
    saved.back.href = options.backHref ?? location.pathname + location.search;
    saved.back.setAttribute("aria-label", options.backLabel);
    for (const back of leading.querySelectorAll<HTMLElement>("[data-entity-back]"))
      if (back !== saved.back && !back.hidden) {
        back.hidden = true;
        saved.hidden.push(back);
      }
    if (heading.textContent !== options.title) heading.textContent = options.title;
    heading.dataset.entityTitle = "true";
    if (options.titleLanguage) heading.lang = options.titleLanguage;
    else heading.removeAttribute("lang");
    setAppBarActions(source, this.owner, options.actions && options.actions !== nothing ? options.actions : html``);
    if (options.identity && options.identity !== nothing) setAppBarIdentity(source, this.owner, options.identity);
    else clearAppBarIdentity(source, this.owner);
    // Everything else in the bar belongs to the page underneath.
    for (const slot of [actions, identity])
      for (const child of slot?.children ?? []) {
        const node = child as HTMLElement;
        if (node.dataset.appBarOwner === this.owner || node === saved.menu?.group || node.hidden) continue;
        node.hidden = true;
        saved.hidden.push(node);
      }
  }

  private restore() {
    const saved = this.saved;
    if (!saved || !this.source) return;
    this.saved = undefined;
    clearAppBarActions(this.source, this.owner);
    clearAppBarIdentity(this.source, this.owner);
    saved.back.remove();
    if (saved.menu) {
      saved.menu.home.append(saved.menu.node);
      saved.menu.group.remove();
    }
    for (const node of saved.hidden) node.hidden = false;
    saved.heading.replaceChildren(...saved.title);
    if (saved.entityTitle === undefined) delete saved.heading.dataset.entityTitle;
    else saved.heading.dataset.entityTitle = saved.entityTitle;
    if (saved.lang) saved.heading.lang = saved.lang;
    else saved.heading.removeAttribute("lang");
  }
}

/** Put on the overlay's root element; pass null while it is closed. */
export const appBarTakeover = directive(TakeoverDirective);
