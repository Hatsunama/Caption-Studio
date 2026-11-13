import type { WordToken } from '@/types/project';
import {
  canonicalizeSourceWords, timingDiagnosticInterval, type SourceTimingFailure,
} from '@/lib/primary-caption-timing';

export type SpeechSegment = { t0: number; t1: number };

export type AlignedTimingFailure = SourceTimingFailure & {
  currentOrigin: ReturnType<typeof failureOrigin>;
  nextOrigin: ReturnType<typeof failureOrigin>;
};

type SpeechWindow = { startMs: number; endMs: number };

function selectedWindow(word: WordToken, windows: SpeechWindow[]) {
  const duration = Math.max(10, word.endMs - word.startMs);
  const midpoint = word.startMs + duration / 2;
  return windows.find((candidate) => {
    const overlap = Math.max(0, Math.min(word.endMs, candidate.endMs) - Math.max(word.startMs, candidate.startMs));
    return midpoint >= candidate.startMs && midpoint <= candidate.endMs
      || overlap >= Math.min(80, duration * 0.3);
  });
}

// Replay only on rejection, using the same selector and existing ordered
// arrays. No per-word provenance allocation or retained trace on success.
function failureOrigin(words: WordToken[], windows: SpeechWindow[], acceptedIndex: number | null) {
  if (acceptedIndex === null) return null;
  let accepted = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const window = selectedWindow(word, windows);
    if (!window) continue;
    if (accepted++ === acceptedIndex) {
      return {
        coalescedIndex: index, before: timingDiagnosticInterval(word),
        windowIndex: windows.indexOf(window), window: timingDiagnosticInterval(window),
        after: timingDiagnosticInterval({
          startMs: Math.max(window.startMs, word.startMs), endMs: Math.min(window.endMs, word.endMs),
        }),
      };
    }
  }
  return null;
}

export function alignWordsToSpeech(
  words: WordToken[], speech: SpeechSegment[], sourceDurationMs?: number,
  onFailure?: (failure: AlignedTimingFailure) => void,
): WordToken[] {
  const windows = mergeSpeechWindows(
    speech
      .map((segment) => ({ startMs: Math.max(0, segment.t0 * 10), endMs: Math.max(0, segment.t1 * 10) }))
      .filter((segment) => segment.endMs > segment.startMs),
  );

  if (windows.length === 0) return [];

  const aligned: WordToken[] = [];
  for (const word of words) {
    const window = selectedWindow(word, windows);
    if (!window) continue;

    // VAD may clip the left edge, but overlapping endpoints must never move
    // an accepted acoustic onset or fabricate support for a minimum duration.
    const startMs = Math.max(window.startMs, word.startMs);
    const endMs = Math.min(window.endMs, word.endMs);
    aligned.push({ ...word, startMs, endMs });
  }

  return canonicalizeSourceWords(
    aligned.map((word, index) => ({ ...word, id: `word-${index + 1}` })),
    sourceDurationMs ?? windows[windows.length - 1].endMs,
    onFailure ? (failure) => onFailure({
      ...failure,
      currentOrigin: failureOrigin(words, windows, failure.acceptedIndex),
      nextOrigin: failureOrigin(words, windows, failure.acceptedIndex === null ? null : failure.acceptedIndex + 1),
    }) : undefined,
  );
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
