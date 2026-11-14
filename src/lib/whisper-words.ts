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

// Indices/offsets refer to the native array and NFC/space-normalized token spans.
export type WhisperWordContribution = {
  wordIndex: number; extendsEnd: boolean; attaches: boolean;
  segmentIndex: number; pieceIndex: number; t0: number; t1: number;
  offsetStart: number; offsetEnd: number; weight: number; total: number; used: number;
  startFloor: boolean; segmentFloor: boolean; wordFloor: boolean;
  roundStart: boolean; roundEnd: boolean;
};

export function coalesceWhisperWords(
  segments: WhisperTimedSegment[], observer?: (contribution: WhisperWordContribution) => void,
): WordToken[] {
  const words: PendingWord[] = [];
  let pending: PendingWord | undefined;

  const flush = () => {
    if (pending?.text.trim()) words.push(pending);
    pending = undefined;
  };

  let segmentIndex = -1;
  for (const segment of segments) {
    segmentIndex += 1;
    const rawText = segment.text.replace(/\u00a0/g, ' ').normalize('NFC');
    if (!rawText.trim() || NON_SPEECH.test(rawText)) continue;

    const pieces = captionTextTokenSpans(rawText);
    const segmentStartMs = segment.t0 * 10;
    const segmentEndMs = segment.t1 * 10;
    const durationMs = segmentEndMs - segmentStartMs;
    const timingFailure = () => new Error(`Whisper segment timing quality failure at segment ${segmentIndex}`);
    if (!Number.isFinite(segment.t0) || !Number.isFinite(segment.t1)
      || segment.t0 < 0 || segment.t1 <= segment.t0
      || !Number.isFinite(segmentStartMs) || !Number.isFinite(segmentEndMs)
      || !Number.isFinite(durationMs) || durationMs <= 0) throw timingFailure();
    const totalWeight = pieces.reduce((total, piece) => total + Math.max(1, captionTextLength(piece.text)), 0);
    // Allocate shared boundaries before emitting words or observations. Keep the
    // established rounded offsets only when every piece has real parent support.
    const offsets = [0];
    let usedWeight = 0;
    for (const piece of pieces) {
      usedWeight += Math.max(1, captionTextLength(piece.text));
      const scaled = durationMs * usedWeight;
      offsets.push(Number.isFinite(scaled) ? scaled / totalWeight : durationMs * (usedWeight / totalWeight));
    }
    const supported = (boundaries: number[]) => boundaries.every((boundary, index) =>
      Number.isFinite(boundary) && boundary >= segmentStartMs && boundary <= segmentEndMs
      && (index === 0 || boundary > boundaries[index - 1]));
    let boundaries = offsets.map((offset) => segmentStartMs + Math.round(offset));
    const fractional = !supported(boundaries);
    if (fractional) {
      boundaries = offsets.map((offset, index) => index === 0 ? segmentStartMs
        : index === pieces.length ? segmentEndMs : segmentStartMs + offset);
      if (!supported(boundaries)) throw timingFailure();
    }
    let consumedWeight = 0;

    pieces.forEach((piece, index) => {
      const weight = Math.max(1, captionTextLength(piece.text));
      const startMs = boundaries[index];
      consumedWeight += weight;
      const endMs = boundaries[index + 1];
      const previousEnd = index > 0 ? pieces[index - 1].end : 0;
      const whitespaceBefore = /\s/u.test(rawText.slice(previousEnd, piece.start));
      const attachesToPrevious = Boolean(pending) && (
        CLOSING_PUNCTUATION.test(piece.text)
        || (!whitespaceBefore && shouldCoalesceAdjacentPieces(pending!.text, piece.text))
      );

      if (observer) {
        try {
          // No event objects or provenance arrays on the normal undefined path.
          observer({
            wordIndex: words.length + Number(!attachesToPrevious && !!pending?.text.trim()),
            extendsEnd: !!pending && endMs > pending.endMs,
            attaches: attachesToPrevious, segmentIndex, pieceIndex: index,
            t0: segment.t0, t1: segment.t1, offsetStart: piece.start, offsetEnd: piece.end,
            weight, total: totalWeight, used: consumedWeight - weight,
            startFloor: false, segmentFloor: false, wordFloor: false,
            roundStart: !fractional && !Number.isInteger(offsets[index]),
            roundEnd: !fractional && !Number.isInteger(offsets[index + 1]),
          });
        } catch { /* Observation cannot change coalescing or its exceptions. */ }
      }

      if (attachesToPrevious && pending) {
        pending.text += piece.text;
        pending.endMs = Math.max(pending.endMs, endMs);
        return;
      }

      flush();
      pending = {
        text: piece.text,
        startMs,
        endMs,
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
