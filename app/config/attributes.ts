const attributeMeta: Record<string, { label: string; color: string; order: number }> = {
  red: { label: "Red", color: "var(--md-extended-color-attribute-red)", order: 1 },
  blue: { label: "Blue", color: "var(--md-extended-color-attribute-blue)", order: 2 },
  green: { label: "Green", color: "var(--md-extended-color-attribute-green)", order: 3 },
  yellow: { label: "Yellow", color: "var(--md-extended-color-attribute-yellow)", order: 4 },
  purple: { label: "Purple", color: "var(--md-extended-color-attribute-purple)", order: 5 },
};

export const attributeOptionsFrom = <T>(
  items: T[],
  attributeOf: (item: T) => string | undefined,
  labelOf?: (item: T) => string,
) =>
  [...new Set(items.map(attributeOf).filter((value): value is string => Boolean(value)))]
    .sort((left, right) => (attributeMeta[left]?.order ?? 99) - (attributeMeta[right]?.order ?? 99))
    .map((value) => {
      const matching = items.filter((item) => attributeOf(item) === value);
      return {
        value,
        label: (matching[0] && labelOf?.(matching[0])) || attributeMeta[value]?.label || value,
        color: attributeMeta[value]?.color || "var(--md-sys-color-outline)",
        count: matching.length,
      };
    });
