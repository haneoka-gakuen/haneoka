import {
  archiveLocales,
  DEFAULT_ARCHIVE_LOCALE,
  isArchiveLocale,
  localeTagFor,
  localizeArchiveValue,
  matchArchiveLocale,
  normalizeArchiveLocale,
  resolveArchiveValue,
  LOCALE_STORAGE_KEY,
  type ArchiveLocale,
  type LocalizedValueInput,
  type ResolveArchiveValueOptions,
} from "~/i18n/locales";
import {
  archiveMessage,
  archiveMessageGroup,
  loadArchiveMessages,
  type ArchiveMessageGroupKey,
  type ArchiveMessageKey,
  type ArchiveMessageParams,
} from "~/i18n/messages";

export {
  archiveLocales,
  DEFAULT_ARCHIVE_LOCALE,
  isArchiveLocale,
  isUsableLocalizedText,
  localeTagFor,
  localizeArchiveValue,
  matchArchiveLocale,
  normalizeArchiveLocale,
  resolveArchiveValue,
  LOCALE_STORAGE_KEY,
  type ArchiveLanguageTag,
  type ArchiveLocale,
  type LocalizedLanguageTag,
  type LocalizedValueInput,
  type ResolvedLocalizedText,
  type ResolveArchiveValueOptions,
} from "~/i18n/locales";
export {
  archiveMessage,
  archiveMessages,
  type ArchiveMessageGroupKey,
  type ArchiveMessageKey,
  type ArchiveMessageParams,
  type ArchiveMessageSchema,
} from "~/i18n/messages";

const detectLocale = (): ArchiveLocale => {
  if (!import.meta.client) return DEFAULT_ARCHIVE_LOCALE;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return (
    languages.map(matchArchiveLocale).find((locale): locale is ArchiveLocale => Boolean(locale)) ||
    DEFAULT_ARCHIVE_LOCALE
  );
};

const readStoredLocale = (): string | null => {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
};

let appliedLocale: ArchiveLocale | null = null;
const loadedLocaleFonts = new Set<ArchiveLocale>();
const localeFontLoaders: Partial<Record<ArchiveLocale, () => Promise<unknown>>> = {
  ja: () => import("~/assets/styles/locale-fonts/ja.css"),
  en: () => import("~/assets/styles/locale-fonts/en.css"),
  "zh-TW": () => import("~/assets/styles/locale-fonts/zh-TW.css"),
  "zh-CN": () => import("~/assets/styles/locale-fonts/zh-CN.css"),
  ko: () => import("~/assets/styles/locale-fonts/ko.css"),
};

const loadLocaleFont = (locale: ArchiveLocale) => {
  if (!import.meta.client || loadedLocaleFonts.has(locale)) return;
  const load = localeFontLoaders[locale];
  if (!load) return;
  loadedLocaleFonts.add(locale);
  void load().catch(() => loadedLocaleFonts.delete(locale));
};

let contentFontObserver: MutationObserver | undefined;
let contentFontObserverPending = false;

const loadFontForElementLanguage = (element: Element) => {
  // The document language is the UI locale and is loaded by
  // applyLocaleToDocument. Descendant lang attributes describe the actual
  // content, which may be different from the UI locale.
  if (element === document.documentElement) return;
  const locale = matchArchiveLocale(element.getAttribute("lang"));
  if (locale) loadLocaleFont(locale);
};

const loadFontsInSubtree = (node: Node) => {
  if (!(node instanceof Element)) return;
  loadFontForElementLanguage(node);
  node.querySelectorAll("[lang]").forEach(loadFontForElementLanguage);
};

const observeContentFonts = () => {
  if (!import.meta.client || contentFontObserver || contentFontObserverPending) return;
  contentFontObserverPending = true;

  const start = () => {
    contentFontObserverPending = false;
    if (contentFontObserver) return;

    document.querySelectorAll("body [lang]").forEach(loadFontForElementLanguage);
    contentFontObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          if (mutation.target instanceof Element) loadFontForElementLanguage(mutation.target);
          continue;
        }
        mutation.addedNodes.forEach(loadFontsInSubtree);
      }
    });
    contentFontObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["lang"],
      childList: true,
      subtree: true,
    });
  };

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
};

const applyLocaleToDocument = (locale: ArchiveLocale) => {
  const languageTag = localeTagFor(locale);
  if (!import.meta.client || (appliedLocale === locale && document.documentElement.lang === languageTag)) return;
  appliedLocale = locale;
  loadLocaleFont(locale);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Locale remains active for the current session.
  }
  // Authentication emails are rendered by the worker, so mirror the UI
  // preference in a same-origin cookie it can read. This is not sensitive
  // state; the localStorage copy remains the browser-side source of truth.
  document.cookie = `${LOCALE_STORAGE_KEY}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax${
    location.protocol === "https:" ? "; Secure" : ""
  }`;
  document.documentElement.lang = languageTag;
};

export const useLocale = () => {
  const locale = useState<ArchiveLocale>("archive-locale", () => DEFAULT_ARCHIVE_LOCALE);
  const ready = useState("archive-locale-ready", () => false);

  useHead(() => ({ htmlAttrs: { lang: localeTagFor(locale.value) } }));

  observeContentFonts();

  if (import.meta.client && !ready.value) {
    locale.value = normalizeArchiveLocale(readStoredLocale(), detectLocale());
    ready.value = true;
  }

  watch(
    locale,
    (value) => {
      applyLocaleToDocument(value);
      void loadArchiveMessages(value).catch(() => {
        // Japanese stays available as the deterministic UI fallback.
      });
    },
    { immediate: true },
  );

  const setLocale = (value: unknown) => {
    if (!isArchiveLocale(value)) return;
    locale.value = value;
    void loadArchiveMessages(value).catch(() => {
      // A later selection retries a failed locale chunk.
    });
  };

  const localize = (value: Parameters<typeof localizeArchiveValue>[0]): string =>
    localizeArchiveValue(value, locale.value);
  const resolveLocalized = (value: LocalizedValueInput, options?: ResolveArchiveValueOptions) =>
    resolveArchiveValue(value, locale.value, options);
  const t = (key: ArchiveMessageKey, params?: ArchiveMessageParams): string =>
    archiveMessage(locale.value, key, params);
  const messages = <Key extends ArchiveMessageGroupKey>(key: Key) =>
    computed(() => archiveMessageGroup(locale.value, key));
  const collator = computed(
    () => new Intl.Collator(localeTagFor(locale.value), { numeric: true, sensitivity: "base" }),
  );

  const formatDate = (value: number | null | undefined): string => {
    if (!value) return "—";
    return new Intl.DateTimeFormat(localeTagFor(locale.value), {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  };

  const compareText = (left: unknown, right: unknown): number =>
    collator.value.compare(String(left || ""), String(right || ""));

  return {
    locale,
    locales: archiveLocales,
    setLocale,
    localize,
    resolveLocalized,
    t,
    messages,
    formatDate,
    compareText,
  };
};
