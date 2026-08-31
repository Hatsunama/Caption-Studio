import type { WordToken } from '@/types/project';

export type SpeechSegment = { t0: number; t1: number };

export function alignWordsToSpeech(words: WordToken[], speech: SpeechSegment[]): WordToken[] {
  const windows = mergeSpeechWindows(
    speech
      .map((segment) => ({ startMs: Math.max(0, segment.t0 * 10), endMs: Math.max(0, segment.t1 * 10) }))
      .filter((segment) => segment.endMs > segment.startMs),
  );

  if (windows.length === 0) return [];

  const aligned: WordToken[] = [];
  for (const word of words) {
    const duration = Math.max(10, word.endMs - word.startMs);
    const midpoint = word.startMs + duration / 2;
    const window = windows.find((candidate) => {
      const overlap = Math.max(0, Math.min(word.endMs, candidate.endMs) - Math.max(word.startMs, candidate.startMs));
      return midpoint >= candidate.startMs && midpoint <= candidate.endMs
        || overlap >= Math.min(80, duration * 0.3);
    });
    if (!window) continue;

    const previousEnd = aligned.at(-1)?.endMs ?? 0;
    const startMs = Math.max(previousEnd, window.startMs, word.startMs);
    const endMs = Math.max(startMs + 10, Math.min(window.endMs, word.endMs));
    if (endMs > window.endMs + 10) continue;
    aligned.push({ ...word, startMs, endMs });
  }

  return aligned.map((word, index) => ({ ...word, id: `word-${index + 1}` }));
}

export function mergeSpeechWindows(
  windows: { startMs: number; endMs: number }[],
  joinGapMs = 120,
) {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: { startMs: number; endMs: number }[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (previous && window.startMs <= previous.endMs + joinGapMs) {
      previous.endMs = Math.max(previous.endMs, window.endMs);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}
