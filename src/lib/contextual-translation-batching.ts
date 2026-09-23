export function splitBatchesByContext<T extends { id: string }>(
  batches: readonly (readonly T[])[],
  allCaptions: readonly { id: string }[],
): T[][] {
  const positionById = new Map<string, number>();
  allCaptions.forEach((caption, index) => {
    if (positionById.has(caption.id)) {
      throw new Error(`Duplicate caption ID in translation context: ${caption.id}`);
    }
    positionById.set(caption.id, index);
  });

  const result: T[][] = [];
  let lastPosition = -1;
  for (const batch of batches) {
    let run: T[] = [];
    for (const caption of batch) {
      const position = positionById.get(caption.id);
      if (position === undefined || position <= lastPosition) {
        throw new Error(`Translation selection is missing from or out of order with its context: ${caption.id}`);
      }
      if (run.length > 0 && position !== lastPosition + 1) {
        result.push(run);
        run = [];
      }
      run.push(caption);
      lastPosition = position;
    }
    if (run.length > 0) result.push(run);
  }
  return result;
}
