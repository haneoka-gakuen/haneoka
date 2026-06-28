import { textOf, type DisplayTextInput } from "~/types/displayText";

const graphemes = (value: string): string[] => {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((entry) => entry.segment);
  }
  return Array.from(value);
};

/**
 * Builds a compact, readable name token for identity slots whose image is
 * unavailable. This deliberately keeps a continuous part of the real name
 * instead of combining initials: `Roselia` becomes `ROSE`, `Ave Mujica`
 * becomes a two-line `AVE` / `MUJI`, and CJK names retain up to three
 * meaningful graphemes per line.
 */
export const entityAvatarText = (
  value: DisplayTextInput,
  options: { cjkLength?: number; latinLength?: number } = {},
): string => {
  const words = textOf(value)
    .normalize("NFKC")
    .trim()
    .split(/[\s'’`＊*×&＆/+＋・･._-]+/u)
    .map((word) => (word.match(/[\p{L}\p{N}]/gu) || []).join(""))
    .filter(Boolean);
  if (!words.length) return "?";
  const compactWord = (word: string) => {
    const letters = graphemes(word);
    const first = letters[0] || "?";
    return !/[A-Za-z0-9]/.test(first)
      ? letters.slice(0, options.cjkLength ?? 3).join("")
      : letters
          .slice(0, options.latinLength ?? 4)
          .join("")
          .toLocaleUpperCase();
  };
  return words.slice(0, 2).map(compactWord).join("\n");
};
