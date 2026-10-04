import type { MemberOption } from "./contracts.ts";

/** Necessary remaining-character condition for ordered member selection.
 * Masks contain only immutable character identity, never power or skill rank.
 * Rejecting a prefix cannot remove any distinct-character legal completion. */
export function createMemberCompletionCheck(members: readonly Pick<MemberOption, "characterId">[]) {
  if (members.length > 2000) throw new RangeError("member-completion-domain");
  // Leave unsupported character metadata to the existing native/domain checks.
  // A feasibility optimization must not replace an unknown identity by zero.
  const known = members.every(member => Number.isSafeInteger(member.characterId) && member.characterId >= 1);
  const characters = new Map<number, number>();
  const bits = members.map(member => {
    if (!characters.has(member.characterId)) characters.set(member.characterId, characters.size);
    return 1n << BigInt(characters.get(member.characterId)!);
  });
  const suffix = new Array<bigint>(members.length + 1).fill(0n);
  for (let index = members.length - 1; index >= 0; index--) suffix[index] = suffix[index + 1]! | bits[index]!;
  return {
    canComplete(start: number, selected: readonly number[], remaining: number): boolean {
      if (!Number.isInteger(start) || start < 0 || start > members.length || !Number.isInteger(remaining) ||
        remaining < 0 || remaining > 5 || selected.some(index => !Number.isInteger(index) || index < 0 || index >= members.length))
        throw new RangeError("member-completion-prefix");
      if (!known) return true;
      let available = suffix[start]!;
      for (const index of selected) available &= ~bits[index]!;
      let count = 0;
      while (available && count < remaining) { available &= available - 1n; count++; }
      return count >= remaining;
    },
  };
}
