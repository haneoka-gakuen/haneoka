/**
 * Top app bar overflow (Material 3): when a page's actions do not fit beside
 * the title, the trailing ones move into an overflow menu behind a ⋮ button
 * instead of the row scrolling sideways or the title disappearing.
 *
 * Pages render their actions with Lit into the app bar slot, so nodes are
 * never moved: an overflowed control is only hidden (data-app-bar-overflowed),
 * and its menu entry is a proxy that clicks the original. Segmented controls
 * contribute one checkable entry per segment.
 */
import { clientText } from "../i18n/client";

const HIDDEN = "appBarOverflowed";
const MENU_ID = "top-app-bar-overflow-menu";
/** The title keeps its natural width up to this many pixels before actions start to overflow. */
const TITLE_MAX_RESERVED = 160;

const isInteractive = (node: Element) => node.matches("button, a[href], [role='button']");
const labelOf = (node: Element): string =>
  (node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent || "").replace(/\s+/gu, " ").trim();

const compactWindow = typeof matchMedia === "function" ? matchMedia("(max-width: 599px)") : undefined;

/** Candidates in the order they overflow: entity arrows first, then page actions from the end. */
function candidates(actions: HTMLElement): HTMLElement[] {
  const secondary = [...actions.querySelectorAll<HTMLElement>(".top-app-bar__secondary-actions > [data-entity-navigation]")];
  const page = [...actions.querySelectorAll<HTMLElement>(".top-app-bar__group > *")]
    .filter((node) => !node.matches("[data-app-bar-keep], [data-app-bar-search], .top-app-bar__overflow"))
    .reverse();
  return [...secondary, ...page];
}

function overflowButton(actions: HTMLElement): HTMLButtonElement {
  let button = actions.querySelector<HTMLButtonElement>(":scope > .top-app-bar__overflow");
  if (button) return button;
  button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button top-app-bar__overflow";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-controls", MENU_ID);
  button.innerHTML = `<svg class="material-icon" width="24" height="24" aria-hidden="true"><use href="/icons.svg#more_vert"></use></svg>`;
  button.addEventListener("click", () => openMenu(actions, button!));
  actions.append(button);
  return button;
}

function menuEntries(actions: HTMLElement) {
  const hidden = [...actions.querySelectorAll<HTMLElement>(`[data-app-bar-overflowed]`)];
  // Overflow order is reversed page order; show entries in page order.
  hidden.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const entries: { label: string; icon?: Element | null; checked?: boolean; target: HTMLElement }[] = [];
  for (const node of hidden) {
    if (isInteractive(node)) {
      const label = labelOf(node);
      if (label) entries.push({ label, icon: node.querySelector(".material-icon, img"), target: node });
      continue;
    }
    for (const input of node.querySelectorAll<HTMLInputElement>("input[type='radio'], input[type='checkbox']")) {
      const holder = input.closest("label") ?? input;
      const label = labelOf(input) || labelOf(holder);
      if (!label || input.disabled) continue;
      entries.push({ label, icon: holder.querySelector("img, .material-icon"), checked: input.checked, target: input });
    }
    for (const control of node.querySelectorAll<HTMLElement>("button, a[href]")) {
      const label = labelOf(control);
      if (!label || control.matches(":disabled")) continue;
      const pressed = control.getAttribute("aria-pressed") ?? control.getAttribute("aria-checked") ?? control.getAttribute("aria-selected");
      entries.push({
        label,
        icon: control.querySelector(".material-icon, img"),
        checked: pressed === null ? undefined : pressed === "true",
        target: control,
      });
    }
  }
  return entries;
}

function openMenu(actions: HTMLElement, button: HTMLButtonElement) {
  let menu = document.getElementById(MENU_ID) as HTMLElement | null;
  if (!menu) {
    menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.className = "menu top-app-bar__overflow-menu";
    menu.setAttribute("role", "menu");
    menu.popover = "auto";
    document.body.append(menu);
  }
  const entries = menuEntries(actions);
  menu.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "menu-item";
      item.setAttribute("role", entry.checked === undefined ? "menuitem" : "menuitemradio");
      if (entry.checked !== undefined) item.setAttribute("aria-checked", String(entry.checked));
      const leading = entry.icon?.cloneNode(true) as Element | undefined;
      if (leading) item.append(leading);
      else item.append(document.createElement("span"));
      const text = document.createElement("span");
      text.textContent = entry.label;
      item.append(text);
      if (entry.checked) {
        item.insertAdjacentHTML(
          "beforeend",
          `<svg class="material-icon" width="20" height="20" aria-hidden="true"><use href="/icons.svg#check"></use></svg>`,
        );
      }
      item.addEventListener("click", () => {
        menu!.hidePopover();
        entry.target.click();
      });
      return item;
    }),
  );
  const rect = button.getBoundingClientRect();
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  menu.style.right = `${Math.max(8, Math.round(innerWidth - rect.right))}px`;
  menu.style.left = "auto";
  menu.showPopover();
  menu.querySelector<HTMLElement>(".menu-item")?.focus();
}

/** Re-fits the bar: restores every action, then overflows from the lowest priority until the title fits. */
export function fitAppBarActions(bar: HTMLElement, actions: HTMLElement): void {
  const leading = bar.querySelector<HTMLElement>("[data-top-app-bar-leading]");
  const title = bar.querySelector<HTMLElement>("h1");
  const style = getComputedStyle(bar);
  const width = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const gap = parseFloat(style.columnGap) || 0;
  for (const node of actions.querySelectorAll<HTMLElement>("[data-app-bar-overflowed]")) delete node.dataset[HIDDEN];
  const button = actions.querySelector<HTMLElement>(":scope > .top-app-bar__overflow");
  if (button) button.hidden = true;
  // On compact windows a detail page's leading slot is Back, so the
  // navigation menu is an overflow entry rather than a second trailing icon.
  const compactOnly = compactWindow?.matches
    ? [...actions.querySelectorAll<HTMLElement>("[data-app-bar-overflow-compact]")]
    : [];
  for (const node of compactOnly) node.dataset[HIDDEN] = "true";
  const identity = bar.querySelector<HTMLElement>("[data-top-app-bar-identity]");
  // The row fills the bar and packs to its end, so its own box says nothing
  // about how much it holds: measure what it actually lays out.
  const actionsGap = parseFloat(getComputedStyle(actions).columnGap) || 0;
  const actionsWidth = () => {
    const shown = [...actions.children].filter((child) => (child as HTMLElement).getBoundingClientRect().width > 0);
    return shown.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) + Math.max(0, shown.length - 1) * actionsGap;
  };
  const titleRoom = () =>
    width -
    (leading?.getBoundingClientRect().width || 0) -
    (identity && !identity.hidden ? identity.getBoundingClientRect().width + gap : 0) -
    actionsWidth() -
    gap * 2;
  // scrollWidth is the title's untruncated width, padding included.
  const minimum = title && !title.hidden ? Math.min(title.scrollWidth, TITLE_MAX_RESERVED) : 0;
  if (titleRoom() >= minimum && !compactOnly.length) return;
  const more = overflowButton(actions);
  more.hidden = false;
  more.setAttribute("aria-label", clientText(document.documentElement.dataset.locale || "en", "moreActions", "More"));
  for (const node of candidates(actions)) {
    if (titleRoom() >= minimum) break;
    node.dataset[HIDDEN] = "true";
  }
}
