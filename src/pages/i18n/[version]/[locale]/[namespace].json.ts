import { staticBuildPaths } from "../../../../server/static-build";
import type { APIRoute, GetStaticPaths } from "astro";
import { I18N_NAMESPACES, isI18nNamespace } from "../../../../i18n/keys";
import { createI18nNamespaceBundle, I18N_CONTENT_VERSION } from "../../../../i18n/server";
import { LOCALES, isLocale } from "../../../../i18n/locales";

export const getStaticPaths: GetStaticPaths = () =>
  staticBuildPaths("src/pages/i18n/[version]/[locale]/[namespace].json.ts", LOCALES.flatMap((locale) =>
    I18N_NAMESPACES.map((namespace) => ({
      params: { version: I18N_CONTENT_VERSION, locale, namespace },
    })),
  ));

export const GET: APIRoute = ({ params }) => {
  const { version, locale, namespace } = params;
  if (version !== I18N_CONTENT_VERSION || !locale || !isLocale(locale) || !namespace || !isI18nNamespace(namespace)) {
    return new Response("Not found", { status: 404 });
  }
  const bundle = createI18nNamespaceBundle(locale, namespace);
  return new Response(JSON.stringify(bundle), {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "application/json; charset=utf-8",
    },
  });
};
