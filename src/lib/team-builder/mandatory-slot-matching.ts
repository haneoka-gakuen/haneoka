/** Whether every required item can occupy a distinct one of at most five slots.
 * Each mask contains only legal remaining slots, including fixed bindings.
 * This is a feasibility test; it makes no assumptions about power or skills.
 */
export function canMatchMandatorySlots(masks: readonly number[], slotCount: number): boolean {
  if (!Number.isInteger(slotCount) || slotCount < 0 || slotCount > 5 ||
    masks.some(mask => !Number.isInteger(mask) || mask < 0 || mask >= 1 << slotCount))
    throw new RangeError("mandatory-slot-domain");
  if (masks.length > slotCount || masks.some(mask => mask === 0)) return false;
  let reachable = 1; // Bit n represents a reachable occupied-slot mask n.
  for (const mask of masks) {
    let next = 0;
    for (let occupied = 0; occupied < 1 << slotCount; occupied++) {
      if (!(reachable & 1 << occupied)) continue;
      let available = mask & ~occupied;
      while (available) {
        const slot = available & -available;
        next |= 1 << (occupied | slot);
        available ^= slot;
      }
    }
    if (!next) return false;
    reachable = next;
  }
  return true;
}
