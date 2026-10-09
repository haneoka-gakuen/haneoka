import { I18N_NAMESPACES, type MainI18nNamespace, COMMON_I18N_NAMESPACE, CATALOG_I18N_NAMESPACE } from "./namespaces";

/** A default client must be seeded or supplied with an explicit content version. */
export const UNSEEDED_I18N_VERSION = "unseeded" as const;

export { I18N_NAMESPACES, COMMON_I18N_NAMESPACE, CATALOG_I18N_NAMESPACE };
export type { MainI18nNamespace };

export const isI18nNamespace = (value: string): value is MainI18nNamespace =>
  I18N_NAMESPACES.some((namespace) => namespace === value);
