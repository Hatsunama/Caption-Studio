export function recoverPersistedDuplicateSourceWordIds(
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const transcription = plainRecord(candidate.transcription);
  if (!transcription) return candidate;
  const timelineWords = Array.isArray(transcription.words) ? transcription.words : undefined;
  const sourceResults = plainRecord(transcription.sourceResults);
  if (!timelineWords || !sourceResults || !hasUniqueStringIds(timelineWords)) return candidate;

  let recovered = false;
  const retainedResults = Object.create(null) as Record<string, unknown>;
  for (const [sourceId, rawResult] of Object.entries(sourceResults)) {
    const result = plainRecord(rawResult);
    const words = result && Array.isArray(result.words) ? result.words : undefined;
    if (words && hasDuplicateStringIds(words)) {
      recovered = true;
      continue;
    }
    retainedResults[sourceId] = rawResult;
  }
  if (!recovered) return candidate;

  return {
    ...candidate,
    transcription: {
      ...transcription,
      wordTiming: 'timeline',
      sourceResults: retainedResults,
    },
  };
}

function hasUniqueStringIds(words: unknown[]) {
  const ids = new Set<string>();
  for (const rawWord of words) {
    const word = plainRecord(rawWord);
    if (!word || typeof word.id !== 'string' || !word.id) return false;
    if (ids.has(word.id)) return false;
    ids.add(word.id);
  }
  return true;
}

function hasDuplicateStringIds(words: unknown[]) {
  const ids = new Set<string>();
  for (const rawWord of words) {
    const word = plainRecord(rawWord);
    if (!word || typeof word.id !== 'string' || !word.id) return false;
    if (ids.has(word.id)) return true;
    ids.add(word.id);
  }
  return false;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
