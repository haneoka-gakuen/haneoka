export const materialTheme = Object.freeze({
  colorScheme: "light",
  stylesheet: "@haneoka/design-tokens/tokens.css",
  sourceColors: Object.freeze({
    primary: "#31356e",
    secondary: "#79bbc8",
    tertiary: "#c370b7",
    highlight: "#ecd8be",
  }),
} as const);

export type MaterialTheme = typeof materialTheme;
