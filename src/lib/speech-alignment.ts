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
  const duration = word.endMs - word.startMs;
  const midpoint = word.startMs + duration / 2;
  return windows.find((candidate) => {
    const overlap = Math.max(0, Math.min(word.endMs, candidate.endMs) - Math.max(word.startMs, candidate.startMs));
    return midpoint >= candidate.startMs && midpoint <= candidate.endMs
      || overlap >= Math.min(80, duration * 0.3);
  });
}

function sourceSupport(word: WordToken, window: SpeechWindow, sourceDurationMs?: number) {
  const startMs = Math.max(window.startMs, word.startMs);
  const endMs = Math.min(window.endMs, word.endMs);
  if (sourceDurationMs === undefined || !Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) {
    return { startMs, endMs };
  }
  // Only discard valid positive acoustic support entirely beyond [0, D).
  // Malformed words and invalid durations must still reach canonical validation.
  if (Number.isFinite(word.startMs) && Number.isFinite(word.endMs)
    && word.startMs >= 0 && word.endMs > word.startMs
    && typeof word.text === 'string' && !!word.text.trim()
    && Number.isFinite(startMs) && Number.isFinite(endMs)
    && endMs > startMs && startMs >= sourceDurationMs) return null;
  return { startMs, endMs: Math.min(endMs, sourceDurationMs) };
}

// Replay only on rejection, using the same selector/support and existing ordered
// arrays. No per-word provenance allocation or retained trace on success.
function failureOrigin(words: WordToken[], windows: SpeechWindow[], acceptedIndex: number | null, sourceDurationMs?: number) {
  if (acceptedIndex === null) return null;
  let accepted = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const window = selectedWindow(word, windows);
    if (!window) continue;
    const support = sourceSupport(word, window, sourceDurationMs);
    if (!support) continue;
    if (accepted++ === acceptedIndex) {
      return {
        coalescedIndex: index, before: timingDiagnosticInterval(word),
        windowIndex: windows.indexOf(window), window: timingDiagnosticInterval(window),
        after: timingDiagnosticInterval(support),
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
    const support = sourceSupport(word, window, sourceDurationMs);
    if (!support) continue;
    aligned.push({ ...word, ...support });
  }

  return canonicalizeSourceWords(
    aligned.map((word, index) => ({ ...word, id: `word-${index + 1}` })),
    sourceDurationMs ?? windows[windows.length - 1].endMs,
    onFailure ? (failure) => onFailure({
      ...failure,
      currentOrigin: failureOrigin(words, windows, failure.acceptedIndex, sourceDurationMs),
      nextOrigin: failureOrigin(words, windows, failure.acceptedIndex === null ? null : failure.acceptedIndex + 1, sourceDurationMs),
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

