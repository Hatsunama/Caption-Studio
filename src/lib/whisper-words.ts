import {
  captionTextLength,
  captionTextTokenSpans,
  containsCaptionCjk,
} from '@/lib/caption-text-breaks';
import type { WordToken } from '@/types/project';

export type WhisperTimedSegment = {
  text: string;
  t0: number;
  t1: number;
};

const CLOSING_PUNCTUATION = /^[,.;:!?%\u2026\u3001\u3002\uFF01\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF05)\]}\u3009\u300B\u300D\u300F\u3011\u3015\u3017\u3019\u301B\u2019\u201D]+$/u;
const OPENING_PUNCTUATION = /^[([{\u3008\u300A\u300C\u300E\u3010\u3014\u3016\u3018\u301A\u2018\u201C]+$/u;
const NON_SPEECH = /^\s*(?:\[[^\]]+\]|\([^)]*\))\s*$/;

type PendingWord = Omit<WordToken, 'id'>;

export function coalesceWhisperWords(segments: WhisperTimedSegment[]): WordToken[] {
  const words: PendingWord[] = [];
  let pending: PendingWord | undefined;

  const flush = () => {
    if (pending?.text.trim()) words.push(pending);
    pending = undefined;
  };

  for (const segment of segments) {
    const rawText = segment.text.replace(/\u00a0/g, ' ').normalize('NFC');
    if (!rawText.trim() || NON_SPEECH.test(rawText)) continue;

    const pieces = captionTextTokenSpans(rawText);
    const segmentStartMs = Math.max(0, segment.t0 * 10);
    const segmentEndMs = Math.max(segmentStartMs + 10, segment.t1 * 10);
    const durationMs = segmentEndMs - segmentStartMs;
    const totalWeight = pieces.reduce((total, piece) => total + Math.max(1, captionTextLength(piece.text)), 0);
    let consumedWeight = 0;

    pieces.forEach((piece, index) => {
      const weight = Math.max(1, captionTextLength(piece.text));
      const startMs = segmentStartMs + Math.round(durationMs * consumedWeight / totalWeight);
      consumedWeight += weight;
      const endMs = segmentStartMs + Math.round(durationMs * consumedWeight / totalWeight);
      const previousEnd = index > 0 ? pieces[index - 1].end : 0;
      const whitespaceBefore = /\s/u.test(rawText.slice(previousEnd, piece.start));
      const attachesToPrevious = Boolean(pending) && (
        CLOSING_PUNCTUATION.test(piece.text)
        || (!whitespaceBefore && shouldCoalesceAdjacentPieces(pending!.text, piece.text))
      );

      if (attachesToPrevious && pending) {
        pending.text += piece.text;
        pending.endMs = Math.max(pending.endMs, endMs);
        return;
      }

      flush();
      pending = {
        text: piece.text,
        startMs,
        endMs: Math.max(startMs + 10, endMs),
      };
    });
  }

  flush();
  return words.map((word, index) => ({ ...word, id: `word-${index + 1}` }));
}

function shouldCoalesceAdjacentPieces(previous: string, current: string) {
  if (OPENING_PUNCTUATION.test(previous)) return true;
  if (containsCaptionCjk(previous) || containsCaptionCjk(current)) return false;
  return true;
}
