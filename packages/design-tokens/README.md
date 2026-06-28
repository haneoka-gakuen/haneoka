# `@haneoka/design-tokens`

Framework-neutral design decisions for dense browsing and authoring tools.
Import `@haneoka/design-tokens/tokens.css` for CSS custom properties, or the
package root for the canonical theme descriptor and source colors.

Applications consume Material 3 system roles (`--md-sys-*`) directly. Runtime
surfaces expose only their native component contract (`--md-comp-runtime-*`);
there are no legacy aliases or parallel token namespaces.

The favicon is the canonical color source: night indigo is the brand/primary
role, sky cyan is the interactive accent and focus role, blossom pink is a
tertiary highlight, and star ivory is reserved for small decorative emphasis.
Components use semantic accent surface, outline, link, and focus tokens rather
than embedding source-color values or opacity variants.
