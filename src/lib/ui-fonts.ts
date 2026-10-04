import japanese from "@fontsource-variable/noto-sans-jp/wght.css?url";
import traditional from "@fontsource-variable/noto-sans-tc/wght.css?url";
import simplified from "@fontsource-variable/noto-sans-sc/wght.css?url";
import korean from "@fontsource-variable/noto-sans-kr/wght.css?url";

const sheets = { ja: japanese, "zh-TW": traditional, "zh-CN": simplified, ko: korean };
type FontLanguage = keyof typeof sheets;

function fontLanguage(language: string): FontLanguage | undefined {
  const tag = language.toLowerCase();
  if (tag.startsWith("zh")) return /hant|tw|hk|mo/.test(tag) ? "zh-TW" : "zh-CN";
  if (tag.startsWith("ja")) return "ja";
  if (tag.startsWith("ko")) return "ko";
  return undefined;
}

/** Japanese remains available for original game names in every interface locale. */
export function uiFontStyles(language: string) {
  const selected = fontLanguage(language);
  // Keep the English typeface stack's existing CJK fallbacks for user-authored text.
  const keys: FontLanguage[] = language.toLowerCase().startsWith("en")
    ? ["ja", "zh-CN", "ko"]
    : selected && selected !== "ja"
      ? [selected, "ja"]
      : ["ja"];
  return keys.map((key) => ({ key, href: sheets[key] }));
}

type FontWindow = Window & { __haneokaUiFonts?: { version: string; dispose: () => void } };
export function installUiFonts() {
  if (typeof document === "undefined") return;
  const host = window as FontWindow;
  if (host.__haneokaUiFonts?.version === import.meta.url) return;
  host.__haneokaUiFonts?.dispose();
  const ensure = (language: string) => {
    const key = fontLanguage(language);
    if (!key) return;
    const existing = document.head.querySelector<HTMLLinkElement>(`link[data-ui-font="${key}"]`);
    if (existing) {
      if (existing.href !== new URL(sheets[key], document.baseURI).href) existing.href = sheets[key];
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = sheets[key];
    link.dataset.uiFont = key;
    document.head.append(link);
  };
  const visibleLanguage = (element: Element) => {
    if (!element.closest('[hidden], [inert], [aria-hidden="true"], dialog:not([open])'))
      ensure(element.getAttribute("lang") || "");
  };
  const inspect = (element: Element) => {
    if (element.hasAttribute("lang")) visibleLanguage(element);
    element.querySelectorAll("[lang]").forEach(visibleLanguage);
  };
  const refresh = () => {
    for (const font of uiFontStyles(document.documentElement.lang)) ensure(font.key);
    inspect(document.body);
  };
  refresh();
  document.addEventListener("astro:after-swap", refresh);
  window.addEventListener("haneoka:locale-ready", refresh);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") inspect(record.target as Element);
      else for (const node of record.addedNodes) if (node instanceof Element) inspect(node);
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["lang", "hidden", "inert", "aria-hidden", "open"],
  });
  host.__haneokaUiFonts = {
    version: import.meta.url,
    dispose: () => {
      observer.disconnect();
      document.removeEventListener("astro:after-swap", refresh);
      window.removeEventListener("haneoka:locale-ready", refresh);
    },
  };
}
