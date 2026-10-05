/** Read independent candidates concurrently, retaining their original ranking. */
export async function orderedEligible<T>(
  candidates: readonly T[],
  limit: number,
  eligible: (candidate: T) => Promise<boolean>,
  concurrency = 4,
): Promise<T[]> {
  const accepted: T[] = [];
  const width = Math.max(1, Math.min(4, Math.floor(concurrency)));
  for (let offset = 0; offset < candidates.length && accepted.length < limit; offset += width) {
    const batch = candidates.slice(offset, offset + width);
    const allowed = await Promise.all(batch.map(eligible));
    for (let index = 0; index < batch.length && accepted.length < limit; index++) {
      if (allowed[index]) accepted.push(batch[index]!);
    }
  }
  return accepted;
}
