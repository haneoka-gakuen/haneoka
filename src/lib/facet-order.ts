interface FacetIdentity {
  value: string;
  id?: string | number;
}

const ids = new Intl.Collator("en", { numeric: true, sensitivity: "variant" });
const identity = (option: FacetIdentity): string | undefined => {
  if (typeof option.id === "number" && Number.isFinite(option.id)) return String(option.id);
  if (typeof option.id === "string" && option.id.trim()) return option.id;
  return /^\d+$/.test(option.value) ? option.value : undefined;
};

export function orderFacetOptions<T extends FacetIdentity>(options: readonly T[]): T[] {
  return [...options].sort((a, b) => {
    const left = identity(a),
      right = identity(b);
    if (left === undefined) return right === undefined ? 0 : 1;
    if (right === undefined) return -1;
    return ids.compare(left, right);
  });
}
