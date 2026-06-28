# @haneoka/i18n

Browser-neutral localization primitives shared by Haneoka applications. The
package owns supported locale metadata, BCP 47 matching, deterministic UI and
content fallback chains, localized-content resolution, and message lookup.

Application-specific message catalogs and framework state stay in the host.
This keeps the package usable in browsers, workers, Node.js, and independent
repositories without Vue or Nuxt.

```ts
import { matchLocale, resolveLocalizedValue, resolveUiMessage } from "@haneoka/i18n";

const locale = matchLocale("zh-Hant-HK") ?? "ja";
const title = resolveLocalizedValue({ ja: "タイトル", "zh-TW": "標題" }, locale);
const label = resolveUiMessage(catalogs, locale, "navigation.home");
```

Run `pnpm run typecheck && pnpm run build` before publishing the package.
