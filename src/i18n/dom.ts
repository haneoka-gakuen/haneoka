import { isLocale, languageTagFor } from "@haneoka/i18n";
import { initializeI18nClient, readI18nSeed } from "./client";
import { interfaceShareUrl } from "./interface-share";
import { formatDocumentTitle } from "../lib/document-title";
import { snackbar } from "../lib/snackbar";

import {
  INTERFACE_LANGUAGE_EVENT,
  interfaceLanguages,
  loadInterfaceLanguage,
  localizedInterfaceCatalog,
  readInterfaceLanguage,
  type InterfaceLanguageId,
} from "./interface-languages";

let installed = false;

export function installI18nDom(): void {
  if (installed) return;
  installed = true;
  const client = initializeI18nClient();
  let request: AbortController | undefined;
  let preference = readInterfaceLanguage();
  let activeLanguage: typeof preference;
  let languageRequest = 0;
  const refreshWorkspaces = () => {
    for (const node of document.querySelectorAll<HTMLElement & { requestUpdate?: () => void }>("[data-prerendered]"))
      node.requestUpdate?.();
  };
  const syncInterface = async () => {
    const next = client.committed === "en" ? preference : undefined;
    const generation = ++languageRequest;
    if (next === activeLanguage) return;
    if (!next) {
      activeLanguage = undefined;
      client.setInterfaceOverlay();
      refreshWorkspaces();
      return;
    }
    try {
      const messages = await loadInterfaceLanguage(next);
      if (generation !== languageRequest || client.committed !== "en") return;
      activeLanguage = next;
      client.setInterfaceOverlay((base) => localizedInterfaceCatalog(base, next, messages));
      refreshWorkspaces();
    } catch (error) {
      console.error("[i18n]", error);
    }
  };
  window.addEventListener(INTERFACE_LANGUAGE_EVENT, (event) => {
    const value = (event as CustomEvent<InterfaceLanguageId | undefined>).detail;
    preference = interfaceLanguages.find((locale) => locale.value === value);
    void syncInterface();
  });
  const message = (key: string, fallback: string) => {
    const catalog = client.current();
    const resolved = catalog.resolve(key);
    if (resolved.fallbackReason !== "missing") return resolved;
    return { text: fallback, lang: "und" };
  };

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("[data-interface-share]") || !activeLanguage)
      return;
    const share = interfaceShareUrl(new URL(location.href), activeLanguage.value);
    if (!share) return;
    if (navigator.share) {
      void navigator
        .share({ title: document.querySelector("h1")?.textContent?.trim(), url: share.href })
        .catch(() => {});
    } else if (navigator.clipboard) {
      void navigator.clipboard.writeText(share.href).then(
        () => snackbar(client.current().text("community.page.linkCopied", undefined, "Link copied")),
        () => window.prompt(client.current().text("community.page.copyLink", undefined, "Copy link"), share.href),
      );
    } else {
      window.prompt(client.current().text("community.page.copyLink", undefined, "Copy link"), share.href);
    }
  });

  const applyBindings = () => {
    const locale = client.committed;
    document.documentElement.dataset.locale = locale;
    const interfaceLocale = locale === "en" ? activeLanguage : undefined;
    document.documentElement.dataset.interfaceLocale = interfaceLocale?.value ?? locale;
    document.documentElement.lang = interfaceLocale?.tag ?? languageTagFor(locale);
    const share = document.querySelector<HTMLButtonElement>("[data-interface-share]");
    if (share) {
      const robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content ?? "";
      share.hidden = !interfaceLocale || robots.includes("noindex");
      const label = message("community.page.copyLink", "Copy link").text;
      share.setAttribute("aria-label", label);
      share.title = label;
    }
    const title = document.head.querySelector<HTMLTitleElement>("title[data-interface-title-key]");
    if (title) {
      const { interfaceTitleKey, interfaceTitleOriginal } = title.dataset;
      const localized = interfaceLocale && interfaceTitleKey ? message(interfaceTitleKey, "").text : "";
      title.textContent = localized
        ? formatDocumentTitle(localized, message("common.seo.siteTitle", "BanG Dream! Our Notes Database").text)
        : (interfaceTitleOriginal ?? title.textContent);
    }
    for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
      const key = node.dataset.i18n;
      if (key) {
        const resolved = message(key, node.dataset.i18nFallback ?? key);
        node.textContent = resolved.text;
        node.lang = resolved.lang;
      }
    }
    for (const node of document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
      const key = node.dataset.i18nAriaLabel;
      if (key) {
        const resolved = message(key, node.dataset.i18nAriaLabelFallback ?? key);
        node.setAttribute("aria-label", resolved.text);
        node.lang = resolved.lang;
      }
    }
    try {
      localStorage.setItem("haneoka.locale", locale);
    } catch {}
    document.cookie = `haneoka.locale=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  };

  const acceptDocument = (next: Document) => {
    request?.abort();
    request = undefined;
    const seed = readI18nSeed(next);
    if (seed) client.adoptSeed(seed);
  };

  client.subscribe(applyBindings);
  document.addEventListener("astro:before-swap", (event) => {
    const next = (event as Event & { newDocument: Document }).newDocument;
    if (next) acceptDocument(next);
  });
  document.addEventListener("astro:after-swap", () => {
    applyBindings();
    if (activeLanguage && client.committed === "en") refreshWorkspaces();
    void syncInterface();
  });
  void client
    .ready()
    .then(() => {
      applyBindings();
      void syncInterface();
    })
    .catch((error: unknown) => console.error("[i18n]", error));

  (window as Window & { __haneokaApplyLocale?: (locale: string) => Promise<boolean> }).__haneokaApplyLocale = async (
    locale: string,
  ) => {
    if (!isLocale(locale)) return false;
    request?.abort();
    const pending = new AbortController();
    request = pending;
    try {
      return await client.requestLocale(locale, undefined, pending.signal);
    } catch (error) {
      if (!pending.signal.aborted) console.error("[i18n]", error);
      return false;
    } finally {
      if (request === pending) request = undefined;
    }
  };
}
