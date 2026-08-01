import type { InjectionKey } from "vue";
import type { CatalogContentOrigin } from "~/features/catalog/contentSource";

export interface ExternalCharacterRendererContext {
  readonly entry: Readonly<Record<string, unknown>>;
  readonly title: string;
  readonly origin?: Extract<CatalogContentOrigin, { provider: "release" }>;
  readonly signal: AbortSignal;
}

export interface ExternalCharacterRendererHandle {
  dispose(): void | Promise<void>;
}

/**
 * Host-only character renderer boundary.
 *
 * The public application passes catalog metadata and a lifetime signal. A
 * separately supplied host component owns its renderer, SDK, binary, and asset
 * licensing; none of those implementation details are bundled here.
 */
export interface ExternalCharacterRenderer {
  mount(
    host: HTMLElement,
    context: ExternalCharacterRendererContext,
  ):
    | ExternalCharacterRendererHandle
    | (() => void | Promise<void>)
    | Promise<ExternalCharacterRendererHandle | (() => void | Promise<void>)>;
}

export const EXTERNAL_CHARACTER_RENDERER: InjectionKey<ExternalCharacterRenderer> = Symbol(
  "haneoka.external-character-renderer",
);
