import { navigate } from "astro:transitions/client";
import type { TransitionBeforePreparationEvent, TransitionBeforeSwapEvent } from "astro:transitions/client";
import {
  DEFAULT_VISIBILITY_RULE,
  VISIBILITY_TYPES,
  parseVisibilityPolicy,
  type ContentVisibilityPolicy,
  type VisibilityType,
} from "./content-visibility-policy";
import { isUserGroup, type UserGroup } from "./user-roles";
import { spoilerContentEnabled } from "./spoiler-content";
import { spoilerOverrideEnabled } from "./spoiler-cookie";
import { ensureContentVisibility, PUBLIC_STATIC_METADATA_KEY as METADATA_KEY } from "./content-policy-browser";
import { adoptPageData, applyDisplayAttributes, installPageData } from "./page-data";

export const PUBLIC_STATIC_MARKER = "haneoka-public-static";
/** Set on the root of a full document that replaced a public one; holds the canonical path. */
export const PUBLIC_STATIC_VIEW_ATTRIBUTE = "data-public-static-view";
interface Descriptor {
  schema: 1;
  build?: string;
  path: string;
  unreleased: boolean;
  differs: boolean;
  types: VisibilityType[];
  next?: number;
  /** False when only previous/next navigation differs; page data is the same. */
  data?: boolean;
  /** The endpoint can grant an encrypted static copy of the complete page data. */
  private?: true;
  functional?: true;
}
interface GrantScript {
  id: string;
  sha256: string;
  iv: string;
  key: string;
  url: string;
}
interface Grant {
  schema: "haneoka-page-data-grant-v1";
  attributes: Record<string, string>;
  scripts: GrantScript[];
}
interface Metadata {
  group: UserGroup;
  version: number;
  policy?: ContentVisibilityPolicy;
  at: number;
}
interface FullView {
  descriptor: Descriptor;
  local: string;
  etag: string;
  /** Complete document; empty for a view built from granted page data. */
  html: string;
  /** Encrypted payload locations of a granted view. */
  payload?: string;
  until: number;
}
type Reason = "load" | "interaction" | "refresh";

const METADATA_TTL = 6 * 60 * 60 * 1000;
const SWAP = "haneoka:public-static-swap";
const HOLD_LIMIT = 1500;
const HYDRATION_LIMIT = 3000;
const INDEXER =
  /bot\b|crawl|spider|slurp|mediapartners|adsbot|google-inspectiontool|googleother|bingpreview|facebookexternalhit|embedly|yandex|baiduspider|petalbot|bytespider|applebot|duckduckgo/iu;
const CONTROL =
  'input, select, textarea, button, summary, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="combobox"], [role="slider"], [contenteditable]';

/** Full documents by canonical path; reused for back/forward and repeated visits. */
const views = new Map<string, FullView>();
/** Public documents as first served, for turning private content off without the network. */
const publicDocuments = new Map<string, string>();
let pending: Document | undefined;
let swapping = false;
let scroll: [number, number] | undefined;
let controller: AbortController | undefined;
let deferred: AbortController | undefined;
let refreshTimer: number | undefined;
let publicationTimer: number | undefined;
let sessionGeneration = 0;
let evaluatedBody: HTMLElement | undefined;
/** Set once a granted payload cannot be opened; the document endpoint serves from then on. */
let grantFailed = false;
let preparation: { body: HTMLElement; promise: Promise<boolean>; settled: boolean } | undefined;
const grantSupported = (): boolean =>
  typeof DecompressionStream === "function" && Boolean(globalThis.crypto?.subtle) && isSecureContext;

function readDescriptor(): Descriptor | undefined {
  const source = document.head?.querySelector(`meta[name="${PUBLIC_STATIC_MARKER}"]`)?.getAttribute("content");
  if (!source) return;
  try {
    const value = JSON.parse(source) as Descriptor;
    return value?.schema === 1 && typeof value.path === "string" && Array.isArray(value.types) ? value : undefined;
  } catch {
    return;
  }
}
/** The descriptor of the current page, public or replaced by its full document. */
function currentDescriptor(): Descriptor | undefined {
  const path = document.documentElement.getAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE);
  return path ? views.get(path)?.descriptor : readDescriptor();
}
const overrideValue = (): string | null => new URL(location.href).searchParams.get("spoiler");
const overridden = (): boolean => spoilerOverrideEnabled(new URL(location.href));
/** Content withheld at build time has since been published and is public for every reader. */
const published = (descriptor: Descriptor): boolean => descriptor.next !== undefined && descriptor.next <= Date.now();
const localKey = (): string => {
  const metadata = readMetadata();
  const build = currentDescriptor()?.build || "";
  return `${Number(spoilerContentEnabled())}:${Number(overridden())}:${sessionGeneration}:${metadata?.version ?? 0}:${metadata?.group ?? "guest"}:${build}`;
};

function readMetadata(): Metadata | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(METADATA_KEY) || "null") as Metadata | null;
    return value && Date.now() - value.at < METADATA_TTL ? value : undefined;
  } catch {
    return;
  }
}
function storeMetadata(headers: Headers): void {
  const group = headers.get("X-Haneoka-Content-Group");
  const version = Number(headers.get("X-Haneoka-Content-Version"));
  if (!isUserGroup(group) || !Number.isFinite(version)) return;
  let policy: ContentVisibilityPolicy | undefined;
  try {
    const source = headers.get("X-Haneoka-Content-Policy");
    policy = source ? (parseVisibilityPolicy(JSON.parse(decodeURIComponent(source))) ?? undefined) : undefined;
  } catch {}
  try {
    localStorage.setItem(METADATA_KEY, JSON.stringify({ group, version, policy, at: Date.now() } satisfies Metadata));
  } catch {}
}
/** Mirrors the endpoint's decision so a known-public viewer makes no request. */
function permitted(metadata: Metadata, types: readonly VisibilityType[]): boolean {
  if (!metadata.policy) return true;
  const spoilers = spoilerContentEnabled();
  const override = overridden();
  return (types.length ? types : VISIBILITY_TYPES).some((kind) => {
    const rule = metadata.policy!.types[kind] ?? DEFAULT_VISIBILITY_RULE;
    if (override && rule.allowOverride) return true;
    if (spoilers && rule.restrictedDisplay === "unpublished") return true;
    if (!rule.groups.includes(metadata.group)) return false;
    return rule.mode === "visible" || rule.show.length > 0 || spoilers;
  });
}

/** Mirrors the endpoint's grant decision: every omitted type is visible in full. */
function unrestrictedFor(metadata: Metadata, types: readonly VisibilityType[]): boolean {
  if (!metadata.policy) return true;
  const spoilers = spoilerContentEnabled();
  const override = overridden();
  return (types.length ? types : VISIBILITY_TYPES).every((kind) => {
    const rule = metadata.policy!.types[kind] ?? DEFAULT_VISIBILITY_RULE;
    const overridable = override && rule.allowOverride;
    const pending = overridable || (rule.groups.includes(metadata.group) && (rule.mode === "visible" || spoilers));
    return pending && (!rule.hide.length || overridable);
  });
}
const wantsGrant = (descriptor: Descriptor): boolean =>
  Boolean(descriptor.private) && !grantFailed && grantSupported();

function endpoint(descriptor: Descriptor, grant = false): string {
  const query = new URLSearchParams({ path: descriptor.path });
  if (grant) query.set("projection", "data");
  if (descriptor.build) query.set("build", descriptor.build);
  const metadata = readMetadata();
  if (metadata) query.set("cv", `view-v1-${metadata.version}-${metadata.group}-${Number(spoilerContentEnabled())}-${Number(overridden())}`);
  const override = overrideValue();
  if (override !== null) query.set("spoiler", overridden() ? "1" : "0");
  if (descriptor.types.length) query.set("types", descriptor.types.join(","));
  if (published(descriptor)) query.set("since", String(descriptor.next));
  return `/api/v1/content-view?${query}`;
}

const maxAge = (response: Response): number =>
  Number(/max-age=(\d+)/u.exec(response.headers.get("Cache-Control") || "")?.[1] ?? 0) * 1000;
const isGrant = (response: Response): boolean =>
  response.headers.get("Content-Type")?.startsWith("application/json") === true;
const payloadOf = (grant: Grant): string => grant.scripts.map((script) => script.url).join(",");
function remember(view: FullView): void {
  views.delete(view.descriptor.path);
  views.set(view.descriptor.path, view);
  if (views.size > 4) views.delete(views.keys().next().value!);
}

const bytes = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value.replace(/-/gu, "+").replace(/_/gu, "/")), (character) => character.charCodeAt(0));
const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
/** Opened payloads by plaintext digest; the ciphertext itself stays in the HTTP cache. */
const opened = new Map<string, string>();
const OPENED_LIMIT = 24 * 1024 * 1024;
async function openScript(script: GrantScript, signal: AbortSignal): Promise<string> {
  const known = opened.get(script.sha256);
  if (known !== undefined) {
    opened.delete(script.sha256);
    opened.set(script.sha256, known);
    return known;
  }
  const response = await fetch(script.url, { cache: "force-cache", signal });
  if (!response.ok) throw new Error(`Private page data returned ${response.status}`);
  const key = await crypto.subtle.importKey("raw", bytes(script.key), "AES-GCM", false, ["decrypt"]);
  const zipped = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(script.iv) }, key, await response.arrayBuffer());
  const plain = await new Response(new Blob([zipped]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  if (hex(await crypto.subtle.digest("SHA-256", plain)) !== script.sha256) throw new Error("Private page data differs");
  const text = new TextDecoder().decode(plain);
  opened.set(script.sha256, text);
  let total = [...opened.values()].reduce((sum, value) => sum + value.length, 0);
  while (opened.size > 1 && total > OPENED_LIMIT) {
    const oldest = opened.keys().next().value!;
    total -= opened.get(oldest)!.length;
    opened.delete(oldest);
  }
  return text;
}
/** A minimal document holding the granted seeds and root attributes, for in-place adoption. */
async function grantDocument(grant: Grant, signal: AbortSignal): Promise<Document> {
  const texts = await Promise.all(grant.scripts.map((script) => openScript(script, signal)));
  const next = document.implementation.createHTMLDocument("");
  for (const [name, value] of Object.entries(grant.attributes)) next.documentElement.setAttribute(name, value);
  grant.scripts.forEach((script, index) => {
    const seed = next.createElement("script");
    seed.type = "application/json";
    seed.id = script.id;
    seed.textContent = texts[index]!;
    next.body.append(seed);
  });
  return next;
}

function parse(html: string, path?: string): Document | undefined {
  const next = new DOMParser().parseFromString(html, "text/html");
  if (!next.querySelector('[name="astro-view-transitions-enabled"]')) return;
  next.querySelectorAll("noscript").forEach((element) => element.remove());
  if (path) next.documentElement.setAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE, path);
  return next;
}

/*
 * A held interaction. While a document swap is pending, clicks and submits
 * on the page are cancelled and recorded; text, select and range values flow
 * through as usual and are recorded. After the next document has hydrated
 * the values are written back and the actions replayed once; when no swap
 * happens they are replayed on the unchanged document.
 */
interface Identity {
  id: string;
  tag: string;
  signature: string;
  label: string;
  path: number[];
}
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
interface FieldState {
  element: Field;
  identity?: Identity;
  value: string;
  checked: boolean;
  changed: boolean;
}
interface Hold {
  stop: AbortController;
  actions: Array<{ type: "click" | "submit"; element: Element; identity?: Identity }>;
  fields: Map<Element, FieldState>;
  focus?: { element: Element; identity?: Identity; value?: string; start: number | null; end: number | null };
  pointers: Set<number>;
  keys: Set<string>;
  idle: Array<() => void>;
}
let hold: Hold | undefined;
let replaying = false;

const PERSISTENT = "audio-dock, #global-navigation, [data-astro-transition-persist]";
const NAVIGATION = "a[href], [data-nav-toggle], [data-entity-back], [data-entity-navigation]";
const STABLE = /^(?:name|type|role|aria-label|aria-controls|placeholder|for|title|data-[\w-]+)$/u;
const VOLATILE = /^data-.*(?:active|selected|open|state|pressed|checked|expanded|count|loading|current|hidden|ripple)/u;

const isField = (element: unknown): element is Field =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
const toggle = (element: Element): boolean =>
  element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio");
function signature(element: Element): string {
  const attributes = [...element.attributes]
    .filter(({ name }) => (STABLE.test(name) && !VOLATILE.test(name)) || (name === "value" && toggle(element)))
    .map(({ name, value }) => `[${CSS.escape(name)}="${CSS.escape(value)}"]`)
    .sort();
  return CSS.escape(element.localName) + attributes.join("");
}
const label = (element: Element): string =>
  (element.getAttribute("aria-label") || element.textContent || "")
    .replace(/\d+/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
function identify(element: Element): Identity | undefined {
  const path: number[] = [];
  for (let node = element; node !== document.body; ) {
    const parent = node.parentElement;
    if (!parent) return;
    path.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return { id: element.id, tag: element.localName, signature: signature(element), label: label(element), path };
}
/** The same control in the current document; the full and public bodies have the same markup. */
function resolve(element: Element, identity: Identity | undefined): Element | undefined {
  if (element.isConnected) return element;
  if (!identity) return;
  if (identity.id) {
    const match = document.getElementById(identity.id);
    if (match?.localName === identity.tag) return match;
  }
  let node: Element | undefined = document.body;
  for (const index of identity.path) node = node?.children[index];
  if (node && signature(node) === identity.signature && label(node) === identity.label) return node;
  let matches: Element[];
  try {
    matches = [...document.body.querySelectorAll(identity.signature)].filter((match) => !match.closest(PERSISTENT));
  } catch {
    return;
  }
  if (matches.length === 1) return matches[0];
  const labelled = matches.filter((match) => label(match) === identity.label);
  return labelled.length === 1 ? labelled[0] : undefined;
}
const inScope = (target: EventTarget | null): Element | undefined =>
  target instanceof Element && target.isConnected && document.body.contains(target) && !target.closest(PERSISTENT)
    ? target
    : undefined;

function settle(current: Hold): void {
  if (!current.pointers.size && !current.keys.size) for (const resolve of current.idle.splice(0)) resolve();
}
function startHold(): Hold {
  if (hold) return hold;
  const current: Hold = {
    stop: new AbortController(),
    actions: [],
    fields: new Map(),
    pointers: new Set(),
    keys: new Set(),
    idle: [],
  };
  hold = current;
  const options = { capture: true, signal: current.stop.signal };
  addEventListener(
    "click",
    (event) => {
      const element = replaying ? undefined : inScope(event.target);
      if (!element || element.closest(NAVIGATION)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const control = element.closest(CONTROL) ?? element;
      if (current.actions.length < 8) current.actions.push({ type: "click", element: control, identity: identify(control) });
    },
    options,
  );
  addEventListener(
    "submit",
    (event) => {
      const form = replaying ? undefined : inScope(event.target);
      if (!form) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (current.actions.length < 8) current.actions.push({ type: "submit", element: form, identity: identify(form) });
    },
    options,
  );
  const record = (event: Event) => {
    const element = inScope(event.target);
    if (!isField(element)) return;
    const previous = current.fields.get(element);
    current.fields.delete(element);
    current.fields.set(element, {
      element,
      identity: previous?.identity ?? identify(element),
      value: element.value,
      checked: toggle(element) && (element as HTMLInputElement).checked,
      changed: Boolean(previous?.changed) || event.type === "change",
    });
  };
  addEventListener("input", record, options);
  addEventListener("change", record, options);
  window.addEventListener("pointerdown", (event) => current.pointers.add(event.pointerId), options);
  for (const type of ["pointerup", "pointercancel"] as const)
    window.addEventListener(
      type,
      (event) => {
        current.pointers.delete(event.pointerId);
        settle(current);
      },
      options,
    );
  window.addEventListener("keydown", (event) => current.keys.add(event.code || event.key), options);
  window.addEventListener(
    "keyup",
    (event) => {
      current.keys.delete(event.code || event.key);
      settle(current);
    },
    options,
  );
  addEventListener(
    "blur",
    () => {
      current.pointers.clear();
      current.keys.clear();
      settle(current);
    },
    options,
  );
  return current;
}
/** Resolves once no pointer or key is down and the resulting click has been dispatched. */
const idle = (current: Hold): Promise<void> =>
  new Promise((resolve) => {
    const done = () => window.setTimeout(resolve, 0);
    if (!current.pointers.size && !current.keys.size) return done();
    current.idle.push(done);
    window.setTimeout(() => {
      current.pointers.clear();
      current.keys.clear();
      settle(current);
    }, 5000);
  });

function replayActions(current: Hold): void {
  for (const action of current.actions) {
    const element = resolve(action.element, action.identity);
    if (!element) continue;
    if (action.type === "submit" && element instanceof HTMLFormElement) element.requestSubmit();
    else if (element instanceof HTMLElement) element.click();
    else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
  }
}
/** Writes recorded values into the current document; `dispatch` lets hydrated components observe them. */
function restoreFields(current: Hold, dispatch: boolean): void {
  const targets = new Map<Field, FieldState>();
  for (const state of current.fields.values()) {
    const element = resolve(state.element, state.identity);
    if (isField(element)) targets.set(element, state);
  }
  for (const [element, state] of targets) {
    if (element.value !== state.value) element.value = state.value;
    if (toggle(element)) (element as HTMLInputElement).checked = state.checked;
    if (!dispatch) continue;
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (state.changed) element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const focus = current.focus;
  const element = focus && resolve(focus.element, focus.identity);
  if (!(element instanceof HTMLElement)) return;
  if (document.activeElement !== element) element.focus({ preventScroll: true });
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
  try {
    if (element.value === focus!.value && focus!.start !== null) element.setSelectionRange(focus!.start, focus!.end);
    else if (document.activeElement === element && dispatch) element.setSelectionRange(element.value.length, element.value.length);
  } catch {}
}
function release(replay: boolean): void {
  const current = hold;
  if (!current) return;
  hold = undefined;
  current.stop.abort();
  for (const resolve of current.idle.splice(0)) resolve();
  if (!replay) return;
  replaying = true;
  try {
    replayActions(current);
  } catch {
  } finally {
    replaying = false;
  }
}
async function hydrated(): Promise<void> {
  const limit = new Promise((resolve) => window.setTimeout(resolve, HYDRATION_LIMIT));
  const undefinedTags = new Set([...document.body.querySelectorAll(":not(:defined)")].map((element) => element.localName));
  await Promise.race([Promise.allSettled([...undefinedTags].map((tag) => customElements.whenDefined(tag))), limit]);
  const updates = [...document.body.querySelectorAll("*")].flatMap((element) =>
    element.localName.includes("-") && "updateComplete" in element
      ? [(element as unknown as { updateComplete: Promise<unknown> }).updateComplete]
      : [],
  );
  await Promise.race([Promise.allSettled(updates), limit]);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
async function finish(current: Hold): Promise<void> {
  await hydrated();
  if (hold !== current) return;
  replaying = true;
  try {
    restoreFields(current, true);
    replayActions(current);
  } catch {
  } finally {
    replaying = false;
    release(false);
  }
}

/**
 * Page data and display attributes taken over in place when every page-data
 * owner supports it; the live DOM, its state and held actions stay with the reader.
 */
async function adopt(next: Document, path: string | undefined): Promise<boolean> {
  let adopted = false;
  try {
    adopted = await adoptPageData(next);
  } catch {}
  if (!adopted) return false;
  if (path) document.documentElement.setAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE, path);
  else document.documentElement.removeAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE);
  release(true);
  return true;
}

/** Replaces the document through the router once the current gesture has ended. */
async function swap(next: Document | undefined): Promise<void> {
  // Without the router a navigation would reload the page and evaluate again.
  if (!document.querySelector('[name="astro-view-transitions-enabled"]')) return release(true);
  const current = startHold();
  await idle(current);
  if (hold !== current) return;
  for (const [element, state] of current.fields)
    if (element.isConnected) current.fields.set(element, { ...state, value: state.element.value });
  const active = inScope(document.activeElement);
  if (active && active !== document.body) {
    const text = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    let start: number | null = null,
      end: number | null = null;
    try {
      if (text) [start, end] = [active.selectionStart, active.selectionEnd];
    } catch {}
    current.focus = { element: active, identity: identify(active), value: text ? active.value : undefined, start, end };
  }
  pending = next;
  swapping = true;
  scroll = [scrollX, scrollY];
  navigate(location.pathname + location.search + location.hash, { history: "replace", info: SWAP }).catch(() => {
    swapping = false;
    release(true);
  });
}
async function retainPublic(path: string): Promise<string | undefined> {
  const known = publicDocuments.get(path);
  if (known) return known;
  let cached: string | undefined;
  try {
    const response = await caches.match(path);
    if (response && !response.headers.has("X-Haneoka-Content-View")) cached = await response.text();
  } catch {}
  const html = cached?.includes(`name="${PUBLIC_STATIC_MARKER}"`) ? cached : await fetch(path, { credentials: "same-origin", cache: "force-cache" })
    .then((response) => (response.ok ? response.text() : undefined))
    .catch(() => undefined);
  if (!html?.includes(`name="${PUBLIC_STATIC_MARKER}"`)) return;
  publicDocuments.set(path, html);
  if (publicDocuments.size > 4) publicDocuments.delete(publicDocuments.keys().next().value!);
  return html;
}
async function downgrade(): Promise<void> {
  const path = document.documentElement.getAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE);
  if (!path) return;
  const html = await retainPublic(path);
  if (document.documentElement.getAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE) !== path) return;
  const next = html ? parse(html) : undefined;
  if (next && (await adopt(next, undefined))) return;
  await swap(next);
}

async function upgrade(descriptor: Descriptor, reason: Reason, documentOnly = false): Promise<void> {
  controller?.abort();
  const current = (controller = new AbortController());
  const local = localKey();
  const shownPath = document.documentElement.getAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE);
  const shown = shownPath === descriptor.path;
  const known = views.get(descriptor.path);
  if (reason !== "refresh" && known?.local === local && known.until > Date.now() && (shown || known.html)) {
    if (shown) return release(true);
    if (!shownPath) await retainPublic(descriptor.path);
    if (current !== controller) return;
    const next = parse(known.html, descriptor.path);
    if (!next) return release(true);
    if (await adopt(next, descriptor.path)) return;
    return swap(next);
  }
  if (reason === "load" && !shownPath) startHold();
  let expired = false;
  const deadline = hold ? window.setTimeout(() => ((expired = true), release(true)), HOLD_LIMIT) : undefined;
  let next: Document | undefined;
  let granted = false;
  let retry = false;
  try {
    const [response] = await Promise.all([
      fetch(endpoint(descriptor, !documentOnly && wantsGrant(descriptor)), {
        credentials: "same-origin",
        cache: reason === "refresh" ? "no-cache" : "default",
        signal: current.signal,
      }),
      shownPath ? undefined : retainPublic(descriptor.path),
    ]);
    if (current !== controller) {
      void response.body?.cancel();
      return;
    }
    storeMetadata(response.headers);
    if (response.status === 204) {
      views.delete(descriptor.path);
      window.clearTimeout(deadline);
      release(true);
      return downgrade();
    }
    const etag = response.headers.get("ETag") || "";
    if (!response.ok || (shown && known && etag && known.etag === etag && known.local === local)) {
      void response.body?.cancel();
      return;
    }
    const until = Date.now() + maxAge(response);
    if (isGrant(response)) {
      const grant = (await response.json()) as Grant;
      if (current !== controller) return;
      const payload = payloadOf(grant);
      // The same payload under refreshed display metadata: the running page keeps its state.
      if (shown && known?.payload === payload) {
        applyDisplayAttributes(Object.entries(grant.attributes));
        remember({ ...known, local: localKey(), etag, until });
        return;
      }
      try {
        next = await grantDocument(grant, current.signal);
      } catch (error) {
        if (current.signal.aborted) throw error;
        grantFailed = retry = true;
      }
      if (next && current !== controller) next = undefined;
      else if (next) {
        granted = true;
        remember({ descriptor, local: localKey(), etag, html: "", payload, until });
      }
    } else {
      const html = await response.text();
      if (current !== controller) return;
      remember({ descriptor, local: localKey(), etag, html, until });
      // After the hold limit only in-place adoption may still apply: a swap would discard released input.
      next = parse(html, descriptor.path);
    }
  } catch {
    // Offline or aborted: the current document stays.
  } finally {
    window.clearTimeout(deadline);
    if (current === controller && !next && !retry) release(true);
  }
  if (retry) return upgrade(descriptor, reason, true);
  if (!next) return;
  if (await adopt(next, descriptor.path)) return;
  if (current !== controller) return;
  if (granted) {
    // Granted data needs in-place adoption; the complete document replaces the page instead.
    views.delete(descriptor.path);
    return upgrade(descriptor, reason, true);
  }
  if (expired) return release(true);
  await swap(next);
}

/**
 * Before page-data owners read their public seed: when the reader likely sees
 * every omitted type, ask for the grant first and install the full data in its
 * place, so the public file is never fetched. False leaves the public path.
 */
export function preparePageData(): Promise<boolean> {
  const body = document.body;
  if (preparation?.body === body) return preparation.promise;
  const descriptor = readDescriptor();
  if (descriptor?.functional) {
    document.documentElement.dataset.contentVisibilityPending = "1";
    if (!INDEXER.test(navigator.userAgent)) void ensureContentVisibility(true);
    preparation = { body, promise: Promise.resolve(false), settled: true };
    return preparation.promise;
  }
  const metadata = readMetadata();
  const eligible =
    descriptor?.unreleased &&
    wantsGrant(descriptor) &&
    !INDEXER.test(navigator.userAgent) &&
    !document.documentElement.hasAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE) &&
    (metadata ? unrestrictedFor(metadata, descriptor.types) : spoilerContentEnabled() || overridden());
  const current = { body, promise: Promise.resolve(false), settled: !eligible };
  if (eligible)
    current.promise = prepare(descriptor, body)
      .catch(() => false)
      .finally(() => (current.settled = true));
  preparation = current;
  return current.promise;
}
async function prepare(descriptor: Descriptor, body: HTMLElement): Promise<boolean> {
  controller?.abort();
  const current = (controller = new AbortController());
  const local = localKey();
  void retainPublic(descriptor.path);
  const response = await fetch(endpoint(descriptor, true), { credentials: "same-origin", signal: current.signal });
  if (current !== controller || document.body !== body) {
    void response.body?.cancel();
    return false;
  }
  storeMetadata(response.headers);
  if (!response.ok || response.status === 204) {
    void response.body?.cancel();
    return false;
  }
  const etag = response.headers.get("ETag") || "";
  const until = Date.now() + maxAge(response);
  if (!isGrant(response)) {
    // A partial view: its complete document is adopted by the regular upgrade.
    remember({ descriptor, local, etag, html: await response.text(), until });
    return false;
  }
  const grant = (await response.json()) as Grant;
  let next: Document;
  try {
    next = await grantDocument(grant, current.signal);
  } catch {
    if (!current.signal.aborted) grantFailed = true;
    return false;
  }
  if (current !== controller || document.body !== body) return false;
  remember({ descriptor, local, etag, html: "", payload: payloadOf(grant), until });
  if (installPageData(next)) {
    document.documentElement.setAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE, descriptor.path);
    return true;
  }
  if (await adopt(next, descriptor.path)) return true;
  views.delete(descriptor.path);
  return false;
}

/** Pages whose page data alone differs upgrade when the reader first uses a control. */
function deferUntilInteraction(descriptor: Descriptor): void {
  deferred?.abort();
  const signal = (deferred = new AbortController()).signal;
  const handle = (event: Event) => {
    if (hold || replaying || (event instanceof PointerEvent && event.button !== 0)) return;
    const target = inScope(event.target);
    const control = target?.closest(CONTROL);
    if (!control || control.closest(NAVIGATION)) return;
    deferred?.abort();
    const current = startHold();
    if (event instanceof PointerEvent) current.pointers.add(event.pointerId);
    if (event instanceof KeyboardEvent) current.keys.add(event.code || event.key);
    void upgrade(descriptor, "interaction");
  };
  for (const type of ["pointerdown", "focusin", "keydown"])
    document.addEventListener(type, handle, { capture: true, passive: true, signal });
}

function evaluate(reason: Reason): void {
  schedulePublication();
  // The first decision for a document waits for its preparation; later ones are direct.
  if (reason === "load" && !(preparation?.body === document.body && preparation.settled)) {
    const body = document.body;
    void preparePageData().then((shown) => {
      if (!shown && document.body === body) decide(reason);
    });
    return;
  }
  decide(reason);
}
function decide(reason: Reason): void {
  const descriptor = currentDescriptor();
  if (descriptor?.functional) {
    if (!INDEXER.test(navigator.userAgent)) {
      const update = ensureContentVisibility(reason === "refresh");
      if (reason === "refresh") void update.then(() => {
        document.querySelector<HTMLElement & { requestUpdate(): void }>("team-builder")?.requestUpdate();
      });
    }
    return;
  }
  if (!descriptor?.unreleased || INDEXER.test(navigator.userAgent)) return;
  const fresh = published(descriptor);
  const path = document.documentElement.getAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE);
  const metadata = readMetadata();
  if (!spoilerContentEnabled() && !overridden() && path && views.get(path)?.local !== localKey()) {
    controller?.abort();
    deferred?.abort();
    void downgrade().then(() => evaluate("load"));
    return;
  }
  if (!fresh && !spoilerContentEnabled() && !overridden() && reason !== "refresh" &&
    metadata?.policy && !permitted(metadata, descriptor.types)) {
    controller?.abort();
    deferred?.abort();
    void downgrade();
    return;
  }
  const shown = document.documentElement.hasAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE);
  if (!shown && reason !== "interaction") {
    // The denial cache only saves the first request; focus and visibility always revalidate.
    const metadata = reason === "load" && !fresh ? readMetadata() : undefined;
    if (metadata && !permitted(metadata, descriptor.types)) return;
    if (!descriptor.differs && !fresh) {
      if (
        reason === "load" &&
        descriptor.data !== false &&
        document.querySelector("main#main-content [data-page-data]")
      )
        deferUntilInteraction(descriptor);
      return;
    }
  }
  void upgrade(descriptor, reason);
}

function schedulePublication(): void {
  window.clearTimeout(publicationTimer);
  publicationTimer = undefined;
  const descriptor = currentDescriptor();
  if (!descriptor?.next || published(descriptor) || document.hidden || INDEXER.test(navigator.userAgent)) return;
  publicationTimer = window.setTimeout(() => {
    publicationTimer = undefined;
    if (currentDescriptor()?.path !== descriptor.path || document.hidden) return;
    if (published(descriptor)) refreshPublicStaticView();
    else schedulePublication();
  }, Math.min(2_147_483_647, Math.max(1, descriptor.next - Date.now())));
}

let installed = false;
let lastLocal = "";
/** Installed once; pages without the descriptor are left to the Worker document path. */
export function installPublicStaticView(): void {
  if (installed || typeof document === "undefined" || !document.documentElement) return;
  installed = true;
  lastLocal = localKey();
  document.addEventListener("astro:before-preparation", (event) => {
    const preparation = event as TransitionBeforePreparationEvent;
    if (preparation.formData) return;
    if (preparation.info === SWAP) {
      const next = pending;
      pending = undefined;
      if (next) preparation.loader = async () => void (preparation.newDocument = next);
      return;
    }
    controller?.abort();
    deferred?.abort();
    window.clearTimeout(publicationTimer);
    swapping = false;
    release(false);
    const path = preparation.to.pathname;
    const known = views.get(path);
    if (!known?.html || known.local !== localKey() || known.until <= Date.now()) return;
    const fallback = preparation.loader;
    preparation.loader = async () => {
      const next = parse(known.html, path);
      if (next) preparation.newDocument = next;
      else await fallback();
    };
  });
  document.addEventListener("astro:before-swap", (event) => {
    const swapEvent = event as TransitionBeforeSwapEvent;
    if (swapEvent.info === SWAP) swapEvent.viewTransition.skipTransition();
  });
  document.addEventListener("astro:after-swap", () => {
    if (scroll) scrollTo({ left: scroll[0], top: scroll[1], behavior: "instant" });
    scroll = undefined;
    if (!swapping || !hold) return;
    replaying = true;
    try {
      restoreFields(hold, false);
    } catch {
    } finally {
      replaying = false;
    }
  });
  document.addEventListener("astro:page-load", () => {
    lastLocal = localKey();
    const current = swapping ? hold : undefined;
    swapping = false;
    if (current) void finish(current);
    if (document.body === evaluatedBody || document.documentElement.hasAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE)) return;
    evaluatedBody = document.body;
    evaluate("load");
  });
  addEventListener("haneoka:spoiler-content", () => {
    const local = localKey();
    if (local === lastLocal) return;
    lastLocal = local;
    evaluate(document.documentElement.hasAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE) ? "interaction" : "load");
  });
  evaluatedBody = document.body;
  document.addEventListener("visibilitychange", schedulePublication);
  evaluate("load");
}

/** Focus and visibility events coalesce into one revalidation. */
export function refreshPublicStaticView(): void {
  if (refreshTimer !== undefined) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    if (hold) hold.idle.push(() => refreshPublicStaticView());
    else evaluate("refresh");
  }, 100);
}

export function resetPublicStaticView(): void {
  sessionGeneration++;
  controller?.abort();
  deferred?.abort();
  const path = document.documentElement.getAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE);
  const current = path ? views.get(path) : undefined;
  views.clear();
  if (path && current) views.set(path, { ...current, local: "", etag: "", until: 0 });
  lastLocal = localKey();
  const shown = document.documentElement.hasAttribute(PUBLIC_STATIC_VIEW_ATTRIBUTE);
  if (shown || readDescriptor()?.differs || readDescriptor()?.functional) evaluate("refresh");
  else evaluate("load");
}
