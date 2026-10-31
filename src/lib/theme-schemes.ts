/** Material 3 colour roles for the character and seasonal seeds, generated like the precomputed band schemes
 * (packages design-tokens/scripts/generate-schemes.mjs) and returned as the CSS the boot script caches. */
import {
  DynamicScheme,
  Hct,
  MaterialDynamicColors,
  SchemeFidelity,
  TonalPalette,
  argbFromHex,
  hexFromArgb,
} from "@material/material-color-utilities";
import type { Season } from "./themes";

const TONAL_SPOT = 2;
const ROLES = [
  "primary", "onPrimary", "primaryContainer", "onPrimaryContainer",
  "secondary", "onSecondary", "secondaryContainer", "onSecondaryContainer",
  "tertiary", "onTertiary", "tertiaryContainer", "onTertiaryContainer",
  "error", "onError", "errorContainer", "onErrorContainer",
  "primaryFixed", "primaryFixedDim", "onPrimaryFixed", "onPrimaryFixedVariant",
  "secondaryFixed", "secondaryFixedDim", "onSecondaryFixed", "onSecondaryFixedVariant",
  "tertiaryFixed", "tertiaryFixedDim", "onTertiaryFixed", "onTertiaryFixedVariant",
  "background", "onBackground", "surface", "surfaceDim", "surfaceBright",
  "surfaceContainerLowest", "surfaceContainerLow", "surfaceContainer", "surfaceContainerHigh", "surfaceContainerHighest",
  "onSurface", "surfaceVariant", "onSurfaceVariant", "outline", "outlineVariant",
  "inverseSurface", "inverseOnSurface", "inversePrimary", "surfaceTint", "shadow", "scrim",
] as const;
const kebab = (value: string) => value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const hue = (hex: string) => Hct.fromInt(argbFromHex(hex));

type Colors = Pick<Season, "primary" | "secondary" | "tertiary">;

function seasonScheme(colors: Colors, isDark: boolean) {
  const primary = hue(colors.primary);
  return new DynamicScheme({
    sourceColorArgb: primary.toInt(),
    variant: TONAL_SPOT,
    contrastLevel: 0,
    isDark,
    primaryPalette: TonalPalette.fromHueAndChroma(primary.hue, Math.max(primary.chroma, 48)),
    secondaryPalette: TonalPalette.fromHueAndChroma(hue(colors.secondary).hue, 20),
    tertiaryPalette: TonalPalette.fromHueAndChroma(hue(colors.tertiary).hue, Math.max(hue(colors.tertiary).chroma, 40)),
    neutralPalette: TonalPalette.fromHueAndChroma(primary.hue, 6),
    neutralVariantPalette: TonalPalette.fromHueAndChroma(primary.hue, 10),
  });
}

const block = (scheme: DynamicScheme) =>
  ROLES.map((role) => `--md-sys-color-${kebab(role)}:${hexFromArgb(MaterialDynamicColors[role].getArgb(scheme))};`).join("");

/** CSS for `seed`: a character's colour (fidelity, like the bands) or a season's triad. */
export function seedCss(seed: string, source: string | Colors): string {
  const scheme = (isDark: boolean) =>
    typeof source === "string" ? new SchemeFidelity(hue(source), isDark, 0) : seasonScheme(source, isDark);
  const root = `:root[data-seed="${seed}"]`;
  return `${root}{${block(scheme(false))}}${root}[data-theme="dark"],${root}[data-ui-resolved-theme="dark"]{color-scheme:dark;${block(scheme(true))}}`;
}
