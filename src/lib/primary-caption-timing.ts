import type { CaptionBlock, WordToken } from '@/types/project';
import { captionLayoutText } from '@/lib/caption-text-breaks';

const MINIMUM_GENERATED_CUE_MS = 80;

export type CaptionTimingBounds = { startMs: number; endMs: number };

// Null means nonfinite/non-number (or an absent neighbor), never serialized
// content. Keep this allowlist independent of WordToken and Error properties.
export const timingDiagnosticNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function timingDiagnosticInterval(word?: { startMs: number; endMs: number }) {
  return word ? { startMs: timingDiagnosticNumber(word.startMs), endMs: timingDiagnosticNumber(word.endMs) } : null;
}

export type SourceTimingFailure = {
  durationMs: number | null;
  acceptedIndex: number | null;
  acceptedCount: number;
  previous: ReturnType<typeof timingDiagnosticInterval>;
  current: ReturnType<typeof timingDiagnosticInterval>;
  next: ReturnType<typeof timingDiagnosticInterval>;
  cappedEndMs: number | null;
  rejected: {
    invalidDuration: boolean; invalidId: boolean; duplicateId: boolean; invalidText: boolean;
    nonfiniteStart: boolean; nonfiniteEnd: boolean; negativeStart: boolean; startOutsideDuration: boolean;
    nonfiniteNextStart: boolean; decreasingNextStart: boolean; nonpositiveCappedSupport: boolean;
  };
};

function observeSourceTimingFailure(
  observer: ((failure: SourceTimingFailure) => void) | undefined,
  words: WordToken[], durationMs: number, index: number | null, endMs: number, ids?: Set<string>,
) {
  if (!observer) return;
  // Diagnostics must never replace the original error or interfere with cleanup.
  try {
    const word = index === null ? undefined : words[index];
    const next = index === null ? undefined : words[index + 1];
    observer({
      durationMs: timingDiagnosticNumber(durationMs), acceptedIndex: index, acceptedCount: words.length,
      previous: timingDiagnosticInterval(index === null ? undefined : words[index - 1]),
      current: timingDiagnosticInterval(word), next: timingDiagnosticInterval(next),
      cappedEndMs: timingDiagnosticNumber(endMs),
      rejected: {
        invalidDuration: !Number.isFinite(durationMs) || durationMs <= 0,
        invalidId: !!word && (typeof word.id !== 'string' || !word.id),
        duplicateId: !!word && !!ids?.has(word.id),
        invalidText: !!word && (typeof word.text !== 'string' || !word.text.trim()),
        nonfiniteStart: !!word && !Number.isFinite(word.startMs),
        nonfiniteEnd: !!word && !Number.isFinite(word.endMs),
        negativeStart: !!word && word.startMs < 0,
        startOutsideDuration: !!word && word.startMs >= durationMs,
        nonfiniteNextStart: !!next && !Number.isFinite(next.startMs),
        decreasingNextStart: !!word && !!next && next.startMs < word.startMs,
        nonpositiveCappedSupport: !!word && endMs <= word.startMs,
      },
    });
  } catch { /* Failure-only observation is best effort. */ }
}

// Source intervals describe the audio. Resolve overlapping ASR endpoints at
// the next acoustic onset, without applying minimum visual cue durations.
export function canonicalizeSourceWords(
  words: WordToken[], durationMs: number, onFailure?: (failure: SourceTimingFailure) => void,
): WordToken[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    observeSourceTimingFailure(onFailure, words, durationMs, null, NaN);
    throw new Error('Source word timing quality failure: invalid source duration');
  }
  const ids = new Set<string>();
  return words.map((word, index) => {
    const next = words[index + 1];
    const endMs = Math.min(word.endMs, next?.startMs ?? durationMs, durationMs);
    if (typeof word.id !== 'string' || !word.id || ids.has(word.id)
      || typeof word.text !== 'string' || !word.text.trim()
      || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)
      || word.startMs < 0 || word.startMs >= durationMs
      || (next && (!Number.isFinite(next.startMs) || next.startMs < word.startMs))
      || endMs <= word.startMs) {
      observeSourceTimingFailure(onFailure, words, durationMs, index, endMs, ids);
      throw new Error(`Source word timing quality failure for ${word.id}`);
    }
    ids.add(word.id);
    return { ...word, endMs };
  });
}

export function hasCanonicalSourceWords(words: WordToken[]): boolean {
  const ids = new Set<string>();
  return Array.isArray(words) && words.every((word, index) => {
    if (!word || typeof word.id !== 'string' || !word.id || ids.has(word.id)
      || typeof word.text !== 'string' || !word.text.trim()
      || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)
      || word.startMs < 0 || word.endMs <= word.startMs
      || (index > 0 && word.startMs < words[index - 1].endMs)) return false;
    ids.add(word.id);
    return true;
  });
}

export function normalizeProjectedPrimaryWords(
  words: WordToken[], clipId: string, clipStartMs: number, clipEndMs: number,
): WordToken[] {
  const starts: number[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const previous = words[index - 1];
    const minimumStepMs = 1;
    const startMs = Math.max(clipStartMs, word.startMs,
      previous && word.startMs <= starts[index - 1] ? starts[index - 1] + minimumStepMs : -Infinity);
    if (!Number.isFinite(startMs) || startMs >= Math.min(clipEndMs, word.endMs)) {
      throw new Error(`Primary word timing quality failure in clip ${clipId}, word ${word.id}`);
    }
    starts.push(startMs);
  }
  return words.map((word, index) => {
    const startMs = starts[index];
    const endMs = Math.min(clipEndMs, word.endMs, starts[index + 1] ?? clipEndMs);
    if (!Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error(`Primary word timing quality failure in clip ${clipId}, word ${word.id}`);
    }
    return { ...word, startMs, endMs };
  });
}

// Acoustic word timings stay canonical; optional visual padding stays inside
// the owning clip's projected speech window.
export function sequenceGeneratedPrimaryCaptions(
  captions: CaptionBlock[], maxDurationMs: number, fitsTextBudget: (caption: CaptionBlock) => boolean,
  bounds?: CaptionTimingBounds,
): CaptionBlock[] {
  const sequenced: CaptionBlock[] = [];
  for (const caption of captions) {
    if (!Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs)
      || caption.endMs <= caption.startMs || caption.endMs - caption.startMs > maxDurationMs) {
      throw new Error(`Primary caption timing quality failure for ${caption.id}, words ${caption.wordIds.join(',')}: invalid cue interval`);
    }
    if (!fitsTextBudget(caption) && caption.wordIds.length !== 1) {
      throw new Error(`Primary caption timing quality failure for ${caption.id}, words ${caption.wordIds.join(',')}: text budget exceeded`);
    }
    const previous = sequenced.at(-1);
    if (previous && caption.startMs < previous.endMs) {
      throw new Error(`Primary caption timing quality failure for ${caption.id}, words ${caption.wordIds.join(',')}: overlapping word intervals`);
    }
    sequenced.push({ ...caption });
  }

  for (let index = 0; index < sequenced.length; index += 1) {
    const caption = sequenced[index];
    if (caption.endMs - caption.startMs >= MINIMUM_GENERATED_CUE_MS) continue;
    const next = sequenced[index + 1];
    const previous = sequenced[index - 1];
    const nextCandidate = next && next.startMs - caption.endMs <= MINIMUM_GENERATED_CUE_MS
      && next.endMs - caption.startMs <= maxDurationMs
      ? mergeAdjacentCaptions(caption, next) : undefined;
    const previousCandidate = previous && caption.startMs - previous.endMs <= MINIMUM_GENERATED_CUE_MS
      && caption.endMs - previous.startMs <= maxDurationMs
      ? mergeAdjacentCaptions(previous, caption) : undefined;
    const usePrevious = previousCandidate && fitsTextBudget(previousCandidate)
      && (!nextCandidate || !fitsTextBudget(nextCandidate)
        || caption.startMs - previous!.endMs <= next!.startMs - caption.endMs);
    if (!usePrevious && nextCandidate && fitsTextBudget(nextCandidate)) {
      sequenced.splice(index, 2, nextCandidate);
    } else if (previousCandidate && fitsTextBudget(previousCandidate)) {
      sequenced.splice(index - 1, 2, previousCandidate);
      index -= 1;
    } else {
      const neededMs = Math.max(0, Math.min(MINIMUM_GENERATED_CUE_MS, maxDurationMs) - (caption.endMs - caption.startMs));
      const beforeMs = Math.min(neededMs, Math.max(0, caption.startMs - (previous?.endMs ?? bounds?.startMs ?? 0)));
      const afterMs = Math.min(neededMs - beforeMs, Math.max(0, (next?.startMs ?? bounds?.endMs ?? caption.endMs) - caption.endMs));
      sequenced[index] = { ...caption, startMs: caption.startMs - beforeMs, endMs: caption.endMs + afterMs };
      continue;
    }
    index -= 1;
  }
  return sequenced;
}

function mergeAdjacentCaptions(left: CaptionBlock, right: CaptionBlock): CaptionBlock {
  return {
    ...left,
    text: captionLayoutText([left.text, right.text]),
    startMs: Math.min(left.startMs, right.startMs),
    endMs: Math.max(left.endMs, right.endMs),
    wordIds: [...left.wordIds, ...right.wordIds],
  };
}

// A positive interval remains a cue regardless of its visual width. Preserve
// an explicit hidden state; old threshold-hidden data cannot be distinguished
// from a user-hidden cue without additional provenance.
export function primaryCaptionVisible(caption: CaptionBlock, startMs: number, endMs: number): boolean {
  return endMs > startMs && caption.timelineVisible !== false;
}

export function primaryCaptionSurvives(startMs: number, endMs: number): boolean {
  return endMs > startMs;
}
